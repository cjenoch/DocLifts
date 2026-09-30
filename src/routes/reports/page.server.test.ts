import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { setupTestDb, resetTestDbWithUsers, withTwoUsers, type TestDb } from '$lib/server/test-db';
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
	const [program] = await db.insert(s.programs).values({ userId, name: 'P' }).returning();
	const [day] = await db
		.insert(s.days)
		.values({ programId: program.id, name: 'D', position: 1 })
		.returning();
	const [exercise] = await db
		.insert(s.exercises)
		.values({
			userId,
			name: 'Press',
			canonicalMovement: 'chest_press',
			equipmentType: 'machine-plate'
		})
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
// The load reads requireUser(locals), so the test posts a signed-in owner
// the way hooks.server.ts populates it.
const callLoad = async (ownerId: string = userId): Promise<ReportsData> => {
	const result = await load({ locals: { user: { id: ownerId } } } as Parameters<typeof load>[0]);
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

// The page's six queries all live in reportSnapshot, owner-scoped. Before (h)
// every one of them ran with no owner predicate, so /reports counted the whole
// database. Positive first: Alice sees her own session counted, and Bob sees
// none of it.
it("counts only the requesting user's sessions", async () => {
	const db = testDb.db!;
	const { alice, bob } = await withTwoUsers(db);

	async function seedEndedSession(ownerId: string) {
		const [p] = await db.insert(s.programs).values({ userId: ownerId, name: 'P' }).returning();
		const [d] = await db
			.insert(s.days)
			.values({ programId: p.id, name: 'D', position: 1 })
			.returning();
		const [e] = await db
			.insert(s.exercises)
			.values({
				userId: ownerId,
				name: 'Press',
				canonicalMovement: 'chest_press',
				equipmentType: 'machine-plate'
			})
			.returning();
		const [dx] = await db
			.insert(s.dayExercises)
			.values({ dayId: d.id, exerciseId: e.id, position: 1, tier: 'secondary' })
			.returning();
		await db.insert(s.prescribedSets).values({
			dayExerciseId: dx.id,
			position: 1,
			setRole: 'working',
			targetMetric: 'reps',
			targetRepsMin: 8,
			targetRepsMax: 12,
			targetRir: 2,
			initialLoad: 100
		});
		const started = await startSessionForDay(db, ownerId, d.id);
		expect(started.ok).toBe(true);
		if (!started.ok) return;
		const [row] = await db.select().from(s.sets).where(eq(s.sets.sessionId, started.sessionId));
		await endSession(db, ownerId, started.sessionId);
		await updateSetInSession(db, ownerId, started.sessionId, row.id, {
			executedLoad: 100,
			executedReps: 10,
			executedRir: 1,
			notes: null
		});
	}

	await seedEndedSession(alice);

	const asAlice = await callLoad(alice);
	expect(asAlice.overview.totalSessions).toBe(1);
	expect(asAlice.recentTrend).toHaveLength(1);

	const asBob = await callLoad(bob);
	expect(asBob.overview.totalSessions).toBe(0);
	expect(asBob.recentTrend).toEqual([]);
	expect(asBob.consistency.every((d) => d.count === 0)).toBe(true);
});
