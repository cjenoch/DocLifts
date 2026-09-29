import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { setupTestDb, resetTestDb, type TestDb } from '$lib/server/test-db';

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
	workouts: { id: string; workoutDate: string | null }[];
	total: number;
	limit: number;
};
const callLoad = async (): Promise<ImportedHistoryData> => {
	const result = await load({} as Parameters<typeof load>[0]);
	if (!result || typeof result !== 'object')
		throw new Error('imported-history load returned nothing');
	return result as unknown as ImportedHistoryData;
};

let harness: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
	harness = await setupTestDb();
	testDb.db = harness.db;
});
beforeEach(async () => {
	await resetTestDb(harness.client);
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
