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

import { and, asc, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
	dayExercises,
	days,
	exercises,
	prescribedSets,
	sessions,
	sets
} from './db/schema';
import {
	computeConsecutiveBackwards,
	defaultIncrement,
	getLastCompletedSet,
	suggestNextLoad,
	type Database
} from './progression';
import { snapForEquipment } from './plates';

export type StartSessionResult =
	| { ok: true; sessionId: string }
	| { ok: false; status: number; message: string };

export type SessionAccessMode = 'active' | 'ended-active' | 'deleted-only';

export type SessionProjection = {
	id: string;
	programId: string;
	dayId: string;
	dayName?: string;
	endedAt: Date | null;
	deletedAt: Date | null;
	startedAt: Date;
};

/**
 * Creates a new session for the given dayId, OR returns the existing open
 * session for that day if one already exists.
 *
 * Looks up the day server-side to derive `programId` — never trusts a
 * client-supplied programId (per CLAUDE.md "Session-start integrity" rule).
 *
 * Idempotent on (dayId, no-open-session). A second call while a session for
 * the same day is still open returns that session's id rather than creating a
 * phantom duplicate (defends against double-submit / double-tap on the Start
 * button). The DB-level guarantee is the partial unique index
 * `sessions_one_open_per_day`; the pre-check here just avoids wasted prefill
 * work and a unique-violation round-trip in the common case.
 *
 * Snapshots all prescribed sets into the session's `sets` rows (per snapshot
 * semantics rule). Runtime prefill pipeline is: history lookup (with completion
 * filters) → progression suggestion (when history exists) → equipment-aware
 * snap. Cold start with no history uses snapped `initialLoad`.
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

	const existing = await findOpenSessionForDay(db, day.id);
	if (existing) {
		return { ok: true, sessionId: existing };
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
			exercisePosition: dayExercises.position,
			tier: dayExercises.tier,
			progressionPolicy: dayExercises.progressionPolicy,
			equipmentType: exercises.equipmentType,
			exerciseName: exercises.name
		})
		.from(prescribedSets)
		.innerJoin(dayExercises, eq(prescribedSets.dayExerciseId, dayExercises.id))
		.innerJoin(exercises, eq(dayExercises.exerciseId, exercises.id))
		.where(eq(dayExercises.dayId, day.id))
		.orderBy(asc(dayExercises.position), asc(prescribedSets.position));

	// N+1 by design — single-user localhost Postgres, see handoff notes.
	const prefilledLoads = await Promise.all(
		prescribed.map(async (p) => {
			const history = await getLastCompletedSet(db, p.exerciseId, p.setRole, p.setPosition);
			if (!history || history.executedLoad == null) {
				if (p.initialLoad == null) return null;
				return snapForEquipment(p.initialLoad, p.equipmentType).achievable;
			}

			const targetRepsMax = p.targetRepsMax ?? history.prescribedRepsMax ?? p.targetRepsMin ?? 0;
			const targetRir = p.targetRir ?? history.prescribedRir ?? 0;
			const lowerBodyByName = /(deadlift|rdl|squat|leg\s*press|hack\s*squat|lunge|hip\s*thrust|glute|calf|hamstring|quad)/i.test(
				p.exerciseName
			);
			const increment = defaultIncrement(lowerBodyByName);
			const relevantSets = [
				{
					position: p.setPosition,
					load: history.executedLoad,
					reps: history.executedReps ?? targetRepsMax,
					rir: history.executedRir ?? targetRir
				}
			];
			const consecutiveBackwards = await computeConsecutiveBackwards(db, p.exerciseId, p.setRole, p.setPosition);
			const suggested = suggestNextLoad({
				tier: p.tier,
				policy: p.progressionPolicy,
				relevantSets,
				targetRepsMax,
				targetRir,
				increment,
				consecutiveBackwards
			});
			return snapForEquipment(suggested.load, p.equipmentType).achievable;
		})
	);

	try {
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
	} catch (err) {
		// True race: another request's tx committed between our pre-check and
		// our INSERT, so the `sessions_one_open_per_day` partial unique index
		// rejected ours. Re-fetch the winner and return its id so the caller
		// is unblocked. (Postgres SQLSTATE 23505 = unique_violation.)
		if (isUniqueViolation(err)) {
			const winner = await findOpenSessionForDay(db, day.id);
			if (winner) return { ok: true, sessionId: winner };
		}
		throw err;
	}
}

async function findOpenSessionForDay(
	db: Database,
	dayId: string
): Promise<string | null> {
	const [row] = await db
		.select({ id: sessions.id })
		.from(sessions)
		.where(and(eq(sessions.dayId, dayId), isNull(sessions.endedAt), isNull(sessions.deletedAt)))
		.limit(1);
	return row?.id ?? null;
}

function isUniqueViolation(err: unknown): boolean {
	// Drizzle wraps driver errors in `DrizzleQueryError` with the original
	// PostgresError on `.cause`, so we have to unwrap to reach the SQLSTATE.
	if (typeof err !== 'object' || err === null) return false;
	if ((err as { code?: unknown }).code === '23505') return true;
	return isUniqueViolation((err as { cause?: unknown }).cause);
}

export async function loadSession(
	db: Database,
	sessionId: string,
	mode: SessionAccessMode
): Promise<SessionProjection | null> {
	const base = db
		.select({
			id: sessions.id,
			programId: sessions.programId,
			dayId: sessions.dayId,
			endedAt: sessions.endedAt,
			deletedAt: sessions.deletedAt,
			startedAt: sessions.startedAt,
		})
		.from(sessions);

	if (mode === 'active') {
		const [session] = await base.where(and(eq(sessions.id, sessionId), isNull(sessions.deletedAt))).limit(1);
		return session ?? null;
	}

	if (mode === 'ended-active') {
		const [session] = await base
			.where(and(eq(sessions.id, sessionId), isNull(sessions.deletedAt), isNotNull(sessions.endedAt)))
			.limit(1);
		return session ?? null;
	}

	if (mode === 'deleted-only') {
		const [session] = await base
			.where(and(eq(sessions.id, sessionId), isNotNull(sessions.deletedAt)))
			.limit(1);
		return session ?? null;
	}

	// Exhaustive by SessionAccessMode union.
	return null;
}

export async function loadProgramOwnedSession(
	db: Database,
	sessionId: string,
	programId: string,
	mode: SessionAccessMode
): Promise<SessionProjection | null> {
	const projection = {
		id: sessions.id,
		programId: sessions.programId,
		dayId: sessions.dayId,
		endedAt: sessions.endedAt,
		deletedAt: sessions.deletedAt,
		startedAt: sessions.startedAt,
	};

	if (mode === 'active') {
		const [session] = await db
			.select(projection)
			.from(sessions)
			.where(and(eq(sessions.id, sessionId), eq(sessions.programId, programId), isNull(sessions.deletedAt)))
			.limit(1);
		return session ?? null;
	}

	if (mode === 'ended-active') {
		const [session] = await db
			.select(projection)
			.from(sessions)
			.where(
				and(
					eq(sessions.id, sessionId),
					eq(sessions.programId, programId),
					isNull(sessions.deletedAt),
					isNotNull(sessions.endedAt)
				)
			)
			.limit(1);
		return session ?? null;
	}

	if (mode === 'deleted-only') {
		const [session] = await db
			.select(projection)
			.from(sessions)
			.where(and(eq(sessions.id, sessionId), eq(sessions.programId, programId), isNotNull(sessions.deletedAt)))
			.limit(1);
		return session ?? null;
	}

	return null;
}

export async function listDeletedSessionsForProgram(
	db: Database,
	programId: string,
	limit = 100
): Promise<SessionProjection[]> {
	return db
		.select({
			id: sessions.id,
			programId: sessions.programId,
			dayId: sessions.dayId,
			dayName: days.name,
			endedAt: sessions.endedAt,
			deletedAt: sessions.deletedAt,
			startedAt: sessions.startedAt,
		})
		.from(sessions)
		.innerJoin(days, eq(days.id, sessions.dayId))
		.where(and(eq(sessions.programId, programId), isNotNull(sessions.deletedAt)))
		.orderBy(desc(sessions.deletedAt))
		.limit(limit);
}

export async function softDeleteEndedSession(
	db: Database,
	sessionId: string
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
	const session = await loadSession(db, sessionId, 'ended-active');
	if (!session) {
		return { ok: false, status: 404, message: 'Session not found' };
	}

	await db
		.update(sessions)
		.set({ deletedAt: new Date() })
		.where(and(eq(sessions.id, session.id), isNull(sessions.deletedAt), isNotNull(sessions.endedAt)));
	return { ok: true };
}

export async function restoreSoftDeletedSession(
	db: Database,
	sessionId: string
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
	const session = await loadSession(db, sessionId, 'deleted-only');
	if (!session) {
		return { ok: false, status: 404, message: 'Session not found in trash' };
	}

	await db
		.update(sessions)
		.set({ deletedAt: null })
		.where(and(eq(sessions.id, session.id), isNotNull(sessions.deletedAt)));
	return { ok: true };
}

export async function hardDeleteSession(
	db: Database,
	sessionId: string
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
	const session = await loadSession(db, sessionId, 'deleted-only');
	if (!session) {
		return { ok: false, status: 404, message: 'Session not found in trash' };
	}

	await db.transaction(async (tx) => {
		await tx.delete(sessions).where(eq(sessions.id, session.id));
	});
	return { ok: true };
}

export async function purgeDeletedSessionsForProgram(
	db: Database,
	programId: string
): Promise<{ purged: number }> {
	const purged = await db.transaction(async (tx) => {
		const deleted = await tx
			.delete(sessions)
			.where(and(eq(sessions.programId, programId), isNotNull(sessions.deletedAt)))
			.returning({ id: sessions.id });
		return deleted.length;
	});

	return { purged };
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
	const session = await loadSession(db, sessionId, 'active');
	if (!session || session.endedAt) {
		return { updated: false };
	}

	const result = await db
		.update(sessions)
		.set({ endedAt: new Date() })
		.where(and(eq(sessions.id, session.id), isNull(sessions.endedAt), isNull(sessions.deletedAt)))
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
		z.string().max(2000, { message: 'Notes must be 2000 characters or fewer' }).nullable()
	)
});

export type UpdateSetInput = {
	executedLoad: unknown;
	executedReps: unknown;
	executedRir: unknown;
	notes: unknown;
};

export type UpdateSetOptions = {
	allowEndedSession?: boolean;
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
 * Returns 404 if the session does not exist OR if `setId` is not a row of
 * `sessionId` (cross-session hand-crafted POSTs go in this bucket — the
 * UPDATE returns 0 rows and we surface a 404 rather than silently lying
 * about success). Returns 409 if the session has ended (the stale-tab
 * guard preserves history append-only semantics), 400 with fieldErrors on
 * validation failure, otherwise updates the row.
 */
export async function updateSetInSession(
	db: Database,
	sessionId: string,
	setId: string,
	input: UpdateSetInput,
	options?: UpdateSetOptions
): Promise<UpdateSetResult> {
	const session = await loadSession(db, sessionId, 'active');
	if (!session) {
		return { ok: false, setId, status: 404, message: 'Session not found' };
	}
	if (session.endedAt && !options?.allowEndedSession) {
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

	const updated = await db
		.update(sets)
		.set({
			executedLoad: parsed.data.executedLoad,
			executedReps: parsed.data.executedReps,
			executedRir: parsed.data.executedRir,
			notes: parsed.data.notes
		})
		.where(and(eq(sets.id, setId), eq(sets.sessionId, sessionId)))
		.returning({ id: sets.id });

	if (updated.length === 0) {
		// setId does not belong to sessionId (or doesn't exist). Either way
		// it's a 404 — same shape we return for an unknown session, so the
		// caller never sees a silent success on a no-op UPDATE.
		return { ok: false, setId, status: 404, message: 'Set not found in this session' };
	}

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
 * `prescribedSetId` is 1:1 at session-start (every set is created with its
 * prescription). The column is nullable with `onDelete: 'set null'`, so a
 * future flow that deletes prescribed_sets rows referenced by past sets
 * would NULL the FK; the innerJoin here would then drop those sets, the
 * findIndex below would miss `currentSetId`, and the caller would scroll
 * to top instead of advancing. Tighten if/when snapshot immutability is
 * fully enforced at the schema level.
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
