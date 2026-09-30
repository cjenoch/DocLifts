import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { setupTestDb, resetTestDbWithUsers, withTwoUsers, type TestDb } from '$lib/server/test-db';

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

// Must match the module-private IMPORT_LIMIT in +page.server.ts (SvelteKit
// forbids exporting extra names from +page.server modules).
const IMPORT_LIMIT = 500;

type ImportedHistoryData = {
	workouts: { id: string; workoutDate: string | null; title: string }[];
	total: number;
	limit: number;
};
// The load reads requireUser(locals), so the test posts a signed-in owner
// the way hooks.server.ts populates it.
const callLoad = async (ownerId: string = userId): Promise<ImportedHistoryData> => {
	const result = await load({ locals: { user: { id: ownerId } } } as Parameters<typeof load>[0]);
	if (!result || typeof result !== 'object')
		throw new Error('imported-history load returned nothing');
	return result as unknown as ImportedHistoryData;
};

let harness: Awaited<ReturnType<typeof setupTestDb>>;
let user: { id: string; label: string };
let userId: string;
beforeAll(async () => {
	harness = await setupTestDb();
	testDb.db = harness.db;
});
beforeEach(async () => {
	// Reset then create the fixture user, in that order, in one call.
	[user] = await resetTestDbWithUsers(harness.db, harness.client, 1, 'imported');
	userId = user.id;
});
afterAll(async () => {
	await harness?.end();
});

async function seedImport() {
	const db = testDb.db!;
	const [imp] = await db
		.insert(s.workoutLogImports)
		.values({
			id: crypto.randomUUID(),
			userId,
			sourceSha256: crypto.randomUUID(),
			sourceName: 'notes.txt',
			sourceText: 'raw'
		})
		.returning();
	return imp.id;
}

async function seedWorkout(importId: string, sourceLine: number, workoutDate: string | null) {
	const db = testDb.db!;
	await db.insert(s.importedWorkouts).values({
		id: crypto.randomUUID(),
		importId,
		sourceLine,
		workoutDate,
		title: `Workout ${sourceLine}`,
		dateNote: 'parsed',
		lines: []
	});
}

it('returns the total alongside the workouts', async () => {
	const importId = await seedImport();
	await seedWorkout(importId, 1, '2024-03-10');
	await seedWorkout(importId, 2, '2024-05-22');
	const result = await callLoad();
	expect(result.total).toBe(2);
	expect(result.limit).toBe(IMPORT_LIMIT);
	expect(result.workouts).toHaveLength(2);
});

it('orders most-recent-first with undated workouts last', async () => {
	const importId = await seedImport();
	await seedWorkout(importId, 1, '2023-01-15');
	await seedWorkout(importId, 2, null);
	await seedWorkout(importId, 3, '2025-11-02');
	const result = await callLoad();
	expect(result.workouts.map((w) => w.workoutDate)).toEqual(['2025-11-02', '2023-01-15', null]);
});

it('caps the select at IMPORT_LIMIT and still reports the true total (L8)', async () => {
	const importId = await seedImport();
	const db = testDb.db!;
	// One batch insert: IMPORT_LIMIT + 1 rows with distinct dates.
	await db.insert(s.importedWorkouts).values(
		Array.from({ length: IMPORT_LIMIT + 1 }, (_, i) => ({
			id: crypto.randomUUID(),
			importId,
			sourceLine: i + 1,
			workoutDate: `2020-01-${String((i % 28) + 1).padStart(2, '0')}`,
			title: `Workout ${i + 1}`,
			dateNote: 'parsed',
			lines: []
		}))
	);
	const result = await callLoad();
	expect(result.workouts).toHaveLength(IMPORT_LIMIT);
	expect(result.total).toBe(IMPORT_LIMIT + 1);
});

// Cross-tenant. Positive first: Alice sees her own imported workouts, Bob
// sees none of them. Without the positive half, a predicate returning nothing
// at all would satisfy the negative.
it("returns only the requesting user's imported workouts", async () => {
	const db = testDb.db!;
	const { alice, bob } = await withTwoUsers(db);

	async function seedFor(ownerId: string, title: string) {
		const [imp] = await db
			.insert(s.workoutLogImports)
			.values({
				id: crypto.randomUUID(),
				userId: ownerId,
				sourceSha256: crypto.randomUUID(),
				sourceName: `${title}.txt`,
				sourceText: 'raw'
			})
			.returning();
		await db.insert(s.importedWorkouts).values({
			id: crypto.randomUUID(),
			importId: imp.id,
			sourceLine: 1,
			workoutDate: '2026-01-05',
			title,
			dateNote: '',
			lines: []
		});
	}

	await seedFor(alice, 'Alice Workout');
	await seedFor(bob, 'Bob Workout');

	const asAlice = await callLoad(alice);
	expect(asAlice.total).toBe(1);
	expect(asAlice.workouts.map((w) => w.title)).toEqual(['Alice Workout']);

	const asBob = await callLoad(bob);
	expect(asBob.total).toBe(1);
	expect(asBob.workouts.map((w) => w.title)).toEqual(['Bob Workout']);
	expect(asBob.workouts.some((w) => w.title === 'Alice Workout')).toBe(false);
});
