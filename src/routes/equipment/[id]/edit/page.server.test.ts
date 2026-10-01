/**
 * /equipment/[id]/edit (spec 0.3.0 A6): owned rows are edited in place;
 * global catalog rows never are — they are copied into an owned row.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { setupTestDb, resetTestDb, withTwoUsers, type TestDb } from '$lib/server/test-db';

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

import { actions, load } from './+page.server';
import * as s from '$lib/server/db/schema';

let harness: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
	harness = await setupTestDb();
	testDb.db = harness.db;
});
afterAll(async () => {
	await harness?.end();
});

let alice: string;
let bob: string;
let global: typeof s.equipmentModels.$inferSelect;
let alicesOwn: typeof s.equipmentModels.$inferSelect;
beforeEach(async () => {
	await resetTestDb(harness.client);
	({ alice, bob } = await withTwoUsers(harness.db));
	[global] = await harness.db
		.insert(s.equipmentModels)
		.values({
			manufacturer: 'Hammer Strength',
			productLine: 'Plate Loaded',
			code: 'IL-ROW',
			name: 'Iso-Lateral Row',
			loadingType: 'machine-plate',
			laterality: 'independent',
			bodyRegion: 'back',
			startingResistance: 12,
			startingResistanceBasis: 'per_arm',
			confidence: 'manufacturer_page',
			sourceUrl: 'https://example.invalid/catalog',
			catalogSnapshot: '2026-09-30'
		})
		.returning();
	[alicesOwn] = await harness.db
		.insert(s.equipmentModels)
		.values({
			manufacturer: 'Custom',
			name: 'Garage press',
			loadingType: 'machine-plate',
			ownerUserId: alice
		})
		.returning();
});

const as = (user: string, id: string) =>
	({ params: { id }, locals: { user: { id: user } } as App.Locals }) as Parameters<typeof load>[0];
type ActionEvent = Parameters<(typeof actions)['update']>[0];
const post = (user: string, id: string, form: Record<string, string>) => {
	const fd = new FormData();
	for (const [k, v] of Object.entries(form)) fd.append(k, v);
	return {
		request: new Request('http://test.local/', { method: 'POST', body: fd }),
		params: { id },
		locals: { user: { id: user } } as App.Locals
	} as unknown as ActionEvent;
};
const reread = async (id: string) =>
	(await testDb.db!.select().from(s.equipmentModels).where(eq(s.equipmentModels.id, id)))[0];
const fields = {
	startingResistance: '20',
	startingResistanceBasis: 'total',
	laterality: 'bilateral'
};

it('the owner edits their own model in place', async () => {
	await expect(load(as(alice, alicesOwn.id))).resolves.toMatchObject({ editable: true });
	await expect(actions.update(post(alice, alicesOwn.id, fields))).rejects.toMatchObject({
		status: 303,
		location: `/equipment/${alicesOwn.id}`
	});
	expect(await reread(alicesOwn.id)).toMatchObject({
		startingResistance: 20,
		startingResistanceBasis: 'total',
		laterality: 'bilateral',
		ownerUserId: alice
	});
});

it('a global row is not editable in place: update is a 404 and changes nothing', async () => {
	await expect(load(as(alice, global.id))).resolves.toMatchObject({ editable: false });
	await expect(actions.update(post(alice, global.id, fields))).resolves.toMatchObject({
		status: 404
	});
	expect(await reread(global.id)).toEqual(global);
});

it('create my own copy: a new owned row with my values; the catalog row is untouched', async () => {
	let location = '';
	try {
		await actions.copy(post(alice, global.id, fields));
	} catch (r) {
		location = (r as { location: string }).location;
	}
	const copyId = location.replace('/equipment/', '');
	expect(copyId).not.toBe(global.id);
	expect(await reread(copyId)).toMatchObject({
		manufacturer: 'Hammer Strength',
		code: 'IL-ROW',
		name: 'Iso-Lateral Row',
		loadingType: 'machine-plate',
		bodyRegion: 'back',
		startingResistance: 20,
		startingResistanceBasis: 'total',
		laterality: 'bilateral',
		confidence: 'user',
		sourceUrl: null,
		catalogSnapshot: null,
		ownerUserId: alice
	});
	expect(await reread(global.id)).toEqual(global);
	// The copy is Alice's: Bob cannot see it.
	await expect(load(as(alice, copyId))).resolves.toMatchObject({ editable: true });
	await expect(load(as(bob, copyId))).rejects.toMatchObject({ status: 404 });
});

it("another user's owned row is a 404 everywhere, and unchanged", async () => {
	await expect(load(as(alice, alicesOwn.id))).resolves.toBeTruthy(); // positive first
	await expect(load(as(bob, alicesOwn.id))).rejects.toMatchObject({ status: 404 });
	await expect(actions.update(post(bob, alicesOwn.id, fields))).resolves.toMatchObject({
		status: 404
	});
	await expect(actions.copy(post(bob, alicesOwn.id, fields))).resolves.toMatchObject({
		status: 404
	});
	expect(await reread(alicesOwn.id)).toEqual(alicesOwn);
	const bobsRows = await testDb
		.db!.select()
		.from(s.equipmentModels)
		.where(eq(s.equipmentModels.ownerUserId, bob));
	expect(bobsRows).toEqual([]);
});

it('a resistance without a basis is refused', async () => {
	await expect(
		actions.update(
			post(alice, alicesOwn.id, {
				startingResistance: '20',
				startingResistanceBasis: '',
				laterality: 'bilateral'
			})
		)
	).resolves.toMatchObject({ status: 400 });
	expect(await reread(alicesOwn.id)).toEqual(alicesOwn);
});
