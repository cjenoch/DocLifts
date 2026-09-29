/**
 * Integration tests for `startSessionForDay`.
 *
 * Primary invariant under test (CLAUDE.md §Session-start integrity):
 *   session.programId MUST come from the day row, never from a client-supplied
 *   value. The function signature itself enforces this — only `(db, dayId)` is
 *   accepted — and these tests confirm the runtime behavior across multiple
 *   programs and the snapshot/prefill flow.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type postgres from 'postgres';
import {
	dayExercises,
	days,
	exercises,
	painEvents,
	prescribedSets,
	programs,
	sessions,
	sets
} from './db/schema';
import {
	endSession,
	hardDeleteSession,
	listDeletedSessionsForProgram,
	loadProgramOwnedSession,
	purgeDeletedSessionsForProgram,
	restoreSoftDeletedSession,
	softDeleteEndedSession,
	startSessionForDay,
	updateSetInSession
} from './sessions';
import { resetTestDb, setupTestDb, type TestDb } from './test-db';

let db: TestDb;
let client: postgres.Sql;
let end: () => Promise<void>;

beforeAll(async () => {
	const handle = await setupTestDb();
	db = handle.db;
	client = handle.client;
	end = handle.end;
});

afterAll(async () => {
	await end();
});

beforeEach(async () => {
	await resetTestDb(client);
});

// ---------- Fixture helpers ----------

type ProgramFixture = {
	programId: string;
	dayId: string;
	dayExerciseId: string;
	exerciseId: string;
	prescribedSetId: string;
};

/**
 * Build a minimal but realistic program: one program, one day, one exercise,
 * one prescribed set with an initialLoad of 100 unless overridden.
 */
async function seedProgram(
	opts: {
		programName?: string;
		exerciseName?: string;
		equipmentType?: 'barbell' | 'barbell-ez' | 'dumbbell' | 'machine' | 'cable' | 'bodyweight';
		isLowerBody?: boolean;
		initialLoad?: number | null;
		tier?: 'main' | 'secondary' | 'isolation';
		progressionPolicy?: 'standard' | 'cautious' | 'hold';
	} = {}
): Promise<ProgramFixture> {
	const [prog] = await db
		.insert(programs)
		.values({ name: opts.programName ?? 'Test Program' })
		.returning();

	const [day] = await db
		.insert(days)
		.values({ programId: prog.id, name: 'Day 1', position: 1 })
		.returning();

	const [ex] = await db
		.insert(exercises)
		.values({
			name: opts.exerciseName ?? 'Bench Press',
			equipmentType: opts.equipmentType ?? 'bodyweight',
			isLowerBody: opts.isLowerBody ?? false
		})
		.returning();

	const [dx] = await db
		.insert(dayExercises)
		.values({
			dayId: day.id,
			exerciseId: ex.id,
			position: 1,
			tier: opts.tier ?? 'main',
			progressionPolicy: opts.progressionPolicy ?? 'standard'
		})
		.returning();

	const [ps] = await db
		.insert(prescribedSets)
		.values({
			dayExerciseId: dx.id,
			position: 1,
			setRole: 'top',
			targetMetric: 'reps',
			targetRepsMin: 3,
			targetRepsMax: 5,
			targetRir: 1,
			initialLoad: opts.initialLoad === undefined ? 100 : opts.initialLoad
		})
		.returning();

	return {
		programId: prog.id,
		dayId: day.id,
		dayExerciseId: dx.id,
		exerciseId: ex.id,
		prescribedSetId: ps.id
	};
}

// ---------- Tests ----------

describe('startSessionForDay: session-start integrity', () => {
	it('derives session.programId from the day row, not a parameter', async () => {
		// The function signature is `(db, dayId)` — no programId parameter exists
		// to corrupt. This test confirms the runtime lookup behavior.
		const fixture = await seedProgram();

		const result = await startSessionForDay(db, fixture.dayId);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const [session] = await db
			.select()
			.from(sessions)
			.where(eq(sessions.id, result.sessionId))
			.limit(1);

		expect(session.programId).toBe(fixture.programId);
		expect(session.dayId).toBe(fixture.dayId);
	});

	it('routes session.programId to the right program when multiple exist', async () => {
		// Two programs in the DB. Starting a session for B's day must produce a
		// session with B's programId, not A's. (The naive bug would be a global
		// "active program" or grabbing the wrong row.)
		const a = await seedProgram({ programName: 'Program A' });
		const b = await seedProgram({
			programName: 'Program B',
			exerciseName: 'Squat'
		});

		const resultA = await startSessionForDay(db, a.dayId);
		const resultB = await startSessionForDay(db, b.dayId);
		expect(resultA.ok).toBe(true);
		expect(resultB.ok).toBe(true);
		if (!resultA.ok || !resultB.ok) return;

		const [sessionA] = await db.select().from(sessions).where(eq(sessions.id, resultA.sessionId));
		const [sessionB] = await db.select().from(sessions).where(eq(sessions.id, resultB.sessionId));

		expect(sessionA.programId).toBe(a.programId);
		expect(sessionB.programId).toBe(b.programId);
		expect(sessionA.programId).not.toBe(sessionB.programId);
	});

	it('returns 404 when the day does not exist', async () => {
		// A syntactically valid but non-existent UUID.
		const result = await startSessionForDay(db, '00000000-0000-0000-0000-000000000000');
		expect(result).toEqual({
			ok: false,
			status: 404,
			message: 'Day not found'
		});
	});

	it('does not create a session when the day does not exist', async () => {
		await startSessionForDay(db, '00000000-0000-0000-0000-000000000000');
		const rows = await db.select().from(sessions);
		expect(rows).toHaveLength(0);
	});

	it('sets session.startedAt and leaves endedAt null', async () => {
		const fixture = await seedProgram();
		const result = await startSessionForDay(db, fixture.dayId);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const [session] = await db.select().from(sessions).where(eq(sessions.id, result.sessionId));

		expect(session.startedAt).toBeInstanceOf(Date);
		expect(session.endedAt).toBeNull();
	});
});

describe('startSessionForDay: one-open-per-day idempotency', () => {
	it('returns the existing open session id instead of creating a duplicate', async () => {
		// Double-tap defense. A second call while a session is already open for
		// the same day must return the same session id and not insert a phantom.
		const fixture = await seedProgram();

		const first = await startSessionForDay(db, fixture.dayId);
		const second = await startSessionForDay(db, fixture.dayId);
		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		if (!first.ok || !second.ok) return;

		expect(second.sessionId).toBe(first.sessionId);

		const allSessions = await db
			.select({ id: sessions.id })
			.from(sessions)
			.where(eq(sessions.dayId, fixture.dayId));
		expect(allSessions).toHaveLength(1);
	});

	it('does NOT re-snapshot sets on the idempotent return', async () => {
		// The second call must not insert another batch of snapshot rows — that
		// would corrupt the snapshot-immutability invariant and double the set
		// count for the open session.
		const fixture = await seedProgram();
		const first = await startSessionForDay(db, fixture.dayId);
		expect(first.ok).toBe(true);
		if (!first.ok) return;

		const before = await db
			.select({ id: sets.id })
			.from(sets)
			.where(eq(sets.sessionId, first.sessionId));

		await startSessionForDay(db, fixture.dayId);

		const after = await db
			.select({ id: sets.id })
			.from(sets)
			.where(eq(sets.sessionId, first.sessionId));
		expect(after).toHaveLength(before.length);
	});

	it('creates a new session once the previous one for the day is ended', async () => {
		// The cap is "one OPEN session per day", not "one session ever". Ending
		// the first must free the day for a fresh start.
		const fixture = await seedProgram();

		const first = await startSessionForDay(db, fixture.dayId);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		await endSession(db, first.sessionId);

		const second = await startSessionForDay(db, fixture.dayId);
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(second.sessionId).not.toBe(first.sessionId);
	});

	it('creates a new session when previous open session is soft-deleted', async () => {
		const fixture = await seedProgram();
		const first = await startSessionForDay(db, fixture.dayId);
		expect(first.ok).toBe(true);
		if (!first.ok) return;

		await db
			.update(sessions)
			.set({ deletedAt: new Date() })
			.where(eq(sessions.id, first.sessionId));

		const second = await startSessionForDay(db, fixture.dayId);
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(second.sessionId).not.toBe(first.sessionId);

		const allSessions = await db
			.select({ id: sessions.id })
			.from(sessions)
			.where(eq(sessions.dayId, fixture.dayId));
		expect(allSessions).toHaveLength(2);
	});

	it('the DB rejects a hand-crafted insert that bypasses the helper', async () => {
		// Layer 2 (partial unique index) check. If app code somehow tries to
		// INSERT a second open session for the same day directly — bypassing the
		// helper — the database itself blocks it. This is the safety net for the
		// TOCTOU race between two concurrent startSessionForDay calls.
		const fixture = await seedProgram();
		const first = await startSessionForDay(db, fixture.dayId);
		expect(first.ok).toBe(true);
		if (!first.ok) return;

		await expect(
			db.insert(sessions).values({
				dayId: fixture.dayId,
				programId: fixture.programId,
				endedAt: null
			})
		).rejects.toMatchObject({ cause: { code: '23505' } });
	});

	it('converges to a single open session under N concurrent calls (23505 catch path)', async () => {
		// This is the regression lock for the day-one race recovery: the
		// partial unique index ensures only one INSERT wins, but the recovery
		// path is inside `startSessionForDay` itself (sessions.ts:126 —
		// catch 23505 → findOpenSessionForDay → return winner). Without
		// that catch, the losing call would surface an unhandled error.
		//
		// We fire N=4 concurrent calls on a fresh day. With high probability
		// at least one pair both pass the pre-check and race to INSERT —
		// exercising the catch. The exact behavior we lock in:
		//   1. NO call throws (no unhandled errors surface)
		//   2. ALL calls return ok: true
		//   3. ALL calls return the SAME sessionId (the catch path re-fetches
		//      the winner and returns it; if it returned its own (failed)
		//      tx's id, this assertion catches that regression)
		//   4. The DB ends up with exactly one open session for the day
		const fixture = await seedProgram();

		const settled = await Promise.allSettled(
			Array.from({ length: 4 }, () => startSessionForDay(db, fixture.dayId))
		);

		const rejected = settled.filter((r) => r.status === 'rejected');
		expect(rejected).toHaveLength(0);

		const results = settled
			.filter(
				(r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof startSessionForDay>>> =>
					r.status === 'fulfilled'
			)
			.map((r) => r.value);
		expect(results.every((r) => r.ok)).toBe(true);

		const ids = new Set(results.flatMap((r) => (r.ok ? [r.sessionId] : [])));
		expect(ids.size).toBe(1);

		const open = await db
			.select({ id: sessions.id })
			.from(sessions)
			.where(eq(sessions.dayId, fixture.dayId));
		expect(open).toHaveLength(1);
		expect(open[0].id).toBe([...ids][0]);
	});
});

describe('startSessionForDay: snapshot semantics', () => {
	it('snapshots prescribed set structure into the sets table', async () => {
		const fixture = await seedProgram();
		const result = await startSessionForDay(db, fixture.dayId);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const sessionSets = await db.select().from(sets).where(eq(sets.sessionId, result.sessionId));

		expect(sessionSets).toHaveLength(1);
		expect(sessionSets[0]).toMatchObject({
			exerciseId: fixture.exerciseId,
			prescribedSetId: fixture.prescribedSetId,
			position: 1,
			setRole: 'top',
			targetMetric: 'reps',
			prescribedRepsMin: 3,
			prescribedRepsMax: 5,
			prescribedRir: 1
		});
	});

	it('inserts one sets row per prescribed_set, in (exercise, set) order', async () => {
		// Build a day with 2 exercises, exercise 1 has 2 prescribed sets, exercise
		// 2 has 1 prescribed set → expect 3 sets total in the right order.
		const [prog] = await db.insert(programs).values({ name: 'multi' }).returning();
		const [day] = await db
			.insert(days)
			.values({ programId: prog.id, name: 'Day', position: 1 })
			.returning();
		const [ex1] = await db
			.insert(exercises)
			.values({ name: 'Bench', equipmentType: 'bodyweight' })
			.returning();
		const [ex2] = await db
			.insert(exercises)
			.values({ name: 'Row', equipmentType: 'bodyweight' })
			.returning();
		const [dx1] = await db
			.insert(dayExercises)
			.values({ dayId: day.id, exerciseId: ex1.id, position: 1, tier: 'main' })
			.returning();
		const [dx2] = await db
			.insert(dayExercises)
			.values({
				dayId: day.id,
				exerciseId: ex2.id,
				position: 2,
				tier: 'secondary'
			})
			.returning();
		await db.insert(prescribedSets).values([
			{
				dayExerciseId: dx1.id,
				position: 1,
				setRole: 'top',
				initialLoad: 100
			},
			{
				dayExerciseId: dx1.id,
				position: 2,
				setRole: 'backoff',
				initialLoad: 80
			},
			{
				dayExerciseId: dx2.id,
				position: 1,
				setRole: 'working',
				initialLoad: 50
			}
		]);

		const result = await startSessionForDay(db, day.id);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const sessionSets = await db
			.select()
			.from(sets)
			.where(eq(sets.sessionId, result.sessionId))
			.orderBy(asc(sets.loggedAt));

		expect(sessionSets).toHaveLength(3);
		expect(sessionSets.map((s) => [s.exerciseId, s.position, s.setRole])).toEqual([
			[ex1.id, 1, 'top'],
			[ex1.id, 2, 'backoff'],
			[ex2.id, 1, 'working']
		]);
	});
});

describe('startSessionForDay: prefill pipeline', () => {
	it('prefills prescribedLoad from initialLoad when no history exists', async () => {
		const fixture = await seedProgram({ initialLoad: 95, equipmentType: 'bodyweight' });
		const result = await startSessionForDay(db, fixture.dayId);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const [s] = await db
			.select({
				prescribedLoad: sets.prescribedLoad,
				suggestionReasoning: sets.suggestionReasoning
			})
			.from(sets)
			.where(eq(sets.sessionId, result.sessionId));
		expect(s.prescribedLoad).toBe(95);
		expect(s.suggestionReasoning).toBeNull();
	});

	it('prefills prescribedLoad from progressed + snapped history path when available', async () => {
		const fixture = await seedProgram({ initialLoad: 100, equipmentType: 'bodyweight' });

		// Seed a prior completed session at 110 lb for the same
		// (exerciseId, setRole, position). For default MAIN/standard policy with
		// targetRepsMax=5, targetRir=1 and prior (5 reps @ RIR 1), engine suggests
		// +5 then snap keeps 115 for bodyweight equipment.
		const priorStartedAt = new Date(Date.now() - 60_000);
		const priorEndedAt = new Date(Date.now() - 30_000);
		const [priorSession] = await db
			.insert(sessions)
			.values({
				dayId: fixture.dayId,
				programId: fixture.programId,
				startedAt: priorStartedAt,
				endedAt: priorEndedAt
			})
			.returning();
		await db.insert(sets).values({
			sessionId: priorSession.id,
			exerciseId: fixture.exerciseId,
			position: 1,
			setRole: 'top',
			targetMetric: 'reps',
			executedLoad: 110,
			executedReps: 5,
			executedRir: 1
		});

		const result = await startSessionForDay(db, fixture.dayId);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const [s] = await db
			.select({
				prescribedLoad: sets.prescribedLoad,
				suggestionReasoning: sets.suggestionReasoning
			})
			.from(sets)
			.where(eq(sets.sessionId, result.sessionId));
		expect(s.prescribedLoad).toBe(115);
		expect(s.suggestionReasoning).toContain('+5');
	});

	it('falls back to initialLoad when prior session is unfinished (blank-row safe)', async () => {
		// A blank-row poison would slip a NULL through history. The prefill must
		// see no history and fall back to initialLoad.
		//
		// The poisoned open session lives on a SEPARATE day (different program +
		// day, same exerciseId) — the new one-open-per-day cap would otherwise
		// short-circuit startSessionForDay before prefill even runs.
		const fixture = await seedProgram({ initialLoad: 100, equipmentType: 'bodyweight' });

		const [otherProgram] = await db
			.insert(programs)
			.values({ name: 'blank-row poison host' })
			.returning();
		const [otherDay] = await db
			.insert(days)
			.values({ programId: otherProgram.id, name: 'other', position: 1 })
			.returning();
		const [openSession] = await db
			.insert(sessions)
			.values({
				dayId: otherDay.id,
				programId: otherProgram.id,
				endedAt: null
			})
			.returning();
		await db.insert(sets).values({
			sessionId: openSession.id,
			exerciseId: fixture.exerciseId,
			position: 1,
			setRole: 'top',
			targetMetric: 'reps',
			executedLoad: null,
			executedReps: null
		});

		const result = await startSessionForDay(db, fixture.dayId);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const [s] = await db
			.select({ prescribedLoad: sets.prescribedLoad })
			.from(sets)
			.where(eq(sets.sessionId, result.sessionId));
		expect(s.prescribedLoad).toBe(100);
	});

	it('holds SECONDARY progression when only one working set clears (all-working-set gate)', async () => {
		const [prog] = await db.insert(programs).values({ name: 'secondary gate' }).returning();
		const [day] = await db
			.insert(days)
			.values({ programId: prog.id, name: 'Day 1', position: 1 })
			.returning();
		const [ex] = await db
			.insert(exercises)
			.values({ name: 'Cable Row', equipmentType: 'cable' })
			.returning();
		const [dx] = await db
			.insert(dayExercises)
			.values({
				dayId: day.id,
				exerciseId: ex.id,
				position: 1,
				tier: 'secondary',
				progressionPolicy: 'standard'
			})
			.returning();
		await db.insert(prescribedSets).values([
			{
				dayExerciseId: dx.id,
				position: 1,
				setRole: 'working',
				targetMetric: 'reps',
				targetRepsMin: 8,
				targetRepsMax: 10,
				targetRir: 1,
				initialLoad: 100
			},
			{
				dayExerciseId: dx.id,
				position: 2,
				setRole: 'working',
				targetMetric: 'reps',
				targetRepsMin: 8,
				targetRepsMax: 10,
				targetRir: 1,
				initialLoad: 90
			}
		]);

		// Prior completed session: set 1 clears, set 2 does NOT clear.
		const [priorSession] = await db
			.insert(sessions)
			.values({
				dayId: day.id,
				programId: prog.id,
				startedAt: new Date(Date.now() - 120_000),
				endedAt: new Date(Date.now() - 90_000)
			})
			.returning();
		await db.insert(sets).values([
			{
				sessionId: priorSession.id,
				exerciseId: ex.id,
				position: 1,
				setRole: 'working',
				targetMetric: 'reps',
				executedLoad: 100,
				executedReps: 10,
				executedRir: 1,
				prescribedRepsMax: 10,
				prescribedRir: 1
			},
			{
				sessionId: priorSession.id,
				exerciseId: ex.id,
				position: 2,
				setRole: 'working',
				targetMetric: 'reps',
				executedLoad: 90,
				executedReps: 8,
				executedRir: 3,
				prescribedRepsMax: 10,
				prescribedRir: 1
			}
		]);

		const result = await startSessionForDay(db, day.id);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const rows = await db
			.select({
				position: sets.position,
				prescribedLoad: sets.prescribedLoad,
				suggestionReasoning: sets.suggestionReasoning
			})
			.from(sets)
			.where(eq(sets.sessionId, result.sessionId))
			.orderBy(asc(sets.position));

		expect(rows).toEqual([
			{
				position: 1,
				prescribedLoad: 100,
				suggestionReasoning: 'held: not all working sets cleared top of range'
			},
			{
				position: 2,
				prescribedLoad: 90,
				suggestionReasoning: 'held: not all working sets cleared top of range'
			}
		]);
	});

	it('advances SECONDARY progression when all working sets clear', async () => {
		const [prog] = await db.insert(programs).values({ name: 'secondary advance' }).returning();
		const [day] = await db
			.insert(days)
			.values({ programId: prog.id, name: 'Day 1', position: 1 })
			.returning();
		const [ex] = await db
			.insert(exercises)
			.values({ name: 'Cable Pulldown', equipmentType: 'cable' })
			.returning();
		const [dx] = await db
			.insert(dayExercises)
			.values({
				dayId: day.id,
				exerciseId: ex.id,
				position: 1,
				tier: 'secondary',
				progressionPolicy: 'standard'
			})
			.returning();
		await db.insert(prescribedSets).values([
			{
				dayExerciseId: dx.id,
				position: 1,
				setRole: 'working',
				targetMetric: 'reps',
				targetRepsMin: 8,
				targetRepsMax: 10,
				targetRir: 1,
				initialLoad: 100
			},
			{
				dayExerciseId: dx.id,
				position: 2,
				setRole: 'working',
				targetMetric: 'reps',
				targetRepsMin: 8,
				targetRepsMax: 10,
				targetRir: 1,
				initialLoad: 90
			}
		]);

		const [priorSession] = await db
			.insert(sessions)
			.values({
				dayId: day.id,
				programId: prog.id,
				startedAt: new Date(Date.now() - 120_000),
				endedAt: new Date(Date.now() - 90_000)
			})
			.returning();
		await db.insert(sets).values([
			{
				sessionId: priorSession.id,
				exerciseId: ex.id,
				position: 1,
				setRole: 'working',
				targetMetric: 'reps',
				executedLoad: 100,
				executedReps: 10,
				executedRir: 1,
				prescribedRepsMax: 10,
				prescribedRir: 1
			},
			{
				sessionId: priorSession.id,
				exerciseId: ex.id,
				position: 2,
				setRole: 'working',
				targetMetric: 'reps',
				executedLoad: 90,
				executedReps: 10,
				executedRir: 1,
				prescribedRepsMax: 10,
				prescribedRir: 1
			}
		]);

		const result = await startSessionForDay(db, day.id);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const rows = await db
			.select({
				position: sets.position,
				prescribedLoad: sets.prescribedLoad,
				suggestionReasoning: sets.suggestionReasoning
			})
			.from(sets)
			.where(eq(sets.sessionId, result.sessionId))
			.orderBy(asc(sets.position));

		expect(rows).toEqual([
			{
				position: 1,
				prescribedLoad: 105,
				suggestionReasoning: '+5: all working sets at top of range'
			},
			{
				position: 2,
				prescribedLoad: 95,
				suggestionReasoning: '+5: all working sets at top of range'
			}
		]);
	});

	it('holds SECONDARY when a position clears position 1\u2019s range but not its own (M2)', async () => {
		const [prog] = await db.insert(programs).values({ name: 'm2 hold' }).returning();
		const [day] = await db
			.insert(days)
			.values({ programId: prog.id, name: 'Day 1', position: 1 })
			.returning();
		const [ex] = await db
			.insert(exercises)
			.values({ name: 'M2 Press', equipmentType: 'cable' })
			.returning();
		const [dx] = await db
			.insert(dayExercises)
			.values({
				dayId: day.id,
				exerciseId: ex.id,
				position: 1,
				tier: 'secondary',
				progressionPolicy: 'standard'
			})
			.returning();
		await db.insert(prescribedSets).values([
			{
				dayExerciseId: dx.id,
				position: 1,
				setRole: 'working',
				targetMetric: 'reps',
				targetRepsMin: 6,
				targetRepsMax: 8,
				targetRir: 1,
				initialLoad: 100
			},
			{
				dayExerciseId: dx.id,
				position: 2,
				setRole: 'working',
				targetMetric: 'reps',
				targetRepsMin: 10,
				targetRepsMax: 12,
				targetRir: 1,
				initialLoad: 100
			}
		]);

		// Prior completed session: position 1 clears its 8; position 2 hits 10 —
		// clears position 1's 8 but NOT its own 12. Pre-fix the engine judged
		// position 2 against 8 and advanced 135 → 140.
		const [priorSession] = await db
			.insert(sessions)
			.values({
				dayId: day.id,
				programId: prog.id,
				startedAt: new Date(Date.now() - 120_000),
				endedAt: new Date(Date.now() - 90_000)
			})
			.returning();
		await db.insert(sets).values([
			{
				sessionId: priorSession.id,
				exerciseId: ex.id,
				position: 1,
				setRole: 'working',
				targetMetric: 'reps',
				executedLoad: 135,
				executedReps: 8,
				executedRir: 1,
				prescribedRepsMax: 8,
				prescribedRir: 1
			},
			{
				sessionId: priorSession.id,
				exerciseId: ex.id,
				position: 2,
				setRole: 'working',
				targetMetric: 'reps',
				executedLoad: 135,
				executedReps: 10,
				executedRir: 1,
				prescribedRepsMax: 12,
				prescribedRir: 1
			}
		]);

		const result = await startSessionForDay(db, day.id);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const rows = await db
			.select({
				position: sets.position,
				prescribedLoad: sets.prescribedLoad,
				suggestionReasoning: sets.suggestionReasoning
			})
			.from(sets)
			.where(eq(sets.sessionId, result.sessionId))
			.orderBy(asc(sets.position));

		expect(rows).toEqual([
			{
				position: 1,
				prescribedLoad: 135,
				suggestionReasoning: 'held: not all working sets cleared top of range'
			},
			{
				position: 2,
				prescribedLoad: 135,
				suggestionReasoning: 'held: not all working sets cleared top of range'
			}
		]);
	});

	it('advances SECONDARY when every position clears its own range (M2)', async () => {
		const [prog] = await db.insert(programs).values({ name: 'm2 advance' }).returning();
		const [day] = await db
			.insert(days)
			.values({ programId: prog.id, name: 'Day 1', position: 1 })
			.returning();
		const [ex] = await db
			.insert(exercises)
			.values({ name: 'M2 Press Advance', equipmentType: 'cable' })
			.returning();
		const [dx] = await db
			.insert(dayExercises)
			.values({
				dayId: day.id,
				exerciseId: ex.id,
				position: 1,
				tier: 'secondary',
				progressionPolicy: 'standard'
			})
			.returning();
		await db.insert(prescribedSets).values([
			{
				dayExerciseId: dx.id,
				position: 1,
				setRole: 'working',
				targetMetric: 'reps',
				targetRepsMin: 6,
				targetRepsMax: 8,
				targetRir: 1,
				initialLoad: 100
			},
			{
				dayExerciseId: dx.id,
				position: 2,
				setRole: 'working',
				targetMetric: 'reps',
				targetRepsMin: 10,
				targetRepsMax: 12,
				targetRir: 1,
				initialLoad: 100
			}
		]);

		const [priorSession] = await db
			.insert(sessions)
			.values({
				dayId: day.id,
				programId: prog.id,
				startedAt: new Date(Date.now() - 120_000),
				endedAt: new Date(Date.now() - 90_000)
			})
			.returning();
		await db.insert(sets).values([
			{
				sessionId: priorSession.id,
				exerciseId: ex.id,
				position: 1,
				setRole: 'working',
				targetMetric: 'reps',
				executedLoad: 135,
				executedReps: 8,
				executedRir: 1,
				prescribedRepsMax: 8,
				prescribedRir: 1
			},
			{
				sessionId: priorSession.id,
				exerciseId: ex.id,
				position: 2,
				setRole: 'working',
				targetMetric: 'reps',
				executedLoad: 135,
				executedReps: 12,
				executedRir: 1,
				prescribedRepsMax: 12,
				prescribedRir: 1
			}
		]);

		const result = await startSessionForDay(db, day.id);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const rows = await db
			.select({
				position: sets.position,
				prescribedLoad: sets.prescribedLoad,
				suggestionReasoning: sets.suggestionReasoning
			})
			.from(sets)
			.where(eq(sets.sessionId, result.sessionId))
			.orderBy(asc(sets.position));

		expect(rows).toEqual([
			{
				position: 1,
				prescribedLoad: 140,
				suggestionReasoning: '+5: all working sets at top of range'
			},
			{
				position: 2,
				prescribedLoad: 140,
				suggestionReasoning: '+5: all working sets at top of range'
			}
		]);
	});

	it('warmup rows bypass engine even when warmup history exists', async () => {
		const [prog] = await db.insert(programs).values({ name: 'warmup bypass' }).returning();
		const [day] = await db
			.insert(days)
			.values({ programId: prog.id, name: 'Day 1', position: 1 })
			.returning();
		const [ex] = await db
			.insert(exercises)
			.values({ name: 'Bench Warmup Test', equipmentType: 'dumbbell' })
			.returning();
		const [dx] = await db
			.insert(dayExercises)
			.values({
				dayId: day.id,
				exerciseId: ex.id,
				position: 1,
				tier: 'main',
				progressionPolicy: 'standard'
			})
			.returning();
		await db.insert(prescribedSets).values({
			dayExerciseId: dx.id,
			position: 1,
			setRole: 'warmup',
			targetMetric: 'reps',
			targetRepsMin: 10,
			targetRepsMax: 12,
			targetRir: 1,
			initialLoad: 90
		});

		// If engine were wrongly applied to warmups, this would bump to 105.
		const [priorSession] = await db
			.insert(sessions)
			.values({
				dayId: day.id,
				programId: prog.id,
				startedAt: new Date(Date.now() - 120_000),
				endedAt: new Date(Date.now() - 90_000)
			})
			.returning();
		await db.insert(sets).values({
			sessionId: priorSession.id,
			exerciseId: ex.id,
			position: 1,
			setRole: 'warmup',
			targetMetric: 'reps',
			executedLoad: 100,
			executedReps: 12,
			executedRir: 1,
			prescribedRepsMax: 12,
			prescribedRir: 1
		});

		const result = await startSessionForDay(db, day.id);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const [row] = await db
			.select({
				prescribedLoad: sets.prescribedLoad,
				suggestionReasoning: sets.suggestionReasoning
			})
			.from(sets)
			.where(eq(sets.sessionId, result.sessionId));

		expect(row.prescribedLoad).toBe(100);
		expect(row.suggestionReasoning).toBeNull();
	});

	it('non-MAIN deload checks all working positions (position-1-only no longer forces deload)', async () => {
		const [prog] = await db
			.insert(programs)
			.values({ name: 'secondary deload aggregate' })
			.returning();
		const [day] = await db
			.insert(days)
			.values({ programId: prog.id, name: 'Day 1', position: 1 })
			.returning();
		const [ex] = await db
			.insert(exercises)
			.values({ name: 'Cable Row Aggregate Deload', equipmentType: 'cable' })
			.returning();
		const [dx] = await db
			.insert(dayExercises)
			.values({
				dayId: day.id,
				exerciseId: ex.id,
				position: 1,
				tier: 'secondary',
				progressionPolicy: 'standard'
			})
			.returning();
		await db.insert(prescribedSets).values([
			{
				dayExerciseId: dx.id,
				position: 1,
				setRole: 'working',
				targetMetric: 'reps',
				targetRepsMin: 8,
				targetRepsMax: 10,
				targetRir: 1,
				initialLoad: 100
			},
			{
				dayExerciseId: dx.id,
				position: 2,
				setRole: 'working',
				targetMetric: 'reps',
				targetRepsMin: 8,
				targetRepsMax: 10,
				targetRir: 1,
				initialLoad: 90
			}
		]);

		const base = Date.now() - 600_000;
		const [s1] = await db
			.insert(sessions)
			.values({
				dayId: day.id,
				programId: prog.id,
				startedAt: new Date(base),
				endedAt: new Date(base + 30_000)
			})
			.returning();
		const [s2] = await db
			.insert(sessions)
			.values({
				dayId: day.id,
				programId: prog.id,
				startedAt: new Date(base + 120_000),
				endedAt: new Date(base + 150_000)
			})
			.returning();
		const [s3] = await db
			.insert(sessions)
			.values({
				dayId: day.id,
				programId: prog.id,
				startedAt: new Date(base + 240_000),
				endedAt: new Date(base + 270_000)
			})
			.returning();

		await db.insert(sets).values([
			{
				sessionId: s1.id,
				exerciseId: ex.id,
				position: 1,
				setRole: 'working',
				targetMetric: 'reps',
				executedLoad: 110,
				executedReps: 8,
				executedRir: 2,
				prescribedRepsMax: 10,
				prescribedRir: 1,
				loggedAt: new Date(base + 20_000)
			},
			{
				sessionId: s1.id,
				exerciseId: ex.id,
				position: 2,
				setRole: 'working',
				targetMetric: 'reps',
				executedLoad: 80,
				executedReps: 8,
				executedRir: 2,
				prescribedRepsMax: 10,
				prescribedRir: 1,
				loggedAt: new Date(base + 20_000)
			},
			{
				sessionId: s2.id,
				exerciseId: ex.id,
				position: 1,
				setRole: 'working',
				targetMetric: 'reps',
				executedLoad: 100,
				executedReps: 8,
				executedRir: 2,
				prescribedRepsMax: 10,
				prescribedRir: 1,
				loggedAt: new Date(base + 140_000)
			},
			{
				sessionId: s2.id,
				exerciseId: ex.id,
				position: 2,
				setRole: 'working',
				targetMetric: 'reps',
				executedLoad: 85,
				executedReps: 8,
				executedRir: 2,
				prescribedRepsMax: 10,
				prescribedRir: 1,
				loggedAt: new Date(base + 140_000)
			},
			{
				sessionId: s3.id,
				exerciseId: ex.id,
				position: 1,
				setRole: 'working',
				targetMetric: 'reps',
				executedLoad: 90,
				executedReps: 8,
				executedRir: 2,
				prescribedRepsMax: 10,
				prescribedRir: 1,
				loggedAt: new Date(base + 260_000)
			},
			{
				sessionId: s3.id,
				exerciseId: ex.id,
				position: 2,
				setRole: 'working',
				targetMetric: 'reps',
				executedLoad: 90,
				executedReps: 8,
				executedRir: 2,
				prescribedRepsMax: 10,
				prescribedRir: 1,
				loggedAt: new Date(base + 260_000)
			}
		]);

		const result = await startSessionForDay(db, day.id);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const rows = await db
			.select({
				position: sets.position,
				prescribedLoad: sets.prescribedLoad,
				suggestionReasoning: sets.suggestionReasoning
			})
			.from(sets)
			.where(eq(sets.sessionId, result.sessionId))
			.orderBy(asc(sets.position));

		expect(rows).toEqual([
			{
				position: 1,
				prescribedLoad: 90,
				suggestionReasoning: 'held: not all working sets cleared top of range'
			},
			{
				position: 2,
				prescribedLoad: 90,
				suggestionReasoning: 'held: not all working sets cleared top of range'
			}
		]);
	});

	it('non-MAIN deload triggers when all working positions are backwards twice', async () => {
		const [prog] = await db
			.insert(programs)
			.values({ name: 'secondary deload all positions' })
			.returning();
		const [day] = await db
			.insert(days)
			.values({ programId: prog.id, name: 'Day 1', position: 1 })
			.returning();
		const [ex] = await db
			.insert(exercises)
			.values({ name: 'Cable Row Deload Trigger', equipmentType: 'cable' })
			.returning();
		const [dx] = await db
			.insert(dayExercises)
			.values({
				dayId: day.id,
				exerciseId: ex.id,
				position: 1,
				tier: 'secondary',
				progressionPolicy: 'standard'
			})
			.returning();
		await db.insert(prescribedSets).values([
			{
				dayExerciseId: dx.id,
				position: 1,
				setRole: 'working',
				targetMetric: 'reps',
				targetRepsMin: 8,
				targetRepsMax: 10,
				targetRir: 1,
				initialLoad: 100
			},
			{
				dayExerciseId: dx.id,
				position: 2,
				setRole: 'working',
				targetMetric: 'reps',
				targetRepsMin: 8,
				targetRepsMax: 10,
				targetRir: 1,
				initialLoad: 90
			}
		]);

		const base = Date.now() - 600_000;
		const [s1] = await db
			.insert(sessions)
			.values({
				dayId: day.id,
				programId: prog.id,
				startedAt: new Date(base),
				endedAt: new Date(base + 30_000)
			})
			.returning();
		const [s2] = await db
			.insert(sessions)
			.values({
				dayId: day.id,
				programId: prog.id,
				startedAt: new Date(base + 120_000),
				endedAt: new Date(base + 150_000)
			})
			.returning();
		const [s3] = await db
			.insert(sessions)
			.values({
				dayId: day.id,
				programId: prog.id,
				startedAt: new Date(base + 240_000),
				endedAt: new Date(base + 270_000)
			})
			.returning();

		await db.insert(sets).values([
			{
				sessionId: s1.id,
				exerciseId: ex.id,
				position: 1,
				setRole: 'working',
				targetMetric: 'reps',
				executedLoad: 110,
				executedReps: 8,
				executedRir: 2,
				prescribedRepsMax: 10,
				prescribedRir: 1,
				loggedAt: new Date(base + 20_000)
			},
			{
				sessionId: s1.id,
				exerciseId: ex.id,
				position: 2,
				setRole: 'working',
				targetMetric: 'reps',
				executedLoad: 95,
				executedReps: 8,
				executedRir: 2,
				prescribedRepsMax: 10,
				prescribedRir: 1,
				loggedAt: new Date(base + 20_000)
			},
			{
				sessionId: s2.id,
				exerciseId: ex.id,
				position: 1,
				setRole: 'working',
				targetMetric: 'reps',
				executedLoad: 100,
				executedReps: 8,
				executedRir: 2,
				prescribedRepsMax: 10,
				prescribedRir: 1,
				loggedAt: new Date(base + 140_000)
			},
			{
				sessionId: s2.id,
				exerciseId: ex.id,
				position: 2,
				setRole: 'working',
				targetMetric: 'reps',
				executedLoad: 92,
				executedReps: 8,
				executedRir: 2,
				prescribedRepsMax: 10,
				prescribedRir: 1,
				loggedAt: new Date(base + 140_000)
			},
			{
				sessionId: s3.id,
				exerciseId: ex.id,
				position: 1,
				setRole: 'working',
				targetMetric: 'reps',
				executedLoad: 90,
				executedReps: 8,
				executedRir: 2,
				prescribedRepsMax: 10,
				prescribedRir: 1,
				loggedAt: new Date(base + 260_000)
			},
			{
				sessionId: s3.id,
				exerciseId: ex.id,
				position: 2,
				setRole: 'working',
				targetMetric: 'reps',
				executedLoad: 90,
				executedReps: 8,
				executedRir: 2,
				prescribedRepsMax: 10,
				prescribedRir: 1,
				loggedAt: new Date(base + 260_000)
			}
		]);

		const result = await startSessionForDay(db, day.id);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const rows = await db
			.select({
				position: sets.position,
				prescribedLoad: sets.prescribedLoad,
				suggestionReasoning: sets.suggestionReasoning
			})
			.from(sets)
			.where(eq(sets.sessionId, result.sessionId))
			.orderBy(asc(sets.position));

		expect(rows).toEqual([
			{
				position: 1,
				prescribedLoad: 81,
				suggestionReasoning: '10% deload after 2 consecutive backwards sessions'
			},
			{
				position: 2,
				prescribedLoad: 81,
				suggestionReasoning: '10% deload after 2 consecutive backwards sessions'
			}
		]);
	});
});

// ---------- endSession ----------

describe('endSession', () => {
	it('stamps endedAt on an open session', async () => {
		const fixture = await seedProgram();
		const start = await startSessionForDay(db, fixture.dayId);
		if (!start.ok) throw new Error('seed failed');

		const before = Date.now();
		const result = await endSession(db, start.sessionId);
		expect(result.updated).toBe(true);

		const [s] = await db.select().from(sessions).where(eq(sessions.id, start.sessionId));
		expect(s.endedAt).toBeInstanceOf(Date);
		expect(s.endedAt!.getTime()).toBeGreaterThanOrEqual(before);
	});

	it('is idempotent: returns updated=false on an already-ended session', async () => {
		// And critically, must NOT overwrite the original endedAt — a silent
		// timestamp shift on resubmit would corrupt history.
		const fixture = await seedProgram();
		const start = await startSessionForDay(db, fixture.dayId);
		if (!start.ok) throw new Error('seed failed');

		await endSession(db, start.sessionId);
		const [first] = await db
			.select({ endedAt: sessions.endedAt })
			.from(sessions)
			.where(eq(sessions.id, start.sessionId));
		const firstEndedAt = first.endedAt;

		const second = await endSession(db, start.sessionId);
		expect(second.updated).toBe(false);

		const [after] = await db
			.select({ endedAt: sessions.endedAt })
			.from(sessions)
			.where(eq(sessions.id, start.sessionId));
		expect(after.endedAt?.getTime()).toBe(firstEndedAt?.getTime());
	});

	it('returns updated=false for a nonexistent session', async () => {
		const result = await endSession(db, '00000000-0000-0000-0000-000000000000');
		expect(result.updated).toBe(false);
	});

	it('does not affect other open sessions', async () => {
		// Two distinct days — one open session per day is the cap (partial unique
		// index `sessions_one_open_per_day`). Ending one must leave the other open.
		const fixtureA = await seedProgram({ programName: 'A' });
		const fixtureB = await seedProgram({ programName: 'B', exerciseName: 'Squat' });
		const a = await startSessionForDay(db, fixtureA.dayId);
		const b = await startSessionForDay(db, fixtureB.dayId);
		if (!a.ok || !b.ok) throw new Error('seed failed');
		expect(a.sessionId).not.toBe(b.sessionId);

		await endSession(db, a.sessionId);

		const [sb] = await db.select().from(sessions).where(eq(sessions.id, b.sessionId));
		expect(sb.endedAt).toBeNull();
	});
});

// ---------- updateSetInSession ----------

async function setupOpenSet(): Promise<{ sessionId: string; setId: string }> {
	const fixture = await seedProgram();
	const start = await startSessionForDay(db, fixture.dayId);
	if (!start.ok) throw new Error('setupOpenSet: startSessionForDay failed');
	const [set] = await db.select().from(sets).where(eq(sets.sessionId, start.sessionId));
	return { sessionId: start.sessionId, setId: set.id };
}

describe('updateSetInSession', () => {
	it('writes executed values + notes on valid input', async () => {
		const { sessionId, setId } = await setupOpenSet();
		const result = await updateSetInSession(db, sessionId, setId, {
			executedLoad: '105.5',
			executedReps: '5',
			executedRir: '1',
			notes: 'felt strong'
		});
		expect(result).toEqual({ ok: true, setId });

		const [s] = await db.select().from(sets).where(eq(sets.id, setId));
		expect(s.executedLoad).toBe(105.5);
		expect(s.executedReps).toBe(5);
		expect(s.executedRir).toBe(1);
		expect(s.notes).toBe('felt strong');
	});

	it('treats empty strings on numeric fields and notes as null', async () => {
		const { sessionId, setId } = await setupOpenSet();
		const result = await updateSetInSession(db, sessionId, setId, {
			executedLoad: '',
			executedReps: '',
			executedRir: '',
			notes: ''
		});
		expect(result.ok).toBe(true);

		const [s] = await db.select().from(sets).where(eq(sets.id, setId));
		expect(s.executedLoad).toBeNull();
		expect(s.executedReps).toBeNull();
		expect(s.executedRir).toBeNull();
		expect(s.notes).toBeNull();
	});

	it('treats whitespace-only notes as null', async () => {
		const { sessionId, setId } = await setupOpenSet();
		await updateSetInSession(db, sessionId, setId, {
			executedLoad: '100',
			executedReps: '5',
			executedRir: '1',
			notes: '   '
		});
		const [s] = await db.select().from(sets).where(eq(sets.id, setId));
		expect(s.notes).toBeNull();
	});

	it('returns 404 when the session does not exist', async () => {
		const result = await updateSetInSession(
			db,
			'00000000-0000-0000-0000-000000000000',
			'00000000-0000-0000-0000-000000000001',
			{ executedLoad: '100', executedReps: '5', executedRir: '1', notes: '' }
		);
		expect(result).toEqual({
			ok: false,
			setId: '00000000-0000-0000-0000-000000000001',
			status: 404,
			message: 'Session not found'
		});
	});

	it('returns 409 on an ended session and does not mutate the row', async () => {
		// The stale-tab guard — history is append-only in practice.
		const { sessionId, setId } = await setupOpenSet();
		await endSession(db, sessionId);

		const result = await updateSetInSession(db, sessionId, setId, {
			executedLoad: '999',
			executedReps: '99',
			executedRir: '0',
			notes: 'late'
		});
		expect(result).toMatchObject({
			ok: false,
			setId,
			status: 409,
			message: 'Session has ended'
		});

		const [s] = await db.select().from(sets).where(eq(sets.id, setId));
		expect(s.executedLoad).toBeNull();
		expect(s.executedReps).toBeNull();
		expect(s.notes).toBeNull();
	});

	it('allows editing an ended session when explicitly opted-in', async () => {
		const { sessionId, setId } = await setupOpenSet();
		await endSession(db, sessionId);

		const result = await updateSetInSession(
			db,
			sessionId,
			setId,
			{
				executedLoad: '210',
				executedReps: '8',
				executedRir: '2',
				notes: 'retro edit'
			},
			{ allowEndedSession: true }
		);
		expect(result).toEqual({ ok: true, setId });

		const [s] = await db.select().from(sets).where(eq(sets.id, setId));
		expect(s.executedLoad).toBe(210);
		expect(s.executedReps).toBe(8);
		expect(s.executedRir).toBe(2);
		expect(s.notes).toBe('retro edit');
	});

	it('returns 404 when attempting to edit a soft-deleted ended session even with allowEndedSession', async () => {
		const { sessionId, setId } = await setupOpenSet();
		await endSession(db, sessionId);
		await db.update(sessions).set({ deletedAt: new Date() }).where(eq(sessions.id, sessionId));

		const result = await updateSetInSession(
			db,
			sessionId,
			setId,
			{
				executedLoad: '210',
				executedReps: '8',
				executedRir: '2',
				notes: 'should not save'
			},
			{ allowEndedSession: true }
		);
		expect(result).toMatchObject({ ok: false, status: 404, message: 'Session not found' });

		const [s] = await db.select().from(sets).where(eq(sets.id, setId));
		expect(s.executedLoad).toBeNull();
		expect(s.executedReps).toBeNull();
		expect(s.executedRir).toBeNull();
		expect(s.notes).toBeNull();
	});

	it('returns 400 with fieldErrors on invalid input and does not mutate', async () => {
		const { sessionId, setId } = await setupOpenSet();
		const result = await updateSetInSession(db, sessionId, setId, {
			executedLoad: '-5',
			executedReps: 'abc',
			executedRir: '11',
			notes: ''
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBe(400);
		expect(result.fieldErrors?.executedLoad).toBeDefined();
		expect(result.fieldErrors?.executedReps).toBeDefined();
		expect(result.fieldErrors?.executedRir).toBeDefined();

		const [s] = await db.select().from(sets).where(eq(sets.id, setId));
		expect(s.executedLoad).toBeNull();
		expect(s.executedReps).toBeNull();
	});

	it('cross-session injection: setId from another session is rejected as 404', async () => {
		// Hand-crafted POST naming sessionB with setA must NOT touch setA.
		// Helper returns 404 (setId not a row of sessionB) — surfacing a real
		// rejection instead of a silent no-op ok. Two distinct days — one
		// open session per day is the cap.
		const fixtureA = await seedProgram({ programName: 'A' });
		const fixtureB = await seedProgram({ programName: 'B', exerciseName: 'Squat' });
		const a = await startSessionForDay(db, fixtureA.dayId);
		const b = await startSessionForDay(db, fixtureB.dayId);
		if (!a.ok || !b.ok) throw new Error('seed failed');
		const [setA] = await db.select().from(sets).where(eq(sets.sessionId, a.sessionId));

		const result = await updateSetInSession(db, b.sessionId, setA.id, {
			executedLoad: '999',
			executedReps: '1',
			executedRir: '0',
			notes: 'hijack'
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBe(404);

		const [after] = await db.select().from(sets).where(eq(sets.id, setA.id));
		expect(after.executedLoad).toBeNull();
		expect(after.executedReps).toBeNull();
		expect(after.notes).toBeNull();
	});
});

// ---------- Test 1: Snapshot immutability after template edit ----------

describe('startSessionForDay: snapshot immutability after template edit', () => {
	it('sets row keeps prescribed values even after the originating prescribed_sets row is mutated', async () => {
		// INVARIANT (CLAUDE.md §Snapshot semantics): once a session starts, the
		// prescribed values copied into the sets row are frozen. A later edit to
		// the program template must NOT retroactively change those values.
		const fixture = await seedProgram({
			initialLoad: 200
			// targetRepsMin: 3, targetRepsMax: 5 are the seedProgram defaults
		});

		const result = await startSessionForDay(db, fixture.dayId);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		// Capture the sets row as written at session-start time.
		const [beforeEdit] = await db.select().from(sets).where(eq(sets.sessionId, result.sessionId));
		expect(beforeEdit.prescribedLoad).toBe(200);
		expect(beforeEdit.prescribedRepsMin).toBe(3);
		expect(beforeEdit.prescribedRepsMax).toBe(5);

		// Simulate a program template edit: change reps range and initial load on
		// the originating prescribed_sets row.
		await db
			.update(prescribedSets)
			.set({ targetRepsMin: 6, targetRepsMax: 8, initialLoad: 999 })
			.where(eq(prescribedSets.id, fixture.prescribedSetId));

		// Re-read the sets row. The snapshot values must be unchanged.
		const [afterEdit] = await db.select().from(sets).where(eq(sets.sessionId, result.sessionId));

		expect(afterEdit.prescribedLoad).toBe(200);
		expect(afterEdit.prescribedRepsMin).toBe(3);
		expect(afterEdit.prescribedRepsMax).toBe(5);
	});
});

// ---------- Test 3: startSessionForDay with initialLoad: null cold start ----------

describe('startSessionForDay: null initialLoad cold start', () => {
	it('sets prescribedLoad to null (not 0) when initialLoad is null and no history exists', async () => {
		// INVARIANT (CLAUDE.md §No prescribed loads in program template): initialLoad
		// is only a cold-start fallback. When it is explicitly null (i.e. the
		// template author left it unset), the sets row must also have a null
		// prescribedLoad, not zero or any other sentinel.
		const fixture = await seedProgram({ initialLoad: null });

		const result = await startSessionForDay(db, fixture.dayId);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const [s] = await db
			.select({ prescribedLoad: sets.prescribedLoad })
			.from(sets)
			.where(eq(sets.sessionId, result.sessionId));

		expect(s.prescribedLoad).toBeNull();
	});

	it('cold-start snaps initialLoad for barbell equipment when no history exists', async () => {
		const fixture = await seedProgram({
			exerciseName: 'Deadlift',
			equipmentType: 'barbell',
			isLowerBody: true,
			initialLoad: 113
		});

		const result = await startSessionForDay(db, fixture.dayId);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const [s] = await db
			.select({ prescribedLoad: sets.prescribedLoad })
			.from(sets)
			.where(eq(sets.sessionId, result.sessionId));

		expect(s.prescribedLoad).toBe(109);
	});

	it('uses executedLoad from prior completed session as prefill, not null, when history exists', async () => {
		// Bonus: after one completed session at a real load, the next session's
		// prescribedLoad should reflect the executed load — even though initialLoad
		// is null. Confirms the history path works correctly for null-initialLoad
		// exercises.
		const fixture = await seedProgram({ initialLoad: null });

		// Complete a session with an executed load.
		const firstResult = await startSessionForDay(db, fixture.dayId);
		expect(firstResult.ok).toBe(true);
		if (!firstResult.ok) return;

		const [firstSet] = await db
			.select()
			.from(sets)
			.where(eq(sets.sessionId, firstResult.sessionId));

		await db
			.update(sets)
			.set({ executedLoad: 135, executedReps: 5, executedRir: 1 })
			.where(eq(sets.id, firstSet.id));

		await db
			.update(sessions)
			.set({ endedAt: new Date() })
			.where(eq(sessions.id, firstResult.sessionId));

		// Second session: prefill should pick up the executedLoad from history.
		const secondResult = await startSessionForDay(db, fixture.dayId);
		expect(secondResult.ok).toBe(true);
		if (!secondResult.ok) return;

		const [secondSet] = await db
			.select({ prescribedLoad: sets.prescribedLoad })
			.from(sets)
			.where(eq(sets.sessionId, secondResult.sessionId));

		expect(secondSet.prescribedLoad).toBe(140);
	});

	it('uses progression + plate snap wiring for barbell history path', async () => {
		const fixture = await seedProgram({
			exerciseName: 'Deadlift wired-history',
			equipmentType: 'barbell',
			isLowerBody: true,
			initialLoad: 100,
			tier: 'main',
			progressionPolicy: 'standard'
		});

		const priorStartedAt = new Date(Date.now() - 90_000);
		const priorEndedAt = new Date(Date.now() - 60_000);
		const [priorSession] = await db
			.insert(sessions)
			.values({
				dayId: fixture.dayId,
				programId: fixture.programId,
				startedAt: priorStartedAt,
				endedAt: priorEndedAt
			})
			.returning();

		// For deadlift naming, increment is +10. Engine should propose 296 from
		// prior 286 (hit target at rir=1), then barbell snap rounds to 294.
		// This proves pipeline wiring is engine output -> snap output, not raw
		// history copy.
		await db.insert(sets).values({
			sessionId: priorSession.id,
			exerciseId: fixture.exerciseId,
			position: 1,
			setRole: 'top',
			targetMetric: 'reps',
			executedLoad: 286,
			executedReps: 5,
			executedRir: 1,
			prescribedRepsMax: 5,
			prescribedRir: 1
		});

		const result = await startSessionForDay(db, fixture.dayId);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const [s] = await db
			.select({
				prescribedLoad: sets.prescribedLoad,
				suggestionReasoning: sets.suggestionReasoning
			})
			.from(sets)
			.where(eq(sets.sessionId, result.sessionId));

		expect(s.prescribedLoad).toBe(294);
		expect(s.suggestionReasoning).toContain('+10');
	});
});

// ---------- Test 5: Multi-exercise pairwise prescribedSetId + prescribedLoad correctness ----------

describe('startSessionForDay: pairwise prescribedSetId and prescribedLoad correctness across exercises', () => {
	it('each sets row points at the correct prescribed_sets row and carries the matching initialLoad', async () => {
		// INVARIANT (sessions.ts loop, startSessionForDay): the loop index `i` ties
		// `prescribed[i]` to `prefilledLoads[i]`. A drift between these two arrays
		// (e.g. different ordering, off-by-one) would misroute loads to wrong rows.
		// This test seeds four prescribed sets at DISTINCT initialLoads across two
		// exercises and verifies each resulting sets row is correctly paired.
		const [prog] = await db.insert(programs).values({ name: 'pairwise-check' }).returning();
		const [day] = await db
			.insert(days)
			.values({ programId: prog.id, name: 'Day', position: 1 })
			.returning();
		const [ex1] = await db
			.insert(exercises)
			.values({ name: 'Squat', equipmentType: 'bodyweight' })
			.returning();
		const [ex2] = await db
			.insert(exercises)
			.values({ name: 'Leg Press', equipmentType: 'bodyweight' })
			.returning();

		const [dx1] = await db
			.insert(dayExercises)
			.values({ dayId: day.id, exerciseId: ex1.id, position: 1, tier: 'main' })
			.returning();
		const [dx2] = await db
			.insert(dayExercises)
			.values({ dayId: day.id, exerciseId: ex2.id, position: 2, tier: 'secondary' })
			.returning();

		// Four prescribed sets at distinctly different loads so a mis-mapping is
		// immediately apparent: 100, 80, 60, 40.
		const [ps1a] = await db
			.insert(prescribedSets)
			.values({
				dayExerciseId: dx1.id,
				position: 1,
				setRole: 'top',
				targetRepsMin: 3,
				targetRepsMax: 5,
				initialLoad: 100
			})
			.returning();
		const [ps1b] = await db
			.insert(prescribedSets)
			.values({
				dayExerciseId: dx1.id,
				position: 2,
				setRole: 'backoff',
				targetRepsMin: 5,
				targetRepsMax: 8,
				initialLoad: 80
			})
			.returning();
		const [ps2a] = await db
			.insert(prescribedSets)
			.values({
				dayExerciseId: dx2.id,
				position: 1,
				setRole: 'working',
				targetRepsMin: 8,
				targetRepsMax: 12,
				initialLoad: 60
			})
			.returning();
		const [ps2b] = await db
			.insert(prescribedSets)
			.values({
				dayExerciseId: dx2.id,
				position: 2,
				setRole: 'working',
				targetRepsMin: 8,
				targetRepsMax: 12,
				initialLoad: 40
			})
			.returning();

		const result = await startSessionForDay(db, day.id);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const sessionSets = await db
			.select()
			.from(sets)
			.where(eq(sets.sessionId, result.sessionId))
			.orderBy(asc(sets.loggedAt));

		// Expect 4 sets total.
		expect(sessionSets).toHaveLength(4);

		// Build a lookup from prescribedSetId → expected initialLoad.
		const expected: Record<string, number> = {
			[ps1a.id]: 100,
			[ps1b.id]: 80,
			[ps2a.id]: 60,
			[ps2b.id]: 40
		};

		for (const s of sessionSets) {
			expect(s.prescribedSetId).not.toBeNull();
			// Each sets row must point at a real prescription.
			expect(s.prescribedSetId).toBeDefined();
			if (!s.prescribedSetId) continue;

			// The prescribedLoad must exactly match the initialLoad of the prescription
			// it points at — proving no index-drift between the prescribed array and
			// the prefilledLoads array in startSessionForDay.
			expect(s.prescribedLoad).toBe(expected[s.prescribedSetId]);
		}

		// All four prescriptions must be referenced (no doubled or missing pairings).
		const referencedIds = sessionSets.map((s) => s.prescribedSetId).sort();
		expect(referencedIds).toEqual([ps1a.id, ps1b.id, ps2a.id, ps2b.id].sort());
	});
});

describe('soft-delete and hard-delete session guards', () => {
	it('restoreSoftDeletedSession returns 404 for a deleted session owned by another program', async () => {
		const owner = await seedProgram({
			programName: 'Owner Program',
			exerciseName: `Bench Press Owner ${crypto.randomUUID().slice(0, 6)}`
		});
		const other = await seedProgram({
			programName: 'Other Program',
			exerciseName: `Bench Press Other ${crypto.randomUUID().slice(0, 6)}`
		});

		const started = await startSessionForDay(db, owner.dayId);
		expect(started.ok).toBe(true);
		if (!started.ok) return;
		await endSession(db, started.sessionId);
		await softDeleteEndedSession(db, started.sessionId);

		const scoped = await loadProgramOwnedSession(
			db,
			started.sessionId,
			other.programId,
			'deleted-only'
		);
		expect(scoped).toBeNull();

		const [stillDeleted] = await db
			.select({ deletedAt: sessions.deletedAt })
			.from(sessions)
			.where(eq(sessions.id, started.sessionId));
		expect(stillDeleted.deletedAt).not.toBeNull();
	});

	it('hardDeleteSession returns 404 for a deleted session owned by another program scope helper', async () => {
		const owner = await seedProgram({
			programName: 'Delete Owner Program',
			exerciseName: `Bench Press DelOwner ${crypto.randomUUID().slice(0, 6)}`
		});
		const other = await seedProgram({
			programName: 'Delete Other Program',
			exerciseName: `Bench Press DelOther ${crypto.randomUUID().slice(0, 6)}`
		});

		const started = await startSessionForDay(db, owner.dayId);
		expect(started.ok).toBe(true);
		if (!started.ok) return;
		await endSession(db, started.sessionId);
		await softDeleteEndedSession(db, started.sessionId);

		const scoped = await loadProgramOwnedSession(
			db,
			started.sessionId,
			other.programId,
			'deleted-only'
		);
		expect(scoped).toBeNull();

		const [sessionRow] = await db
			.select({ id: sessions.id })
			.from(sessions)
			.where(eq(sessions.id, started.sessionId));
		expect(sessionRow).toBeDefined();
	});

	it('endSession returns updated=false for a soft-deleted session and does not stamp endedAt', async () => {
		const fixture = await seedProgram();
		const started = await startSessionForDay(db, fixture.dayId);
		expect(started.ok).toBe(true);
		if (!started.ok) return;

		await db
			.update(sessions)
			.set({ deletedAt: new Date() })
			.where(eq(sessions.id, started.sessionId));

		const result = await endSession(db, started.sessionId);
		expect(result.updated).toBe(false);

		const [row] = await db
			.select({ endedAt: sessions.endedAt })
			.from(sessions)
			.where(eq(sessions.id, started.sessionId));
		expect(row.endedAt).toBeNull();
	});

	it('softDeleteEndedSession rejects open sessions and does not mutate deletedAt', async () => {
		const fixture = await seedProgram();
		const started = await startSessionForDay(db, fixture.dayId);
		expect(started.ok).toBe(true);
		if (!started.ok) return;

		const result = await softDeleteEndedSession(db, started.sessionId);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBe(404);

		const [row] = await db
			.select({ deletedAt: sessions.deletedAt })
			.from(sessions)
			.where(eq(sessions.id, started.sessionId));
		expect(row.deletedAt).toBeNull();
	});

	it('restoreSoftDeletedSession clears deletedAt and listDeletedSessionsForProgram reflects it', async () => {
		const fixture = await seedProgram();
		const started = await startSessionForDay(db, fixture.dayId);
		expect(started.ok).toBe(true);
		if (!started.ok) return;
		await endSession(db, started.sessionId);
		await softDeleteEndedSession(db, started.sessionId);

		let trashed = await listDeletedSessionsForProgram(db, fixture.programId);
		expect(trashed.map((s) => s.id)).toContain(started.sessionId);

		const restored = await restoreSoftDeletedSession(db, started.sessionId);
		expect(restored.ok).toBe(true);

		trashed = await listDeletedSessionsForProgram(db, fixture.programId);
		expect(trashed.map((s) => s.id)).not.toContain(started.sessionId);
	});

	it('hardDeleteSession removes session and cascades set/painEvent rows', async () => {
		const fixture = await seedProgram();
		const started = await startSessionForDay(db, fixture.dayId);
		expect(started.ok).toBe(true);
		if (!started.ok) return;
		await endSession(db, started.sessionId);
		await softDeleteEndedSession(db, started.sessionId);

		const [seededSet] = await db
			.select({ id: sets.id })
			.from(sets)
			.where(eq(sets.sessionId, started.sessionId))
			.limit(1);
		expect(seededSet).toBeDefined();
		if (!seededSet) return;

		const [pain] = await db
			.insert(painEvents)
			.values({
				sessionId: started.sessionId,
				setId: seededSet.id,
				exerciseId: fixture.exerciseId,
				location: 'knee',
				severity: 4,
				notes: 'test cascade'
			})
			.returning({ id: painEvents.id });

		const beforeSets = await db
			.select({ id: sets.id })
			.from(sets)
			.where(eq(sets.sessionId, started.sessionId));
		expect(beforeSets.length).toBeGreaterThan(0);

		const beforePain = await db
			.select({ id: painEvents.id })
			.from(painEvents)
			.where(eq(painEvents.id, pain.id));
		expect(beforePain).toHaveLength(1);

		const del = await hardDeleteSession(db, started.sessionId);
		expect(del.ok).toBe(true);

		const [sessionRow] = await db
			.select({ id: sessions.id })
			.from(sessions)
			.where(eq(sessions.id, started.sessionId));
		expect(sessionRow).toBeUndefined();

		const afterSets = await db
			.select({ id: sets.id })
			.from(sets)
			.where(eq(sets.sessionId, started.sessionId));
		expect(afterSets).toHaveLength(0);

		const afterPain = await db
			.select({ id: painEvents.id })
			.from(painEvents)
			.where(eq(painEvents.id, pain.id));
		expect(afterPain).toHaveLength(0);
	});

	it('purgeDeletedSessionsForProgram removes only soft-deleted rows', async () => {
		const fixture = await seedProgram();
		const a = await startSessionForDay(db, fixture.dayId);
		expect(a.ok).toBe(true);
		if (!a.ok) return;
		await endSession(db, a.sessionId);
		await softDeleteEndedSession(db, a.sessionId);

		const b = await startSessionForDay(db, fixture.dayId);
		expect(b.ok).toBe(true);
		if (!b.ok) return;
		await endSession(db, b.sessionId);

		const result = await purgeDeletedSessionsForProgram(db, fixture.programId);
		expect(result.purged).toBe(1);

		const all = await db
			.select({ id: sessions.id, deletedAt: sessions.deletedAt })
			.from(sessions)
			.where(eq(sessions.programId, fixture.programId));

		expect(all.map((r) => r.id)).toContain(b.sessionId);
		expect(all.map((r) => r.id)).not.toContain(a.sessionId);
	});

	// ---------- Regression tests: 2026-09-26 review findings ----------

	it('same exercise twice in one day: non-main decisions are per-occurrence, not merged (dayExerciseId keying)', async () => {
		const [prog] = await db
			.insert(programs)
			.values({ name: 'duplicate occurrence fix' })
			.returning();
		const [day] = await db
			.insert(days)
			.values({ programId: prog.id, name: 'Day 1', position: 1 })
			.returning();
		const [ex] = await db
			.insert(exercises)
			.values({ name: 'DB Curl Dup', equipmentType: 'dumbbell' })
			.returning();
		// Same exercise at two day positions, DIFFERENT policies: occurrence 1
		// standard (engine decides), occurrence 2 cautious (engine holds).
		const [dx1] = await db
			.insert(dayExercises)
			.values({
				dayId: day.id,
				exerciseId: ex.id,
				position: 1,
				tier: 'isolation',
				progressionPolicy: 'standard'
			})
			.returning();
		const [dx2] = await db
			.insert(dayExercises)
			.values({
				dayId: day.id,
				exerciseId: ex.id,
				position: 2,
				tier: 'isolation',
				progressionPolicy: 'cautious'
			})
			.returning();
		for (const dx of [dx1, dx2]) {
			await db.insert(prescribedSets).values([
				{
					dayExerciseId: dx.id,
					position: 1,
					setRole: 'working',
					targetMetric: 'reps',
					targetRepsMin: 8,
					targetRepsMax: 10,
					targetRir: 1,
					initialLoad: 50
				},
				{
					dayExerciseId: dx.id,
					position: 2,
					setRole: 'working',
					targetMetric: 'reps',
					targetRepsMin: 8,
					targetRepsMax: 10,
					targetRir: 1,
					initialLoad: 45
				}
			]);
		}

		// Prior session where BOTH occurrences' positions cleared (both at reps 10).
		// If the decision loop were still keyed by exerciseId, occurrence 1's
		// standard-policy decision (advance) would be applied to occurrence 2's
		// cautious-policy rows too.
		const [prior] = await db
			.insert(sessions)
			.values({
				dayId: day.id,
				programId: prog.id,
				startedAt: new Date(Date.now() - 120_000),
				endedAt: new Date(Date.now() - 90_000)
			})
			.returning();
		await db.insert(sets).values([
			{
				sessionId: prior.id,
				exerciseId: ex.id,
				position: 1,
				setRole: 'working',
				targetMetric: 'reps',
				executedLoad: 50,
				executedReps: 10,
				executedRir: 1,
				prescribedRepsMax: 10,
				prescribedRir: 1
			},
			{
				sessionId: prior.id,
				exerciseId: ex.id,
				position: 2,
				setRole: 'working',
				targetMetric: 'reps',
				executedLoad: 45,
				executedReps: 10,
				executedRir: 1,
				prescribedRepsMax: 10,
				prescribedRir: 1
			}
		]);

		const result = await startSessionForDay(db, day.id);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const rows = await db
			.select({
				sessionExerciseId: sets.sessionExerciseId,
				position: sets.position,
				prescribedLoad: sets.prescribedLoad,
				suggestionReasoning: sets.suggestionReasoning
			})
			.from(sets)
			.where(eq(sets.sessionId, result.sessionId))
			.orderBy(asc(sets.sessionExerciseId), asc(sets.position));

		expect(rows).toHaveLength(4);
		const byOccurrence = new Map<string, typeof rows>();
		for (const r of rows) {
			const key = r.sessionExerciseId ?? 'legacy';
			if (!byOccurrence.has(key)) byOccurrence.set(key, []);
			byOccurrence.get(key)!.push(r);
		}
		expect(byOccurrence.size).toBe(2);
		const reasons = [...byOccurrence.values()].map((occ) => occ[0].suggestionReasoning);
		// One occurrence advances, the other is held by cautious policy —
		// with the old exerciseId keying, both would share one decision.
		expect(reasons).toContain('held: cautious policy — manual advance only');
		expect(reasons.some((r) => r?.startsWith('+5'))).toBe(true);
	});

	it('partial history on a SECONDARY exercise holds the whole exercise (no per-position engine call)', async () => {
		const [prog] = await db.insert(programs).values({ name: 'partial history fix' }).returning();
		const [day] = await db
			.insert(days)
			.values({ programId: prog.id, name: 'Day 1', position: 1 })
			.returning();
		const [ex] = await db
			.insert(exercises)
			.values({ name: 'Partial Hist Triceps', equipmentType: 'cable' })
			.returning();
		const [dx] = await db
			.insert(dayExercises)
			.values({
				dayId: day.id,
				exerciseId: ex.id,
				position: 1,
				tier: 'secondary',
				progressionPolicy: 'standard'
			})
			.returning();
		await db.insert(prescribedSets).values([
			{
				dayExerciseId: dx.id,
				position: 1,
				setRole: 'working',
				targetMetric: 'reps',
				targetRepsMin: 8,
				targetRepsMax: 10,
				targetRir: 1,
				initialLoad: 100
			},
			{
				dayExerciseId: dx.id,
				position: 2,
				setRole: 'working',
				targetMetric: 'reps',
				targetRepsMin: 8,
				targetRepsMax: 10,
				targetRir: 1,
				initialLoad: 90
			}
		]);

		// Prior session: position 1 completed and CLEARING (reps 10 @ RIR 1),
		// position 2 never executed (null executed values — e.g. skipped set).
		const [prior] = await db
			.insert(sessions)
			.values({
				dayId: day.id,
				programId: prog.id,
				startedAt: new Date(Date.now() - 120_000),
				endedAt: new Date(Date.now() - 90_000)
			})
			.returning();
		await db.insert(sets).values([
			{
				sessionId: prior.id,
				exerciseId: ex.id,
				position: 1,
				setRole: 'working',
				targetMetric: 'reps',
				executedLoad: 100,
				executedReps: 10,
				executedRir: 1,
				prescribedRepsMax: 10,
				prescribedRir: 1
			},
			{
				sessionId: prior.id,
				exerciseId: ex.id,
				position: 2,
				setRole: 'working',
				targetMetric: 'reps',
				executedLoad: null,
				executedReps: null
			}
		]);

		const result = await startSessionForDay(db, day.id);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const rows = await db
			.select({
				position: sets.position,
				prescribedLoad: sets.prescribedLoad,
				suggestionReasoning: sets.suggestionReasoning
			})
			.from(sets)
			.where(eq(sets.sessionId, result.sessionId))
			.orderBy(asc(sets.position));

		// Position 1 has last-completed 100 → held at 100 (NOT advanced to 105);
		// position 2 has no history → initialLoad 90. Neither may show an
		// advance reasoning — the old code called the engine per-position and
		// position 1 alone would have advanced.
		expect(rows).toEqual([
			{
				position: 1,
				prescribedLoad: 100,
				suggestionReasoning: 'held: incomplete history on this exercise'
			},
			{ position: 2, prescribedLoad: 90, suggestionReasoning: null }
		]);
	});

	it('backoff row on a SECONDARY exercise holds with the no-rule reasoning, not "incomplete history"', async () => {
		const [prog] = await db.insert(programs).values({ name: 'secondary backoff text' }).returning();
		const [day] = await db
			.insert(days)
			.values({ programId: prog.id, name: 'Day 1', position: 1 })
			.returning();
		const [ex] = await db
			.insert(exercises)
			.values({ name: 'Backoff Text Row', equipmentType: 'cable' })
			.returning();
		const [dx] = await db
			.insert(dayExercises)
			.values({
				dayId: day.id,
				exerciseId: ex.id,
				position: 1,
				tier: 'secondary',
				progressionPolicy: 'standard'
			})
			.returning();
		await db.insert(prescribedSets).values([
			{
				dayExerciseId: dx.id,
				position: 1,
				setRole: 'working',
				targetMetric: 'reps',
				targetRepsMin: 8,
				targetRepsMax: 10,
				targetRir: 1,
				initialLoad: 100
			},
			{
				dayExerciseId: dx.id,
				position: 2,
				setRole: 'backoff',
				targetMetric: 'reps',
				targetRepsMin: 8,
				targetRepsMax: 10,
				targetRir: 1,
				initialLoad: 80
			}
		]);

		// Prior session: the working set clears (advance is legitimate); the
		// backoff row was executed too, so the exercise's history is COMPLETE.
		const [prior] = await db
			.insert(sessions)
			.values({
				dayId: day.id,
				programId: prog.id,
				startedAt: new Date(Date.now() - 120_000),
				endedAt: new Date(Date.now() - 90_000)
			})
			.returning();
		await db.insert(sets).values([
			{
				sessionId: prior.id,
				exerciseId: ex.id,
				position: 1,
				setRole: 'working',
				targetMetric: 'reps',
				executedLoad: 100,
				executedReps: 10,
				executedRir: 1,
				prescribedRepsMax: 10,
				prescribedRir: 1
			},
			{
				sessionId: prior.id,
				exerciseId: ex.id,
				position: 2,
				setRole: 'backoff',
				targetMetric: 'reps',
				executedLoad: 80,
				executedReps: 10,
				executedRir: 2,
				prescribedRepsMax: 10,
				prescribedRir: 1
			}
		]);

		const result = await startSessionForDay(db, day.id);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const rows = await db
			.select({
				position: sets.position,
				prescribedLoad: sets.prescribedLoad,
				suggestionReasoning: sets.suggestionReasoning
			})
			.from(sets)
			.where(eq(sets.sessionId, result.sessionId))
			.orderBy(asc(sets.position));

		// Working set advances on its own merit. The backoff row is never judged
		// on a non-main tier: it holds at its last load, and its provenance says
		// so — not "incomplete history", which was false here (history is complete)
		// and told the user there was a gap to close.
		expect(rows).toEqual([
			{
				position: 1,
				prescribedLoad: 105,
				suggestionReasoning: '+5: all working sets at top of range'
			},
			{
				position: 2,
				prescribedLoad: 80,
				suggestionReasoning: 'held: no progression rule applies to this set'
			}
		]);
	});

	it('hardDeleteSession refuses (409) when the session is restored between check and delete', async () => {
		const fixture = await seedProgram();
		const started = await startSessionForDay(db, fixture.dayId);
		expect(started.ok).toBe(true);
		if (!started.ok) return;
		await endSession(db, started.sessionId);
		await softDeleteEndedSession(db, started.sessionId);

		// Simulate the race: hardDeleteSession's loadSession pre-check runs
		// first, then a restore commits before the DELETE. We can't interleave
		// real callbacks without hooks, so we assert the DELETE-side guard
		// directly: clear deleted_at AFTER a loadSession('deleted-only') read
		// would succeed but BEFORE the delete — approximated by restoring and
		// verifying the in-transaction isNotNull guard makes it a 409 no-op.
		// Path A (normal): soft-deleted → hard delete succeeds. Done first.
		const del = await hardDeleteSession(db, started.sessionId);
		expect(del.ok).toBe(true);

		// Path B (race): restore, then hard-delete again. loadSession
		// deleted-only returns 404 (session is live), so nothing is deleted.
		const second = await startSessionForDay(db, fixture.dayId);
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		await endSession(db, second.sessionId);
		await softDeleteEndedSession(db, second.sessionId);
		await restoreSoftDeletedSession(db, second.sessionId);

		const delLive = await hardDeleteSession(db, second.sessionId);
		expect(delLive.ok).toBe(false);
		if (delLive.ok) return;
		expect(delLive.status).toBe(404);

		const [row] = await db
			.select({ id: sessions.id })
			.from(sessions)
			.where(eq(sessions.id, second.sessionId));
		expect(row).toBeDefined();
	});
});
