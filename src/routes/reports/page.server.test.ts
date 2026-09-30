import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { setupTestDb, resetTestDbWithUsers, type TestDb } from '$lib/server/test-db';
import { endSession, startSessionForDay, updateSetInSession } from '$lib/server/sessions';

const testDb = vi.hoisted(() => ({ db: null as TestDb | null }));
vi.mock('$lib/server/db', async () => {
	const schema = await import('$lib/server/db/schema');
	return {
		get db() {
			return testDb.db;
		},
		...schema
	};
});

import { load } from './+page.server';
import * as s from '$lib/server/db/schema';

let harness: Awaited<ReturnType<typeof setupTestDb>>;
let user: { id: string; label: string };
let userId: string;
beforeAll(async () => {
	harness = await setupTestDb();
	testDb.db = harness.db;
});
beforeEach(async () => {
	// Reset then create the fixture user, in that order, in one call.
	[user] = await resetTestDbWithUsers(harness.db, harness.client, 1, 'reports');
	userId = user.id;
});
afterAll(async () => {
	await harness?.end();
});

async function endedSessionWithCompletedSets() {
	const db = testDb.db!;
	const [program] = await db.insert(s.programs).values({ name: 'P' }).returning();
	const [day] = await db
		.insert(s.days)
		.values({ programId: program.id, name: 'D', position: 1 })
		.returning();
	const [exercise] = await db
		.insert(s.exercises)
		.values({ name: 'Press', canonicalMovement: 'chest_press', equipmentType: 'machine-plate' })
		.returning();
	const [dx] = await db
		.insert(s.dayExercises)
		.values({ dayId: day.id, exerciseId: exercise.id, position: 1, tier: 'secondary' })
		.returning();
	await db.insert(s.prescribedSets).values(
		[1, 2].map((position) => ({
			dayExerciseId: dx.id,
			position,
			setRole: 'working' as const,
			targetRepsMin: 8,
			targetRepsMax: 10,
			targetRir: 1,
			initialLoad: 50
		}))
	);
	const started = await startSessionForDay(db, userId, day.id);
	if (!started.ok) throw new Error(started.message);
	const rows = await db
		.select()
		.from(s.sets)
		.where(eq(s.sets.sessionId, started.sessionId))
		.orderBy(asc(s.sets.position));
	for (const row of rows) {
		const updated = await updateSetInSession(db, userId, started.sessionId, row.id, {
			executedLoad: 100,
			executedReps: 10,
			executedRir: 1,
			notes: null
		});
		if (!updated.ok) throw new Error(updated.message);
	}
	await endSession(db, userId, started.sessionId);
	return started.sessionId;
}

type ReportsData = {
	overview: {
		totalSessions: number;
		endedSessions: number;
		openSessions: number;
		totalEndedSetRows: number;
		completedEndedSetRows: number;
		completionRatePct: number;
		last7Sessions: number;
		last28Sessions: number;
	};
	consistency: { dateKey: string; count: number }[];
	recentTrend: {
		sessionId: string;
		totalSets: number;
		completedSets: number;
		completionPct: number;
	}[];
};
const callLoad = async (): Promise<ReportsData> => {
	const result = await load({} as Parameters<typeof load>[0]);
	if (!result || typeof result !== 'object') throw new Error('reports load returned nothing');
	return result as unknown as ReportsData;
};

it('reports zeros on an empty database', async () => {
	const result = await callLoad();
	expect(result.overview).toMatchObject({
		totalSessions: 0,
		endedSessions: 0,
		openSessions: 0,
		totalEndedSetRows: 0,
		completedEndedSetRows: 0,
		completionRatePct: 0,
		last7Sessions: 0,
		last28Sessions: 0
	});
	expect(result.consistency).toHaveLength(14);
	expect(result.recentTrend).toEqual([]);
});

it('counts an ended session and its completed sets', async () => {
	const sessionId = await endedSessionWithCompletedSets();
	const result = await callLoad();
	expect(result.overview).toMatchObject({
		totalSessions: 1,
		endedSessions: 1,
		openSessions: 0,
		totalEndedSetRows: 2,
		completedEndedSetRows: 2,
		completionRatePct: 100,
		last7Sessions: 1,
		last28Sessions: 1
	});
	expect(result.recentTrend).toHaveLength(1);
	expect(result.recentTrend[0]).toMatchObject({
		sessionId,
		totalSets: 2,
		completedSets: 2,
		completionPct: 100
	});
	const today = new Date().toISOString().slice(0, 10);
	expect(result.consistency.find((d) => d.dateKey === today)?.count).toBe(1);
});
