/**
 * DB-backed tests for the history-lookup safety filter (CLAUDE.md §History
 * lookups always filter incomplete data).
 *
 * The bug class being defended against: "blank-row poisoning" — a pre-created
 * session row with NULL executed values getting returned as "history" by
 * naive `ORDER BY logged_at DESC LIMIT 1` queries. See planning v2.2 §3.
 */

import { and, count, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import {
	dayExercises,
	days,
	exercises,
	programs,
	sessions,
	sets
} from './db/schema';
import { computeConsecutiveBackwards, getLastCompletedSet } from './progression';
import { resetTestDb, setupTestDb, type TestDb } from './test-db';

let db: TestDb;
let client: postgres.Sql;
let end: () => Promise<void>;

let programId: string;
let dayId: string;
let exerciseId: string;
let otherExerciseId: string;

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

	const [prog] = await db.insert(programs).values({ name: 'test program' }).returning();
	programId = prog.id;

	const [day] = await db
		.insert(days)
		.values({ programId, name: 'Day 1', position: 1 })
		.returning();
	dayId = day.id;

	const [ex] = await db.insert(exercises).values({ name: 'Bench Press', equipmentType: 'bodyweight' }).returning();
	exerciseId = ex.id;

	const [otherEx] = await db.insert(exercises).values({ name: 'Squat', equipmentType: 'bodyweight' }).returning();
	otherExerciseId = otherEx.id;

	await db.insert(dayExercises).values({
		dayId,
		exerciseId,
		position: 1,
		tier: 'main'
	});
});

// ---------- Fixture helpers ----------

const DAY_MS = 86_400_000;
const BASE_DATE = new Date('2026-05-01T12:00:00Z').getTime();

async function addSession(opts: { ended?: boolean } = {}): Promise<string> {
	const [s] = await db
		.insert(sessions)
		.values({
			dayId,
			programId,
			startedAt: new Date(),
			endedAt: opts.ended === false ? null : new Date()
		})
		.returning();
	return s.id;
}

type AddSetOpts = {
	sessionId: string;
	exerciseIdOverride?: string;
	setRole?: 'warmup' | 'working' | 'top' | 'backoff';
	position?: number;
	executedLoad?: number | null;
	executedReps?: number | null;
	executedRir?: number | null;
	loggedAt?: Date;
};

async function addSet(opts: AddSetOpts): Promise<string> {
	const [r] = await db
		.insert(sets)
		.values({
			sessionId: opts.sessionId,
			exerciseId: opts.exerciseIdOverride ?? exerciseId,
			position: opts.position ?? 1,
			setRole: opts.setRole ?? 'top',
			targetMetric: 'reps',
			executedLoad: opts.executedLoad === undefined ? 100 : opts.executedLoad,
			executedReps: opts.executedReps === undefined ? 5 : opts.executedReps,
			executedRir: opts.executedRir === undefined ? 1 : opts.executedRir,
			loggedAt: opts.loggedAt ?? new Date()
		})
		.returning();
	return r.id;
}

/** Insert N completed sessions, one set each, with `loads[i]` at day i. */
async function seedSessions(loads: ReadonlyArray<number | null>): Promise<void> {
	for (let i = 0; i < loads.length; i++) {
		const sId = await addSession({ ended: true });
		await addSet({
			sessionId: sId,
			executedLoad: loads[i],
			executedReps: loads[i] === null ? null : 5,
			loggedAt: new Date(BASE_DATE + i * DAY_MS)
		});
	}
}

// ---------- getLastCompletedSet ----------

describe('getLastCompletedSet: history filter', () => {
	it('returns null when no sets exist', async () => {
		const result = await getLastCompletedSet(db, exerciseId, 'top', 1);
		expect(result).toBeNull();
	});

	it('returns null when only open sessions exist (endedAt IS NULL)', async () => {
		const sId = await addSession({ ended: false });
		await addSet({ sessionId: sId, executedLoad: 100, executedReps: 5 });
		const result = await getLastCompletedSet(db, exerciseId, 'top', 1);
		expect(result).toBeNull();
	});

	it('returns null when session is soft-deleted', async () => {
		const sId = await addSession({ ended: true });
		await addSet({ sessionId: sId, executedLoad: 100, executedReps: 5 });
		await db
			.update(sessions)
			.set({ deletedAt: new Date() })
			.where(eq(sessions.id, sId));

		const result = await getLastCompletedSet(db, exerciseId, 'top', 1);
		expect(result).toBeNull();
	});

	it('returns null when only blank-row sets exist (executedLoad NULL)', async () => {
		const sId = await addSession({ ended: true });
		await addSet({
			sessionId: sId,
			executedLoad: null,
			executedReps: null
		});
		const result = await getLastCompletedSet(db, exerciseId, 'top', 1);
		expect(result).toBeNull();
	});

	it('returns the most recent completed set by logged_at', async () => {
		const s1 = await addSession({ ended: true });
		const s2 = await addSession({ ended: true });
		await addSet({
			sessionId: s1,
			executedLoad: 100,
			loggedAt: new Date(BASE_DATE)
		});
		await addSet({
			sessionId: s2,
			executedLoad: 110,
			loggedAt: new Date(BASE_DATE + DAY_MS)
		});
		const result = await getLastCompletedSet(db, exerciseId, 'top', 1);
		expect(result?.executedLoad).toBe(110);
	});

	it('IGNORES newer blank-row poison and returns older completed set', async () => {
		// The blank-row poisoning case: a newer pre-created session has NULL
		// executed values. Naive query returns it. Filter must prevent that.
		const completed = await addSession({ ended: true });
		const open = await addSession({ ended: false });
		await addSet({
			sessionId: completed,
			executedLoad: 100,
			loggedAt: new Date(BASE_DATE)
		});
		await addSet({
			sessionId: open,
			executedLoad: null,
			executedReps: null,
			loggedAt: new Date(BASE_DATE + DAY_MS)
		});
		const result = await getLastCompletedSet(db, exerciseId, 'top', 1);
		expect(result?.executedLoad).toBe(100);
	});

	it('IGNORES newer set when its session has not ended', async () => {
		// Mirror of the above, but the newer set HAS executed values written —
		// the session just hasn't been ended. Filter must still skip it.
		const completed = await addSession({ ended: true });
		const open = await addSession({ ended: false });
		await addSet({
			sessionId: completed,
			executedLoad: 100,
			loggedAt: new Date(BASE_DATE)
		});
		await addSet({
			sessionId: open,
			executedLoad: 110,
			executedReps: 5,
			loggedAt: new Date(BASE_DATE + DAY_MS)
		});
		const result = await getLastCompletedSet(db, exerciseId, 'top', 1);
		expect(result?.executedLoad).toBe(100);
	});

	it('matches on position, not just (exercise, setRole)', async () => {
		const sId = await addSession({ ended: true });
		await addSet({ sessionId: sId, position: 1, executedLoad: 100 });
		await addSet({ sessionId: sId, position: 2, executedLoad: 80 });
		const result = await getLastCompletedSet(db, exerciseId, 'top', 2);
		expect(result?.executedLoad).toBe(80);
	});

	it('matches on setRole, not just (exercise, position)', async () => {
		const sId = await addSession({ ended: true });
		await addSet({ sessionId: sId, setRole: 'top', position: 1, executedLoad: 100 });
		await addSet({
			sessionId: sId,
			setRole: 'backoff',
			position: 2,
			executedLoad: 80
		});
		const result = await getLastCompletedSet(db, exerciseId, 'backoff', 2);
		expect(result?.executedLoad).toBe(80);
	});

	it('does not cross to a different exercise', async () => {
		const sId = await addSession({ ended: true });
		await addSet({
			sessionId: sId,
			exerciseIdOverride: otherExerciseId,
			executedLoad: 200
		});
		const result = await getLastCompletedSet(db, exerciseId, 'top', 1);
		expect(result).toBeNull();
	});

	it('excludeSessionId skips the named session', async () => {
		// Defends the past-session view: once a session ends, its own set would
		// otherwise become "the most recent completed" for that slot and the
		// "Last: …" line would duplicate the Executed line shown right above.
		const olderSession = await addSession({ ended: true });
		const currentSession = await addSession({ ended: true });
		await addSet({
			sessionId: olderSession,
			executedLoad: 100,
			loggedAt: new Date(BASE_DATE)
		});
		await addSet({
			sessionId: currentSession,
			executedLoad: 110,
			loggedAt: new Date(BASE_DATE + DAY_MS)
		});

		// Without exclusion: returns the current (newer) session's set.
		const unfiltered = await getLastCompletedSet(db, exerciseId, 'top', 1);
		expect(unfiltered?.executedLoad).toBe(110);

		// With exclusion: returns the older session's set.
		const filtered = await getLastCompletedSet(
			db,
			exerciseId,
			'top',
			1,
			currentSession
		);
		expect(filtered?.executedLoad).toBe(100);
	});

	it('returns null when excludeSessionId hides the only completed history', async () => {
		const onlySession = await addSession({ ended: true });
		await addSet({ sessionId: onlySession, executedLoad: 100 });

		const result = await getLastCompletedSet(
			db,
			exerciseId,
			'top',
			1,
			onlySession
		);
		expect(result).toBeNull();
	});

	it('returns prescribed range fields alongside executed', async () => {
		// `prescribedLoad` is intentionally NOT in the prefill result — current
		// load comes from engine output / last-executed, not the prior snapshot.
		const sId = await addSession({ ended: true });
		await client`
			INSERT INTO sets (
				session_id, exercise_id, position, set_role, target_metric,
				prescribed_load, prescribed_reps_min, prescribed_reps_max, prescribed_rir,
				executed_load, executed_reps, executed_rir
			) VALUES (
				${sId}, ${exerciseId}, 1, 'top', 'reps',
				100, 3, 5, 1,
				105, 5, 0
			)
		`;
		const result = await getLastCompletedSet(db, exerciseId, 'top', 1);
		expect(result).toEqual({
			executedLoad: 105,
			executedReps: 5,
			executedRir: 0,
			prescribedRepsMin: 3,
			prescribedRepsMax: 5,
			prescribedRir: 1
		});
	});
});

// ---------- computeConsecutiveBackwards ----------

describe('computeConsecutiveBackwards: history filter', () => {
	it('returns 0 with no history', async () => {
		expect(await computeConsecutiveBackwards(db, exerciseId, 'top', 1)).toBe(0);
	});

	it('returns 0 with only one completed session (< 2 rows)', async () => {
		await seedSessions([100]);
		expect(await computeConsecutiveBackwards(db, exerciseId, 'top', 1)).toBe(0);
	});

	it('counts 2 backwards when 3 sessions stall at the same load', async () => {
		await seedSessions([100, 100, 100]);
		expect(await computeConsecutiveBackwards(db, exerciseId, 'top', 1)).toBe(2);
	});

	it('counts a regression as backwards', async () => {
		// chronological: 100, 110, 100 → DESC: [100, 110, 100]
		// i=0: newer=100, older=110, 110 >= 100 → count=1
		// i=1: newer=110, older=100, 100 < 110 → break
		await seedSessions([100, 110, 100]);
		expect(await computeConsecutiveBackwards(db, exerciseId, 'top', 1)).toBe(1);
	});

	it('stops counting at the first advance (older < newer)', async () => {
		// chronological: 100, 100, 105, 100 → DESC: [100, 105, 100, 100]
		// i=0: backwards (105 >= 100), count=1
		// i=1: older=100 < newer=105 → break
		await seedSessions([100, 100, 105, 100]);
		expect(await computeConsecutiveBackwards(db, exerciseId, 'top', 1)).toBe(1);
	});

	it('returns 0 when most recent pair shows an advance', async () => {
		// chronological: 100, 100, 105 → DESC: [105, 100, 100]
		// i=0: older=100 < newer=105 → break, count=0
		await seedSessions([100, 100, 105]);
		expect(await computeConsecutiveBackwards(db, exerciseId, 'top', 1)).toBe(0);
	});

	it('does NOT include blank-row poisons in the count', async () => {
		// Without the filter, the newest open-session NULL row would either
		// cause a NULL comparison or be counted incorrectly. With the filter,
		// only the two completed 100-lb sessions are visible → count = 1.
		await seedSessions([100, 100]);
		const open = await addSession({ ended: false });
		await addSet({
			sessionId: open,
			executedLoad: null,
			executedReps: null,
			loggedAt: new Date(BASE_DATE + 5 * DAY_MS)
		});
		expect(await computeConsecutiveBackwards(db, exerciseId, 'top', 1)).toBe(1);
	});

	it('respects the lookback parameter', async () => {
		// 10 stalled sessions → with lookback=3, sees 3 rows → 2 backwards pairs.
		await seedSessions(Array(10).fill(100));
		expect(
			await computeConsecutiveBackwards(db, exerciseId, 'top', 1, 3)
		).toBe(2);
	});

	it('does not cross exercises', async () => {
		await seedSessions([100, 100, 100]);
		// Stalls on the wrong exercise → 0 backwards.
		expect(
			await computeConsecutiveBackwards(db, otherExerciseId, 'top', 1)
		).toBe(0);
	});
});

describe('consistency 14-day query semantics', () => {
	it('excludes open/abandoned and soft-deleted sessions', async () => {
		const ended = await addSession({ ended: true });
		await addSet({ sessionId: ended, executedLoad: 100, executedReps: 5, loggedAt: new Date() });

		const open = await addSession({ ended: false });
		await addSet({ sessionId: open, executedLoad: null, executedReps: null, loggedAt: new Date() });

		const deleted = await addSession({ ended: true });
		await addSet({ sessionId: deleted, executedLoad: 120, executedReps: 5, loggedAt: new Date() });
		await db
			.update(sessions)
			.set({ deletedAt: new Date() })
			.where(eq(sessions.id, deleted));

		const rows = await db
			.select({
				dateKey: sql<string>`to_char(${sessions.startedAt} at time zone 'UTC', 'YYYY-MM-DD')`,
				count: count(sessions.id),
			})
			.from(sessions)
			.where(
				and(
					isNull(sessions.deletedAt),
					isNotNull(sessions.endedAt),
					sql`${sessions.startedAt} >= now() - interval '14 days'`
				)
			)
			.groupBy(sql`to_char(${sessions.startedAt} at time zone 'UTC', 'YYYY-MM-DD')`);

		const total = rows.reduce((acc, r) => acc + Number(r.count), 0);
		expect(total).toBe(1);
	});
});
