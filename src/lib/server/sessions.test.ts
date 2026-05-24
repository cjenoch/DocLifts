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
import { asc, eq } from 'drizzle-orm';
import type postgres from 'postgres';
import {
	dayExercises,
	days,
	exercises,
	prescribedSets,
	programs,
	sessions,
	sets
} from './db/schema';
import {
	endSession,
	nextSetIdInSession,
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
async function seedProgram(opts: {
	programName?: string;
	exerciseName?: string;
	initialLoad?: number | null;
	tier?: 'main' | 'secondary' | 'isolation';
} = {}): Promise<ProgramFixture> {
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
		.values({ name: opts.exerciseName ?? 'Bench Press' })
		.returning();

	const [dx] = await db
		.insert(dayExercises)
		.values({
			dayId: day.id,
			exerciseId: ex.id,
			position: 1,
			tier: opts.tier ?? 'main'
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

		const [sessionA] = await db
			.select()
			.from(sessions)
			.where(eq(sessions.id, resultA.sessionId));
		const [sessionB] = await db
			.select()
			.from(sessions)
			.where(eq(sessions.id, resultB.sessionId));

		expect(sessionA.programId).toBe(a.programId);
		expect(sessionB.programId).toBe(b.programId);
		expect(sessionA.programId).not.toBe(sessionB.programId);
	});

	it('returns 404 when the day does not exist', async () => {
		// A syntactically valid but non-existent UUID.
		const result = await startSessionForDay(
			db,
			'00000000-0000-0000-0000-000000000000'
		);
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

		const [session] = await db
			.select()
			.from(sessions)
			.where(eq(sessions.id, result.sessionId));

		expect(session.startedAt).toBeInstanceOf(Date);
		expect(session.endedAt).toBeNull();
	});
});

describe('startSessionForDay: snapshot semantics', () => {
	it('snapshots prescribed set structure into the sets table', async () => {
		const fixture = await seedProgram();
		const result = await startSessionForDay(db, fixture.dayId);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const sessionSets = await db
			.select()
			.from(sets)
			.where(eq(sets.sessionId, result.sessionId));

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
		const [prog] = await db
			.insert(programs)
			.values({ name: 'multi' })
			.returning();
		const [day] = await db
			.insert(days)
			.values({ programId: prog.id, name: 'Day', position: 1 })
			.returning();
		const [ex1] = await db
			.insert(exercises)
			.values({ name: 'Bench' })
			.returning();
		const [ex2] = await db
			.insert(exercises)
			.values({ name: 'Row' })
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

describe('startSessionForDay: dumb prefill', () => {
	it('prefills prescribedLoad from initialLoad when no history exists', async () => {
		const fixture = await seedProgram({ initialLoad: 95 });
		const result = await startSessionForDay(db, fixture.dayId);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const [s] = await db
			.select({ prescribedLoad: sets.prescribedLoad })
			.from(sets)
			.where(eq(sets.sessionId, result.sessionId));
		expect(s.prescribedLoad).toBe(95);
	});

	it('prefills prescribedLoad from history.executedLoad when available', async () => {
		const fixture = await seedProgram({ initialLoad: 100 });

		// Seed a prior completed session at 110 lb for the same
		// (exerciseId, setRole, position).
		const [priorSession] = await db
			.insert(sessions)
			.values({
				dayId: fixture.dayId,
				programId: fixture.programId,
				endedAt: new Date()
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
			.select({ prescribedLoad: sets.prescribedLoad })
			.from(sets)
			.where(eq(sets.sessionId, result.sessionId));
		expect(s.prescribedLoad).toBe(110);
	});

	it('falls back to initialLoad when prior session is unfinished (blank-row safe)', async () => {
		// A blank-row poison would slip a NULL through history. The prefill must
		// see no history and fall back to initialLoad.
		const fixture = await seedProgram({ initialLoad: 100 });

		const [openSession] = await db
			.insert(sessions)
			.values({
				dayId: fixture.dayId,
				programId: fixture.programId,
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

		const [s] = await db
			.select()
			.from(sessions)
			.where(eq(sessions.id, start.sessionId));
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
		const result = await endSession(
			db,
			'00000000-0000-0000-0000-000000000000'
		);
		expect(result.updated).toBe(false);
	});

	it('does not affect other open sessions', async () => {
		const fixture = await seedProgram();
		const a = await startSessionForDay(db, fixture.dayId);
		const b = await startSessionForDay(db, fixture.dayId);
		if (!a.ok || !b.ok) throw new Error('seed failed');

		await endSession(db, a.sessionId);

		const [sb] = await db
			.select()
			.from(sessions)
			.where(eq(sessions.id, b.sessionId));
		expect(sb.endedAt).toBeNull();
	});
});

// ---------- updateSetInSession ----------

async function setupOpenSet(): Promise<{ sessionId: string; setId: string }> {
	const fixture = await seedProgram();
	const start = await startSessionForDay(db, fixture.dayId);
	if (!start.ok) throw new Error('setupOpenSet: startSessionForDay failed');
	const [set] = await db
		.select()
		.from(sets)
		.where(eq(sets.sessionId, start.sessionId));
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

	it('cross-session injection: setId from another session does not mutate', async () => {
		// Hand-crafted POST naming sessionB with setA must NOT touch setA.
		// Current behavior: helper returns ok (sessionB is valid + open) but the
		// session-scoped WHERE clause matches 0 rows, so the row is unchanged.
		const fixture = await seedProgram();
		const a = await startSessionForDay(db, fixture.dayId);
		const b = await startSessionForDay(db, fixture.dayId);
		if (!a.ok || !b.ok) throw new Error('seed failed');
		const [setA] = await db
			.select()
			.from(sets)
			.where(eq(sets.sessionId, a.sessionId));

		const result = await updateSetInSession(db, b.sessionId, setA.id, {
			executedLoad: '999',
			executedReps: '1',
			executedRir: '0',
			notes: 'hijack'
		});
		expect(result.ok).toBe(true);

		const [after] = await db.select().from(sets).where(eq(sets.id, setA.id));
		expect(after.executedLoad).toBeNull();
		expect(after.executedReps).toBeNull();
		expect(after.notes).toBeNull();
	});
});

// ---------- nextSetIdInSession ----------

describe('nextSetIdInSession', () => {
	/**
	 * Build a day with two exercises, each carrying multiple prescribed sets,
	 * then start a session so the sets table has the expected ordered rows.
	 * Returns the session id plus the ordered list of inserted set ids in the
	 * exact (exercisePos, setPos) order the session view renders.
	 */
	async function seedMultiExerciseSession(): Promise<{
		sessionId: string;
		orderedSetIds: string[];
	}> {
		const [prog] = await db
			.insert(programs)
			.values({ name: 'Next-set fixture program' })
			.returning();
		const [day] = await db
			.insert(days)
			.values({ programId: prog.id, name: 'Day', position: 1 })
			.returning();
		const [exA] = await db
			.insert(exercises)
			.values({ name: 'Exercise A' })
			.returning();
		const [exB] = await db
			.insert(exercises)
			.values({ name: 'Exercise B' })
			.returning();
		const [dxA] = await db
			.insert(dayExercises)
			.values({ dayId: day.id, exerciseId: exA.id, position: 1, tier: 'main' })
			.returning();
		const [dxB] = await db
			.insert(dayExercises)
			.values({
				dayId: day.id,
				exerciseId: exB.id,
				position: 2,
				tier: 'secondary'
			})
			.returning();
		// Exercise A: 2 sets; Exercise B: 1 set. Expected order: A1, A2, B1.
		await db.insert(prescribedSets).values([
			{ dayExerciseId: dxA.id, position: 1, setRole: 'top', initialLoad: 100 },
			{
				dayExerciseId: dxA.id,
				position: 2,
				setRole: 'backoff',
				initialLoad: 80
			},
			{
				dayExerciseId: dxB.id,
				position: 1,
				setRole: 'working',
				initialLoad: 60
			}
		]);

		const start = await startSessionForDay(db, day.id);
		if (!start.ok) throw new Error('seed: startSessionForDay failed');

		const rows = await db
			.select({ id: sets.id, exId: sets.exerciseId, pos: sets.position })
			.from(sets)
			.where(eq(sets.sessionId, start.sessionId));
		// Sort the same way the loader does: exercise position, then set position.
		// exA.id maps to exercise position 1; exB.id maps to position 2.
		const orderedSetIds = rows
			.slice()
			.sort((a, b) => {
				const aEx = a.exId === exA.id ? 1 : 2;
				const bEx = b.exId === exA.id ? 1 : 2;
				if (aEx !== bEx) return aEx - bEx;
				return a.pos - b.pos;
			})
			.map((r) => r.id);

		return { sessionId: start.sessionId, orderedSetIds };
	}

	it('returns the next set in the same exercise', async () => {
		const { sessionId, orderedSetIds } = await seedMultiExerciseSession();
		// orderedSetIds = [A1, A2, B1]; from A1, next is A2.
		const next = await nextSetIdInSession(db, sessionId, orderedSetIds[0]);
		expect(next).toBe(orderedSetIds[1]);
	});

	it('crosses exercise boundaries to the first set of the next exercise', async () => {
		const { sessionId, orderedSetIds } = await seedMultiExerciseSession();
		// From A2, next is B1.
		const next = await nextSetIdInSession(db, sessionId, orderedSetIds[1]);
		expect(next).toBe(orderedSetIds[2]);
	});

	it('returns null when the current set is the last set in the session', async () => {
		const { sessionId, orderedSetIds } = await seedMultiExerciseSession();
		// From B1 (last), no next.
		const next = await nextSetIdInSession(
			db,
			sessionId,
			orderedSetIds[orderedSetIds.length - 1]
		);
		expect(next).toBeNull();
	});

	it('returns null when the setId does not belong to the session', async () => {
		const { sessionId } = await seedMultiExerciseSession();
		const next = await nextSetIdInSession(
			db,
			sessionId,
			'00000000-0000-0000-0000-000000000000'
		);
		expect(next).toBeNull();
	});

	it('handles the same exercise appearing at two day positions', async () => {
		// Schema permits a day to schedule the same exercise twice (unique on
		// (dayId, position), not (dayId, exerciseId)). Earlier join joined on
		// (dayExercises.exerciseId, sessions.dayId) and would fan out in that
		// case — duplicating set rows and landing the user on the wrong next.
		// The fix routes the join through prescribed_sets, which is 1:1.
		const [prog] = await db
			.insert(programs)
			.values({ name: 'dup-exercise prog' })
			.returning();
		const [day] = await db
			.insert(days)
			.values({ programId: prog.id, name: 'Day', position: 1 })
			.returning();
		const [ex] = await db
			.insert(exercises)
			.values({ name: 'Same Exercise Twice' })
			.returning();

		// Same exerciseId at two day positions — legal per the schema.
		const [dxA] = await db
			.insert(dayExercises)
			.values({ dayId: day.id, exerciseId: ex.id, position: 1, tier: 'main' })
			.returning();
		const [dxB] = await db
			.insert(dayExercises)
			.values({
				dayId: day.id,
				exerciseId: ex.id,
				position: 2,
				tier: 'secondary'
			})
			.returning();

		// dxA: 2 sets (top, backoff). dxB: 1 set (working).
		// Expected order: dxA-top, dxA-backoff, dxB-working.
		await db.insert(prescribedSets).values([
			{ dayExerciseId: dxA.id, position: 1, setRole: 'top', initialLoad: 100 },
			{
				dayExerciseId: dxA.id,
				position: 2,
				setRole: 'backoff',
				initialLoad: 80
			},
			{
				dayExerciseId: dxB.id,
				position: 1,
				setRole: 'working',
				initialLoad: 60
			}
		]);

		const start = await startSessionForDay(db, day.id);
		if (!start.ok) throw new Error('seed: startSessionForDay failed');

		const rows = await db
			.select({ id: sets.id, setRole: sets.setRole, position: sets.position })
			.from(sets)
			.where(eq(sets.sessionId, start.sessionId));
		const top = rows.find((r) => r.setRole === 'top');
		const backoff = rows.find((r) => r.setRole === 'backoff');
		const working = rows.find((r) => r.setRole === 'working');
		expect(top && backoff && working).toBeTruthy();
		if (!top || !backoff || !working) return;

		// top → backoff (within dxA)
		expect(await nextSetIdInSession(db, start.sessionId, top.id)).toBe(
			backoff.id
		);
		// backoff → working (crossing dxA → dxB, same exerciseId)
		expect(await nextSetIdInSession(db, start.sessionId, backoff.id)).toBe(
			working.id
		);
		// working → null (last)
		expect(await nextSetIdInSession(db, start.sessionId, working.id)).toBeNull();
	});
});
