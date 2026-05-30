import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { and, count, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { resetTestDb, setupTestDb, type TestDb } from './test-db';
import { endSession, softDeleteEndedSession, startSessionForDay } from './sessions';
import {
	dayExercises,
	days,
	exercises,
	prescribedSets,
	programs,
	sessions,
	sets
} from './db/schema';

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

async function seedDay() {
	const [program] = await db.insert(programs).values({ name: 'Reports Program' }).returning();
	const [day] = await db
		.insert(days)
		.values({ programId: program.id, name: 'A', position: 1 })
		.returning();
	const [exercise] = await db
		.insert(exercises)
		.values({
			name: `Rows-${crypto.randomUUID().slice(0, 8)}`,
			equipmentType: 'bodyweight'
		})
		.returning();
	const [dx] = await db
		.insert(dayExercises)
		.values({ dayId: day.id, exerciseId: exercise.id, position: 1, tier: 'main' })
		.returning();
	await db.insert(prescribedSets).values({
		dayExerciseId: dx.id,
		position: 1,
		setRole: 'top',
		targetMetric: 'reps',
		targetRepsMin: 3,
		targetRepsMax: 5,
		targetRir: 1,
		initialLoad: 100
	});
	return { dayId: day.id };
}

describe('reports consistency', () => {
	it('excludes open/abandoned and soft-deleted sessions from 14-day consistency query', async () => {
		const { dayId } = await seedDay();

		// Abandoned/open session: must NOT count.
		// Ended active session: should count.
		const ended = await startSessionForDay(db, dayId);
		expect(ended.ok).toBe(true);
		if (!ended.ok) return;
		await db
			.update(sets)
			.set({ executedLoad: 100, executedReps: 5, executedRir: 1 })
			.where(eq(sets.sessionId, ended.sessionId));
		await endSession(db, ended.sessionId);

		// Ended + soft-deleted session: must NOT count.
		const deleted = await startSessionForDay(db, dayId);
		expect(deleted.ok).toBe(true);
		if (!deleted.ok) return;
		await db
			.update(sets)
			.set({ executedLoad: 100, executedReps: 5, executedRir: 1 })
			.where(eq(sets.sessionId, deleted.sessionId));
		await endSession(db, deleted.sessionId);
		await softDeleteEndedSession(db, deleted.sessionId);

		// Abandoned/open session: must NOT count.
		const openStarted = await startSessionForDay(db, dayId);
		expect(openStarted.ok).toBe(true);
		if (!openStarted.ok) return;

		const [windowCount] = await db
			.select({
				count: count(sessions.id)
			})
			.from(sessions)
			.where(
				and(
					isNull(sessions.deletedAt),
					isNotNull(sessions.endedAt),
					sql`${sessions.startedAt} >= now() - interval '14 days'`
				)
			);

		expect(Number(windowCount.count)).toBe(1);

		const [openCount] = await db
			.select({ count: count(sessions.id) })
			.from(sessions)
			.where(and(eq(sessions.id, openStarted.sessionId), isNull(sessions.endedAt), isNull(sessions.deletedAt)));
		expect(Number(openCount.count)).toBe(1);
	});
});
