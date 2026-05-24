/**
 * Session-level server helpers.
 *
 * Place at: src/lib/server/sessions.ts
 *
 * `startSessionForDay` exists so the session-start integrity rule (CLAUDE.md)
 * can be enforced and tested in one place, instead of inline inside the
 * SvelteKit action. The function takes `(db, dayId)` only — `programId` is
 * derived from the day row, never accepted as a parameter.
 */

import { and, asc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
	dayExercises,
	days,
	prescribedSets,
	sessions,
	sets
} from './db/schema';
import { getLastCompletedSet, type Database } from './progression';

export type StartSessionResult =
	| { ok: true; sessionId: string }
	| { ok: false; status: number; message: string };

/**
 * Creates a new session for the given dayId.
 *
 * Looks up the day server-side to derive `programId` — never trusts a
 * client-supplied programId (per CLAUDE.md "Session-start integrity" rule).
 *
 * Snapshots all prescribed sets into the session's `sets` rows (per snapshot
 * semantics rule). Dumb prefill per row: history.executedLoad ?? initialLoad.
 *
 * Reads are intentionally outside the transaction; the tx only wraps writes so
 * a mid-loop failure can't orphan a session.
 */
export async function startSessionForDay(
	db: Database,
	dayId: string
): Promise<StartSessionResult> {
	const [day] = await db
		.select({ id: days.id, programId: days.programId })
		.from(days)
		.where(eq(days.id, dayId))
		.limit(1);
	if (!day) {
		return { ok: false, status: 404, message: 'Day not found' };
	}

	const prescribed = await db
		.select({
			prescribedSetId: prescribedSets.id,
			setPosition: prescribedSets.position,
			setRole: prescribedSets.setRole,
			targetMetric: prescribedSets.targetMetric,
			targetRepsMin: prescribedSets.targetRepsMin,
			targetRepsMax: prescribedSets.targetRepsMax,
			targetRir: prescribedSets.targetRir,
			initialLoad: prescribedSets.initialLoad,
			exerciseId: dayExercises.exerciseId,
			exercisePosition: dayExercises.position
		})
		.from(prescribedSets)
		.innerJoin(dayExercises, eq(prescribedSets.dayExerciseId, dayExercises.id))
		.where(eq(dayExercises.dayId, day.id))
		.orderBy(asc(dayExercises.position), asc(prescribedSets.position));

	// N+1 by design — single-user localhost Postgres, see handoff notes.
	const prefilledLoads = await Promise.all(
		prescribed.map(async (p) => {
			const history = await getLastCompletedSet(
				db,
				p.exerciseId,
				p.setRole,
				p.setPosition
			);
			return history?.executedLoad ?? p.initialLoad;
		})
	);

	const sessionId = await db.transaction(async (tx) => {
		const [session] = await tx
			.insert(sessions)
			.values({
				dayId: day.id,
				programId: day.programId
			})
			.returning({ id: sessions.id });

		for (let i = 0; i < prescribed.length; i++) {
			const p = prescribed[i];
			await tx.insert(sets).values({
				sessionId: session.id,
				exerciseId: p.exerciseId,
				prescribedSetId: p.prescribedSetId,
				position: p.setPosition,
				setRole: p.setRole,
				targetMetric: p.targetMetric,
				prescribedLoad: prefilledLoads[i],
				prescribedRepsMin: p.targetRepsMin,
				prescribedRepsMax: p.targetRepsMax,
				prescribedRir: p.targetRir
			});
		}

		return session.id;
	});

	return { ok: true, sessionId };
}

/**
 * Stamps `endedAt` on the session if it is currently open. Idempotent:
 * calling on an already-ended or nonexistent session is a no-op.
 *
 * Returns `updated: true` only when a row was actually closed.
 */
export async function endSession(
	db: Database,
	sessionId: string
): Promise<{ updated: boolean }> {
	const result = await db
		.update(sessions)
		.set({ endedAt: new Date() })
		.where(and(eq(sessions.id, sessionId), isNull(sessions.endedAt)))
		.returning({ id: sessions.id });
	return { updated: result.length > 0 };
}

// ---------- updateSetInSession ----------

// Empty / null / undefined → null. Strings parse to number when finite;
// unparseable strings pass through so Zod flags "Expected number" rather
// than silently NaN-ing.
const optionalNumber = (numSchema: z.ZodNumber) =>
	z.preprocess((v) => {
		if (v === null || v === undefined) return null;
		if (typeof v === 'string') {
			const t = v.trim();
			if (t === '') return null;
			const n = Number(t);
			return Number.isFinite(n) ? n : v;
		}
		return v;
	}, numSchema.nullable());

const updateSetSchema = z.object({
	executedLoad: optionalNumber(z.number().nonnegative()),
	executedReps: optionalNumber(z.number().int().nonnegative()),
	executedRir: optionalNumber(z.number().int().min(0).max(10)),
	notes: z.preprocess(
		(v) => {
			if (typeof v !== 'string') return null;
			const t = v.trim();
			return t === '' ? null : t;
		},
		z.string().nullable()
	)
});

export type UpdateSetInput = {
	executedLoad: unknown;
	executedReps: unknown;
	executedRir: unknown;
	notes: unknown;
};

export type UpdateSetResult =
	| { ok: true; setId: string }
	| {
			ok: false;
			setId: string;
			status: number;
			message?: string;
			fieldErrors?: Record<string, string[] | undefined>;
	  };

/**
 * Validate + apply a one-row executed-set update.
 *
 * Returns 404 if the session does not exist, 409 if it has ended (the
 * stale-tab guard preserves history append-only semantics), 400 with
 * fieldErrors on validation failure, otherwise updates the row.
 *
 * The UPDATE is scoped by `(setId, sessionId)` — a hand-crafted POST that
 * names a setId from a different session silently no-ops (current behavior;
 * the helper returns ok because the session itself is valid).
 */
export async function updateSetInSession(
	db: Database,
	sessionId: string,
	setId: string,
	input: UpdateSetInput
): Promise<UpdateSetResult> {
	const [session] = await db
		.select({ endedAt: sessions.endedAt })
		.from(sessions)
		.where(eq(sessions.id, sessionId))
		.limit(1);
	if (!session) {
		return { ok: false, setId, status: 404, message: 'Session not found' };
	}
	if (session.endedAt) {
		return { ok: false, setId, status: 409, message: 'Session has ended' };
	}

	const parsed = updateSetSchema.safeParse(input);
	if (!parsed.success) {
		return {
			ok: false,
			setId,
			status: 400,
			fieldErrors: parsed.error.flatten().fieldErrors
		};
	}

	await db
		.update(sets)
		.set({
			executedLoad: parsed.data.executedLoad,
			executedReps: parsed.data.executedReps,
			executedRir: parsed.data.executedRir,
			notes: parsed.data.notes
		})
		.where(and(eq(sets.id, setId), eq(sets.sessionId, sessionId)));

	return { ok: true, setId };
}

/**
 * Returns the id of the set that follows `currentSetId` in the same session,
 * using the same ordering the session view renders (day-exercise position,
 * then set position within the exercise). Returns null if `currentSetId` is
 * the last set in the session — or if it can't be found in the session at
 * all, which is a defensive case rather than an expected one.
 *
 * Used by the updateSet action to redirect to a fragment anchoring the NEXT
 * row, so saving a set scrolls the user toward what they'll log next instead
 * of resetting to top.
 *
 * Implementation note: the join goes through `prescribed_sets` to reach the
 * owning `day_exercises` row, NOT through `(day_exercises.exerciseId,
 * sessions.dayId)`. The exerciseId join would fan out if a day ever scheduled
 * the same exercise at two different positions — the schema permits it
 * (`day_exercises` is unique on `(dayId, position)` only). Joining via
 * `prescribedSetId` is 1:1 by construction.
 */
export async function nextSetIdInSession(
	db: Database,
	sessionId: string,
	currentSetId: string
): Promise<string | null> {
	const rows = await db
		.select({ id: sets.id })
		.from(sets)
		.innerJoin(prescribedSets, eq(prescribedSets.id, sets.prescribedSetId))
		.innerJoin(
			dayExercises,
			eq(dayExercises.id, prescribedSets.dayExerciseId)
		)
		.where(eq(sets.sessionId, sessionId))
		.orderBy(asc(dayExercises.position), asc(sets.position));

	const idx = rows.findIndex((r) => r.id === currentSetId);
	if (idx < 0 || idx === rows.length - 1) return null;
	return rows[idx + 1].id;
}
