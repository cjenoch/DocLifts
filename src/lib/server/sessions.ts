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

import { asc, eq } from 'drizzle-orm';
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
