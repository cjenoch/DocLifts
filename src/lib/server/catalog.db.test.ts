/**
 * Model reads with the real catalog loaded: global + own, never another
 * user's (spec 0.3.0 A3–A6).
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { setupTestDb, resetTestDb, withTwoUsers, type TestDb } from './test-db';
import * as s from './db/schema';
import { importCatalog } from './catalog-import';
import { createGym, createMachine, machineChoices } from './machines';

const csv = readFileSync('data/catalog/equipment_models_seed_2026-09-30.csv', 'utf8');

let db: TestDb;
let handle: Awaited<ReturnType<typeof setupTestDb>>;
let alice: string;
let bob: string;
let alicesModelId: string;
beforeAll(async () => {
	handle = await setupTestDb();
	db = handle.db;
});
afterAll(async () => {
	await handle?.end();
});
beforeEach(async () => {
	await resetTestDb(handle.client);
	({ alice, bob } = await withTwoUsers(db));
	const result = await importCatalog(db, csv, { dryRun: false });
	expect(result.failed).toBe(false);
	const [mine] = await db
		.insert(s.equipmentModels)
		.values({
			manufacturer: 'Hammer Strength',
			code: 'IL-ROW',
			name: "Alice's corrected row",
			loadingType: 'machine-plate',
			ownerUserId: alice
		})
		.returning();
	alicesModelId = mine.id;
});

describe('A3: reads are global + own', () => {
	it('machineChoices: both users see all 543 global rows; only Alice sees her own', async () => {
		const mine = await machineChoices(db, alice);
		expect(mine.models).toHaveLength(544); // positive first
		expect(mine.models.some((m) => m.id === alicesModelId)).toBe(true);

		const theirs = await machineChoices(db, bob);
		expect(theirs.models).toHaveLength(543);
		expect(theirs.models.some((m) => m.id === alicesModelId)).toBe(false);
		expect(theirs.models.every((m) => m.ownerUserId === null)).toBe(true);
	});

	it("createMachine: a global model works for Bob, Alice's own model does not", async () => {
		const bobsGym = await createGym(db, bob, { name: 'Bob gym' });
		const [global] = await db
			.select()
			.from(s.equipmentModels)
			.where(
				and(
					eq(s.equipmentModels.manufacturer, 'Hammer Strength'),
					eq(s.equipmentModels.code, 'IL-ROW')
				)
			)
			.then((rows) => rows.filter((r) => r.ownerUserId === null));
		const made = await createMachine(db, bob, {
			gymId: bobsGym.id,
			localLabel: 'Row',
			equipmentType: 'machine-plate',
			equipmentModelId: global.id
		});
		expect(made.equipmentModelId).toBe(global.id);
		await expect(
			createMachine(db, bob, {
				gymId: bobsGym.id,
				localLabel: 'Not his',
				equipmentType: 'machine-plate',
				equipmentModelId: alicesModelId
			})
		).rejects.toThrow('Model loading type does not match machine');
	});
});
