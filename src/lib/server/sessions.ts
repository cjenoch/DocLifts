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

import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
	dayExercises,
	days,
	exercises,
	gymEquipment,
	programs,
	prescribedSets,
	sessions,
	sessionExercises,
	sets
} from './db/schema';
import {
	computeConsecutiveBackwards,
	defaultIncrement,
	FREE_WEIGHT_TYPES,
	historyIdentity,
	type PerformanceIdentity,
	getLastCompletedSet,
	HELD_NO_RULE_REASONING,
	resolveTargets,
	round05,
	suggestNextLoad,
	type Database
} from './progression';
import { snapForEquipment } from './plates';
import { mainPrefills } from './main-prefill';

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
	/** The gym a quick workout is in (0.5.1); null for program sessions. */
	gymId: string | null;
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
 *
 * A day with no prescribed sets (the quick-workout day, 0.5.1) is valid: the
 * session is created empty, and exercises are added to it afterwards.
 */
export async function startSessionForDay(
	db: Database,
	userId: string,
	dayId: string
): Promise<StartSessionResult> {
	// `days` has no user_id; ownership is reached through the program, so the
	// day is resolved by joining to the program it belongs to. Another user's
	// day reads as absent, which is the same 404 an unknown day gets.
	const [day] = await db
		.select({ id: days.id, programId: days.programId })
		.from(days)
		.innerJoin(programs, eq(programs.id, days.programId))
		.where(and(eq(days.id, dayId), eq(programs.userId, userId)))
		.limit(1);
	if (!day) {
		return { ok: false, status: 404, message: 'Day not found' };
	}

	const existing = await findOpenSessionForDay(db, userId, day.id);
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
			dayExerciseId: dayExercises.id,
			exercisePosition: dayExercises.position,
			tier: dayExercises.tier,
			progressionPolicy: dayExercises.progressionPolicy,
			equipmentType: exercises.equipmentType,
			isLowerBody: exercises.isLowerBody,
			exerciseName: exercises.name
		})
		.from(prescribedSets)
		.innerJoin(dayExercises, eq(prescribedSets.dayExerciseId, dayExercises.id))
		.innerJoin(exercises, eq(dayExercises.exerciseId, exercises.id))
		.where(eq(dayExercises.dayId, day.id))
		.orderBy(asc(dayExercises.position), asc(prescribedSets.position));

	// Free weights carry the weight format they were last logged in (0.13.1):
	// the add sheet records one (e.g. per arm), and history matches on it, so a
	// program day that started them as 'legacy' never saw sets logged in a
	// quick workout. Machine exercises are unchanged: no machine is chosen yet.
	const formatOf = new Map<string, (typeof sets.$inferSelect)['loadConvention']>();
	for (const p of prescribed)
		if (FREE_WEIGHT_TYPES.has(p.equipmentType) && !formatOf.has(p.exerciseId))
			formatOf.set(p.exerciseId, await lastFreeWeightFormat(db, userId, p.exerciseId));
	const identityOf = (p: (typeof prescribed)[number]): PerformanceIdentity | undefined =>
		formatOf.has(p.exerciseId)
			? historyIdentity(null, formatOf.get(p.exerciseId)!, p.equipmentType)
			: undefined;

	// N+1 by design — single-user localhost Postgres, see handoff notes.
	const histories = await Promise.all(
		prescribed.map((p) =>
			getLastCompletedSet(
				db,
				userId,
				p.exerciseId,
				p.setRole,
				p.setPosition,
				undefined,
				identityOf(p)
			)
		)
	);

	type Decision =
		| { kind: 'hold'; reasoning: string }
		| { kind: 'advance'; delta: number; reasoning: string }
		| { kind: 'deload'; loadScale: number; reasoning: string };
	type Prefill = { load: number | null; reasoning: string | null };

	const mainDecisions = new Map<string, Awaited<ReturnType<typeof mainPrefills>>>();
	for (const dayExerciseId of new Set(
		prescribed.filter((p) => p.tier === 'main').map((p) => p.dayExerciseId)
	)) {
		const rows = prescribed
			.map((p, i) => ({ p, history: histories[i] }))
			.filter((r) => r.p.dayExerciseId === dayExerciseId);
		const first = rows[0].p;
		mainDecisions.set(
			dayExerciseId,
			await mainPrefills(
				db,
				userId,
				first.exerciseId,
				rows.map(({ p, history }) => ({
					position: p.setPosition,
					setRole: p.setRole,
					targetRepsMax: p.targetRepsMax,
					targetRepsMin: p.targetRepsMin,
					targetRir: p.targetRir,
					history
				})),
				first.progressionPolicy,
				first.isLowerBody,
				identityOf(first)
			)
		);
	}
	// Keyed by dayExerciseId (NOT exerciseId) so two occurrences of the same
	// exercise in one day progress independently — mirrors the MAIN branch above.
	// Keying by exerciseId would merge both occurrences' working sets into one
	// engine call and apply a single decision to both (review finding, 2026-09-26).
	const exerciseDecision = new Map<string, Decision>();

	for (const dayExerciseId of new Set(prescribed.map((p) => p.dayExerciseId))) {
		const rows = prescribed
			.map((p, i) => ({ p, history: histories[i] }))
			.filter((row) => row.p.dayExerciseId === dayExerciseId)
			.filter((row) => row.p.tier !== 'main' && row.p.setRole === 'working');
		if (!rows.length) continue;
		// All-sets-clear rule: if ANY working position lacks executed history,
		// the exercise is not eligible for an engine decision at all. Skipping
		// here drops every position of this exercise to the dumb-prefill path
		// below (which must not call the engine for non-main tiers — see the
		// per-row fallback comment). A single clearing position must not advance
		// the exercise (CLAUDE.md §SECONDARY/ISOLATION).
		if (rows.some((row) => row.history?.executedLoad == null)) continue;

		const sorted = rows.sort((a, b) => a.p.setPosition - b.p.setPosition);
		const first = sorted[0];

		const increment = defaultIncrement(first.p.isLowerBody);
		// M2 (2026-09-28): each working position is judged against its OWN rep
		// range / RIR target — position 1's target no longer applies
		// exercise-wide.
		const relevantSets = sorted.map((row) => {
			const { targetRepsMax, targetRir } = resolveTargets(row.p, row.history);
			return {
				position: row.p.setPosition,
				load: row.history?.executedLoad ?? 0,
				reps: row.history?.executedReps ?? targetRepsMax,
				rir: row.history?.executedRir ?? targetRir,
				targetRepsMax,
				targetRir
			};
		});
		const backwardsPerPosition = await Promise.all(
			sorted.map((row) =>
				computeConsecutiveBackwards(
					db,
					userId,
					first.p.exerciseId,
					'working',
					row.p.setPosition,
					10,
					identityOf(first.p)
				)
			)
		);
		// Exercise-level backwards symmetry: just like all-working-set "clear" requires
		// every position, a backwards streak only counts when every working position is
		// backwards for that session. Minimum across positions is the conservative
		// aggregate that enforces that rule.
		const consecutiveBackwards = Math.min(...backwardsPerPosition);
		const suggested = suggestNextLoad({
			tier: first.p.tier,
			policy: first.p.progressionPolicy,
			relevantSets,
			increment,
			consecutiveBackwards
		});

		const baseline = relevantSets[0].load;
		if (suggested.kind === 'advance') {
			exerciseDecision.set(dayExerciseId, {
				kind: 'advance',
				delta: suggested.load - baseline,
				reasoning: suggested.reasoning
			});
		} else if (suggested.kind === 'deload') {
			exerciseDecision.set(dayExerciseId, {
				kind: 'deload',
				loadScale: baseline === 0 ? 0 : suggested.load / baseline,
				reasoning: suggested.reasoning
			});
		} else {
			exerciseDecision.set(dayExerciseId, { kind: 'hold', reasoning: suggested.reasoning });
		}
	}

	const prefilled = await Promise.all(
		prescribed.map(async (p, i): Promise<Prefill> => {
			const history = histories[i];

			if (p.setRole === 'warmup') {
				const source = history?.executedLoad ?? p.initialLoad;
				if (source == null) return { load: null, reasoning: null };
				return {
					load: snapForEquipment(source, p.equipmentType).achievable,
					reasoning: null
				};
			}

			if (!history || history.executedLoad == null) {
				if (p.initialLoad == null) return { load: null, reasoning: null };
				return {
					load: snapForEquipment(p.initialLoad, p.equipmentType).achievable,
					reasoning: null
				};
			}

			if (p.tier === 'main') {
				const main = mainDecisions.get(p.dayExerciseId)!.get(p.setPosition)!;
				return {
					load: main.load == null ? null : snapForEquipment(main.load, p.equipmentType).achievable,
					reasoning: main.reasoning
				};
			}

			if (p.setRole === 'working') {
				const decision = exerciseDecision.get(p.dayExerciseId);
				if (decision) {
					const baseline = history.executedLoad;
					const raw =
						decision.kind === 'advance'
							? baseline + decision.delta
							: decision.kind === 'deload'
								? round05(baseline * decision.loadScale)
								: baseline;
					return {
						load: snapForEquipment(raw, p.equipmentType).achievable,
						reasoning: decision.reasoning
					};
				}
			}

			// Per-row fallback (no exercise-level decision): dumb prefill only.
			//
			// A non-main tier reaches this point in two cases: a working row on an
			// exercise where some working position lacked history, or a
			// backoff/top row, which non-main tiers never judge. Calling
			// suggestNextLoad per-row here with a single-element relevantSets
			// would let ONE clearing position advance the exercise — violating
			// the all-sets-clear rule (review finding, 2026-09-26). So: no engine
			// call for non-main tiers on this path; hold at last load. The two
			// cases get distinct provenance text because the first is a history
			// gap the user can close and the second is permanent.
			// (Control-flow note: the `if (p.tier === 'main')` branch above has
			// already returned, so only non-main tiers reach here.)
			return {
				load: snapForEquipment(history.executedLoad, p.equipmentType).achievable,
				reasoning:
					p.setRole === 'working'
						? 'held: incomplete history on this exercise'
						: HELD_NO_RULE_REASONING
			};
		})
	);

	try {
		const sessionId = await db.transaction(async (tx) => {
			const [session] = await tx
				.insert(sessions)
				.values({
					userId,
					dayId: day.id,
					programId: day.programId
				})
				.returning({ id: sessions.id });

			const occurrences = new Map<string, string>();
			for (const p of prescribed) {
				if (occurrences.has(p.dayExerciseId)) continue;
				const [occurrence] = await tx
					.insert(sessionExercises)
					.values({
						sessionId: session.id,
						exerciseId: p.exerciseId,
						position: p.exercisePosition,
						exerciseName: p.exerciseName,
						equipmentType: p.equipmentType,
						loadConvention: formatOf.get(p.exerciseId) ?? 'legacy',
						tier: p.tier,
						progressionPolicy: p.progressionPolicy
					})
					.returning();
				occurrences.set(p.dayExerciseId, occurrence.id);
			}
			for (let i = 0; i < prescribed.length; i++) {
				const p = prescribed[i];
				await tx.insert(sets).values({
					userId,
					sessionId: session.id,
					sessionExerciseId: occurrences.get(p.dayExerciseId),
					exerciseId: p.exerciseId,
					loadConvention: formatOf.get(p.exerciseId) ?? 'legacy',
					prescribedSetId: p.prescribedSetId,
					position: p.setPosition,
					setRole: p.setRole,
					targetMetric: p.targetMetric,
					prescribedLoad: prefilled[i].load,
					suggestionReasoning: prefilled[i].reasoning,
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
			const winner = await findOpenSessionForDay(db, userId, day.id);
			if (winner) return { ok: true, sessionId: winner };
		}
		throw err;
	}
}

/**
 * The format a free weight was last logged in: its most recent completed set
 * (the history filters), on no machine. 'legacy' when it was never logged.
 */
async function lastFreeWeightFormat(db: Database, userId: string, exerciseId: string) {
	const [row] = await db
		.select({ format: sets.loadConvention })
		.from(sets)
		.innerJoin(sessions, eq(sets.sessionId, sessions.id))
		.where(
			and(
				eq(sets.userId, userId),
				eq(sets.exerciseId, exerciseId),
				isNull(sets.gymEquipmentId),
				isNotNull(sets.executedLoad),
				isNotNull(sets.executedReps),
				isNotNull(sessions.endedAt),
				isNull(sessions.deletedAt)
			)
		)
		.orderBy(desc(sets.loggedAt))
		.limit(1);
	return row?.format ?? 'legacy';
}

// Exported for the direct cross-tenant test in sessions.test.ts. Callers pass
// the owner explicitly rather than relying on the day having been resolved for
// them, so a caller cannot hand one user's open session to another.
export async function findOpenSessionForDay(
	db: Database,
	userId: string,
	dayId: string
): Promise<string | null> {
	const [row] = await db
		.select({ id: sessions.id })
		.from(sessions)
		.where(
			and(
				eq(sessions.userId, userId),
				eq(sessions.dayId, dayId),
				isNull(sessions.endedAt),
				isNull(sessions.deletedAt)
			)
		)
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
	userId: string,
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
			gymId: sessions.gymId
		})
		.from(sessions);

	if (mode === 'active') {
		const [session] = await base
			.where(
				and(eq(sessions.userId, userId), eq(sessions.id, sessionId), isNull(sessions.deletedAt))
			)
			.limit(1);
		return session ?? null;
	}

	if (mode === 'ended-active') {
		const [session] = await base
			.where(
				and(
					eq(sessions.userId, userId),
					eq(sessions.id, sessionId),
					isNull(sessions.deletedAt),
					isNotNull(sessions.endedAt)
				)
			)
			.limit(1);
		return session ?? null;
	}

	if (mode === 'deleted-only') {
		const [session] = await base
			.where(
				and(eq(sessions.userId, userId), eq(sessions.id, sessionId), isNotNull(sessions.deletedAt))
			)
			.limit(1);
		return session ?? null;
	}

	// Exhaustive by SessionAccessMode union.
	return null;
}

export async function loadProgramOwnedSession(
	db: Database,
	userId: string,
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
		gymId: sessions.gymId
	};

	if (mode === 'active') {
		const [session] = await db
			.select(projection)
			.from(sessions)
			.where(
				and(
					eq(sessions.userId, userId),
					eq(sessions.id, sessionId),
					eq(sessions.programId, programId),
					isNull(sessions.deletedAt)
				)
			)
			.limit(1);
		return session ?? null;
	}

	if (mode === 'ended-active') {
		const [session] = await db
			.select(projection)
			.from(sessions)
			.where(
				and(
					eq(sessions.userId, userId),
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
			.where(
				and(
					eq(sessions.userId, userId),
					eq(sessions.id, sessionId),
					eq(sessions.programId, programId),
					isNotNull(sessions.deletedAt)
				)
			)
			.limit(1);
		return session ?? null;
	}

	return null;
}

export async function listDeletedSessionsForProgram(
	db: Database,
	userId: string,
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
			gymId: sessions.gymId
		})
		.from(sessions)
		.innerJoin(days, eq(days.id, sessions.dayId))
		.where(
			and(
				eq(sessions.userId, userId),
				eq(sessions.programId, programId),
				isNotNull(sessions.deletedAt)
			)
		)
		.orderBy(desc(sessions.deletedAt))
		.limit(limit);
}

export type TrashedSession = {
	id: string;
	startedAt: Date;
	deletedAt: Date | null;
	dayName: string;
	programName: string;
	/** 'quick' for a quick workout (0.5.1); the page labels it from workout-ui.ts. */
	systemKind: string | null;
	/** Sets with a saved load and reps, the count the session page calls "logged". */
	loggedSets: number;
};

/**
 * Every trashed workout of this user, quick or program, for Trash on History
 * (0.5.2). The program page keeps its own per-program list above; this one
 * exists because the quick program has no page, so a trashed quick workout
 * had nowhere to be restored from.
 *
 * Owner-scoped on `sessions.user_id` directly; the joined day and program
 * only supply the label. Restore and permanent delete from this list go
 * through `restoreSoftDeletedSession` and `hardDeleteSession`, the same
 * owner-scoped by-id functions the program page calls.
 */
export async function listDeletedSessionsForUser(
	db: Database,
	userId: string,
	limit = 100
): Promise<{ sessions: TrashedSession[]; total: number }> {
	const [rows, [{ total }]] = await Promise.all([
		db
			.select({
				id: sessions.id,
				startedAt: sessions.startedAt,
				deletedAt: sessions.deletedAt,
				dayName: days.name,
				programName: programs.name,
				systemKind: programs.systemKind,
				loggedSets: sql<number>`count(${sets.id}) filter (where ${sets.executedLoad} is not null and ${sets.executedReps} is not null)::int`
			})
			.from(sessions)
			.innerJoin(days, eq(days.id, sessions.dayId))
			.innerJoin(programs, eq(programs.id, sessions.programId))
			.leftJoin(sets, eq(sets.sessionId, sessions.id))
			.where(and(eq(sessions.userId, userId), isNotNull(sessions.deletedAt)))
			.groupBy(sessions.id, days.name, programs.name, programs.systemKind)
			.orderBy(desc(sessions.deletedAt), desc(sessions.id))
			.limit(limit),
		db
			.select({ total: sql<number>`count(*)::int` })
			.from(sessions)
			.where(and(eq(sessions.userId, userId), isNotNull(sessions.deletedAt)))
	]);
	return { sessions: rows, total };
}

export async function softDeleteEndedSession(
	db: Database,
	userId: string,
	sessionId: string
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
	const session = await loadSession(db, userId, sessionId, 'ended-active');
	if (!session) {
		return { ok: false, status: 404, message: 'Session not found' };
	}

	await db
		.update(sessions)
		.set({ deletedAt: new Date() })
		.where(
			and(
				eq(sessions.userId, userId),
				eq(sessions.id, session.id),
				isNull(sessions.deletedAt),
				isNotNull(sessions.endedAt)
			)
		);
	return { ok: true };
}

export async function restoreSoftDeletedSession(
	db: Database,
	userId: string,
	sessionId: string
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
	const session = await loadSession(db, userId, sessionId, 'deleted-only');
	if (!session) {
		return { ok: false, status: 404, message: 'Session not found in trash' };
	}

	await db
		.update(sessions)
		.set({ deletedAt: null })
		.where(
			and(eq(sessions.userId, userId), eq(sessions.id, session.id), isNotNull(sessions.deletedAt))
		);
	return { ok: true };
}

export async function hardDeleteSession(
	db: Database,
	userId: string,
	sessionId: string
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
	const session = await loadSession(db, userId, sessionId, 'deleted-only');
	if (!session) {
		return { ok: false, status: 404, message: 'Session not found in trash' };
	}

	// Re-assert deleted state INSIDE the transaction: the pre-check above runs
	// outside it, so a restore committed in between would otherwise let this
	// DELETE irrecoverably destroy a live session (review finding, 2026-09-26).
	// 0 affected rows = the session was restored concurrently → 409.
	const deleted = await db.transaction(async (tx) => {
		return tx
			.delete(sessions)
			.where(
				and(eq(sessions.userId, userId), eq(sessions.id, session.id), isNotNull(sessions.deletedAt))
			)
			.returning({ id: sessions.id });
	});
	if (deleted.length === 0) {
		return { ok: false, status: 409, message: 'Session is no longer in trash' };
	}
	return { ok: true };
}

export type PurgeResult =
	| { ok: true; purged: number }
	| { ok: false; status: 409; message: string; found: number };

/**
 * Permanently deletes every trashed session in a program.
 *
 * `expectedCount` is the trash size the user confirmed against. The count
 * and the delete run in ONE transaction with the trashed rows locked, so a
 * session trashed or restored between the confirmation screen and the
 * submit is caught (409) instead of purged unchecked. Previously the route
 * re-counted outside the transaction with a 1000-row cap, which both raced
 * the delete and made a trash of >1000 rows un-purgeable (review, 2026-09-29).
 *
 * The delete targets the counted ids, not the predicate: `FOR UPDATE` locks
 * the rows that matched at count time, but a row trashed AFTER the count
 * would still match a predicate delete and be purged without ever having
 * been confirmed. Deleting by id purges exactly the set the user saw.
 */
export async function purgeDeletedSessionsForProgram(
	db: Database,
	userId: string,
	programId: string,
	expectedCount?: number
): Promise<PurgeResult> {
	return db.transaction(async (tx) => {
		const trashed = await tx
			.select({ id: sessions.id })
			.from(sessions)
			.where(
				and(
					eq(sessions.userId, userId),
					eq(sessions.programId, programId),
					isNotNull(sessions.deletedAt)
				)
			)
			.for('update');
		if (expectedCount !== undefined && trashed.length !== expectedCount) {
			return {
				ok: false as const,
				status: 409 as const,
				message: `Trash count changed. Expected ${expectedCount}, found ${trashed.length}.`,
				found: trashed.length
			};
		}
		if (trashed.length === 0) return { ok: true as const, purged: 0 };
		const deleted = await tx
			.delete(sessions)
			.where(
				and(
					eq(sessions.userId, userId),
					inArray(
						sessions.id,
						trashed.map((t) => t.id)
					),
					isNotNull(sessions.deletedAt)
				)
			)
			.returning({ id: sessions.id });
		return { ok: true as const, purged: deleted.length };
	});
}

/**
 * Stamps `endedAt` on the session if it is currently open. Idempotent:
 * calling on an already-ended or nonexistent session is a no-op.
 *
 * Returns `updated: true` only when a row was actually closed.
 */
export async function endSession(
	db: Database,
	userId: string,
	sessionId: string
): Promise<{ updated: boolean }> {
	const session = await loadSession(db, userId, sessionId, 'active');
	if (!session || session.endedAt) {
		return { updated: false };
	}

	const result = await db
		.update(sessions)
		.set({ endedAt: new Date() })
		.where(
			and(
				eq(sessions.userId, userId),
				eq(sessions.id, session.id),
				isNull(sessions.endedAt),
				isNull(sessions.deletedAt)
			)
		)
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
	expectedIdentity?: unknown;
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
	userId: string,
	sessionId: string,
	setId: string,
	input: UpdateSetInput,
	options?: UpdateSetOptions
): Promise<UpdateSetResult> {
	return db.transaction(async (tx) => {
		const [session] = await tx
			.select()
			.from(sessions)
			.where(
				and(eq(sessions.userId, userId), eq(sessions.id, sessionId), isNull(sessions.deletedAt))
			)
			.for('update');
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

		const [currentSet] = await tx
			.select()
			.from(sets)
			.where(and(eq(sets.userId, userId), eq(sets.id, setId), eq(sets.sessionId, sessionId)));
		if (!currentSet)
			return { ok: false, setId, status: 404, message: 'Set not found in this session' };
		const identity = `${currentSet.gymEquipmentId ?? 'legacy'}:${currentSet.loadConvention}`;
		if (
			(input.expectedIdentity != null && input.expectedIdentity !== identity) ||
			(currentSet.gymEquipmentId != null && input.expectedIdentity !== identity)
		) {
			return {
				ok: false,
				setId,
				status: 409,
				message: 'Machine or load convention changed. Reload before logging.'
			};
		}
		const updated = await tx
			.update(sets)
			.set({
				executedLoad: parsed.data.executedLoad,
				executedReps: parsed.data.executedReps,
				executedRir: parsed.data.executedRir,
				notes: parsed.data.notes
			})
			.where(and(eq(sets.userId, userId), eq(sets.id, setId), eq(sets.sessionId, sessionId)))
			.returning({ id: sets.id });

		if (updated.length === 0) {
			// setId does not belong to sessionId (or doesn't exist). Either way
			// it's a 404 — same shape we return for an unknown session, so the
			// caller never sees a silent success on a no-op UPDATE.
			return { ok: false, setId, status: 404, message: 'Set not found in this session' };
		}

		return { ok: true, setId };
	});
}

/**
 * Everything the session page needs to render, as three reads.
 *
 * MOVED HERE BY THE T4 SWEEP. The route used to run these itself. It was not a
 * cross-tenant leak — every query was keyed off `session.id` from an
 * already-owner-verified `loadSession`, so no other user's row was reachable —
 * but it violated the rule that a route is a thin wrapper, and a query sitting
 * in a route is a query nobody audits when the ownership model changes.
 *
 * `dayExercises` is owned through its day through its program, and `days` is
 * NOT NULL `program_id` per the session-start integrity rule, so both are
 * reached by joining to the program the session belongs to and filtering on
 * `programs.user_id` directly. That is deliberately not `eq(days.id, ...)`:
 * the id arrives from the URL, and an owner predicate that rides on the id
 * alone is the shape D6 exists to prevent.
 */
export type SessionDayExercises = Awaited<ReturnType<typeof sessionDayExercises>>['rows'];

async function sessionDayExercises(db: Database, userId: string, dayId: string) {
	const rows = await db
		.select({
			exerciseId: dayExercises.exerciseId,
			position: dayExercises.position,
			tier: dayExercises.tier,
			progressionPolicy: dayExercises.progressionPolicy
		})
		.from(dayExercises)
		.innerJoin(days, eq(dayExercises.dayId, days.id))
		.innerJoin(programs, eq(days.programId, programs.id))
		.where(and(eq(dayExercises.dayId, dayId), eq(programs.userId, userId)))
		.orderBy(asc(dayExercises.position));
	return { rows };
}

export type SessionSets = Awaited<ReturnType<typeof sessionSetsForDay>>['rows'];

async function sessionSetsForDay(db: Database, userId: string, sessionId: string) {
	const rows = await db
		.select({
			id: sets.id,
			exerciseId: sets.exerciseId,
			exerciseName: sql<string>`coalesce(${sessionExercises.exerciseName}, ${exercises.name})`,
			sessionExerciseId: sets.sessionExerciseId,
			gymEquipmentId: sets.gymEquipmentId,
			loadConvention: sets.loadConvention,
			/** The block's equipment type, else the exercise's (free weights: 0.8.0). */
			equipmentType: sql<string>`coalesce(${sessionExercises.equipmentType}, ${exercises.equipmentType})`,
			machineLabel: sessionExercises.machineLabel,
			/** The machine's smallest load step (Part F: the weight stepper). */
			incrementLb: gymEquipment.incrementLb,
			gymName: sessionExercises.gymName,
			modelName: sessionExercises.modelName,
			occurrencePosition: sessionExercises.position,
			occurrenceTier: sessionExercises.tier,
			occurrencePolicy: sessionExercises.progressionPolicy,
			position: sets.position,
			/** Set only on a program's planned set (Part L: swap asks "From now on"). */
			prescribedSetId: sets.prescribedSetId,
			setRole: sets.setRole,
			targetMetric: sets.targetMetric,
			prescribedLoad: sets.prescribedLoad,
			prescribedRepsMin: sets.prescribedRepsMin,
			prescribedRepsMax: sets.prescribedRepsMax,
			prescribedRir: sets.prescribedRir,
			suggestionReasoning: sets.suggestionReasoning,
			executedLoad: sets.executedLoad,
			executedReps: sets.executedReps,
			executedRir: sets.executedRir,
			notes: sets.notes
		})
		.from(sets)
		.innerJoin(exercises, eq(sets.exerciseId, exercises.id))
		.leftJoin(sessionExercises, eq(sessionExercises.id, sets.sessionExerciseId))
		.leftJoin(gymEquipment, eq(gymEquipment.id, sets.gymEquipmentId))
		.where(and(eq(sets.sessionId, sessionId), eq(sets.userId, userId)))
		.orderBy(asc(sets.position));
	return { rows };
}

/**
 * The day a session was started from, and that day's exercise ordering.
 *
 * `programs.user_id` is the predicate, joined from the day rather than taken
 * from the URL — see the note on sessionDayExercises.
 */
export async function loadSessionDay(
	db: Database,
	userId: string,
	dayId: string
): Promise<{
	day: typeof days.$inferSelect | null;
	dayExs: SessionDayExercises;
	/** `programs.system_kind`: 'quick' for a workout started with no program. */
	systemKind: string | null;
}> {
	const [day] = await db
		.select({ day: days, systemKind: programs.systemKind })
		.from(days)
		.innerJoin(programs, eq(days.programId, programs.id))
		.where(and(eq(days.id, dayId), eq(programs.userId, userId)))
		.limit(1);
	if (!day) {
		// The FK guarantees the row exists, so a miss here means it belongs to
		// someone else. Reported as absent, never as a 403 (D6).
		return { day: null, dayExs: [], systemKind: null };
	}
	const { rows: dayExs } = await sessionDayExercises(db, userId, dayId);
	return { day: day.day, dayExs, systemKind: day.systemKind };
}

/** The set rows for a session, scoped to its owner. */
export async function loadSessionSets(
	db: Database,
	userId: string,
	sessionId: string
): Promise<SessionSets> {
	const { rows } = await sessionSetsForDay(db, userId, sessionId);
	return rows;
}
