/**
 * /equipment and /equipment/[id] (spec 0.3.0 A4), with the real 543-row
 * catalog imported once for the file.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { setupTestDb, resetTestDb, withTwoUsers, type TestDb } from '$lib/server/test-db';
import { importCatalog, mapCatalogCsv } from '$lib/server/catalog-import';
import type { browseFacets, browseModels } from '$lib/server/catalog';

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

import { load as browse } from './+page.server';
import { load as detail, actions } from './[id]/+page.server';
import * as s from '$lib/server/db/schema';

const csv = readFileSync('data/catalog/equipment_models_seed_2026-09-30.csv', 'utf8');

let harness: Awaited<ReturnType<typeof setupTestDb>>;
let alice: string;
let bob: string;
let alicesModelId: string;
let ilRowId: string;
let alicesGymId: string;
let bobsGymId: string;
beforeAll(async () => {
	harness = await setupTestDb();
	testDb.db = harness.db;
	await resetTestDb(harness.client);
	({ alice, bob } = await withTwoUsers(harness.db));
	expect((await importCatalog(harness.db, csv, { dryRun: false })).failed).toBe(false);
	const db = harness.db;
	[{ id: alicesModelId }] = await db
		.insert(s.equipmentModels)
		.values({
			manufacturer: 'Hammer Strength',
			code: 'MY-PRESS',
			name: 'Alice private press',
			loadingType: 'machine-plate',
			ownerUserId: alice
		})
		.returning();
	[{ id: ilRowId }] = await db
		.select()
		.from(s.equipmentModels)
		.where(
			and(
				eq(s.equipmentModels.manufacturer, 'Hammer Strength'),
				eq(s.equipmentModels.code, 'IL-ROW')
			)
		);
	[{ id: alicesGymId }] = await db
		.insert(s.gyms)
		.values({ name: 'Home', userId: alice })
		.returning();
	[{ id: bobsGymId }] = await db
		.insert(s.gyms)
		.values({ name: 'Bob gym', userId: bob })
		.returning();
});
afterAll(async () => {
	await harness?.end();
});

type BrowseEvent = Parameters<typeof browse>[0];
const list = (as: string, query = '') =>
	browse({
		url: new URL(`http://test.local/equipment?${query}`),
		locals: { user: { id: as } } as App.Locals
	} as BrowseEvent) as Promise<
		Awaited<ReturnType<typeof browseModels>> & {
			facets: Awaited<ReturnType<typeof browseFacets>>;
		}
	>;
type DetailEvent = Parameters<typeof detail>[0];
const show = (as: string, id: string) =>
	detail({ params: { id }, locals: { user: { id: as } } as App.Locals } as DetailEvent);
type ActionEvent = Parameters<(typeof actions)['addToGym']>[0];
const addToGym = (as: string, id: string, form: Record<string, string>) => {
	const fd = new FormData();
	for (const [k, v] of Object.entries(form)) fd.append(k, v);
	return actions.addToGym({
		request: new Request('http://test.local/', { method: 'POST', body: fd }),
		params: { id },
		locals: { user: { id: as } } as App.Locals
	} as unknown as ActionEvent);
};

/** Expected counts straight from the CSV, so the test does not restate the data. */
const seed = mapCatalogCsv(csv).rows.map((r) => r.fields);

describe('/equipment filters', () => {
	it('lists every global row to a user with none of their own', async () => {
		const page = await list(bob);
		expect(page.total).toBe(543);
		expect(page.rows).toHaveLength(50);
		expect(page.pages).toBe(11);
	});

	it('manufacturer narrows, and includes only the viewer’s own rows', async () => {
		const hammer = seed.filter((r) => r.manufacturer === 'Hammer Strength').length;
		const mine = await list(alice, 'manufacturer=Hammer+Strength');
		expect(mine.total).toBe(hammer + 1); // positive first: Alice sees her own
		expect(mine.rows.every((r) => r.manufacturer === 'Hammer Strength')).toBe(true);
		const theirs = await list(bob, 'manufacturer=Hammer+Strength');
		expect(theirs.total).toBe(hammer);
		expect(theirs.facets.lines.length).toBeGreaterThan(1);
	});

	it('product line, loading type and body region each narrow', async () => {
		const line = await list(bob, 'manufacturer=Hammer+Strength&line=Select');
		expect(line.total).toBe(
			seed.filter((r) => r.manufacturer === 'Hammer Strength' && r.productLine === 'Select').length
		);
		expect(line.total).toBeGreaterThan(0);
		const cable = await list(bob, 'loadingType=cable');
		expect(cable.total).toBe(seed.filter((r) => r.loadingType === 'cable').length);
		const glutes = await list(bob, 'bodyRegion=glutes');
		expect(glutes.total).toBe(seed.filter((r) => r.bodyRegion === 'glutes').length);
		expect(glutes.rows.every((r) => r.bodyRegion === 'glutes')).toBe(true);
	});

	it('q matches a model code, case-insensitively', async () => {
		const page = await list(bob, 'q=il-row');
		expect(page.rows.map((r) => r.code)).toEqual(['IL-ROW']);
	});

	it('q matches a name fragment', async () => {
		const expected = seed.filter(
			(r) =>
				r.name.toLowerCase().includes('leg press') ||
				(r.code ?? '').toLowerCase().includes('leg press')
		).length;
		const page = await list(bob, 'q=Leg+Press');
		expect(expected).toBeGreaterThan(1);
		expect(page.total).toBe(expected);
	});

	it('q treats % and _ as literal characters', async () => {
		expect((await list(bob, 'q=%25')).total).toBe(0);
		expect((await list(bob, 'q=_')).total).toBe(0);
	});

	it('pages are disjoint, cover every row, and past-the-end clamps', async () => {
		const ids = new Set<string>();
		for (let p = 1; p <= 11; p++)
			for (const r of (await list(bob, `page=${p}`)).rows) ids.add(r.id);
		expect(ids.size).toBe(543);
		const last = await list(bob, 'page=11');
		expect(last.rows).toHaveLength(543 - 500);
		const past = await list(bob, 'page=99');
		expect(past.page).toBe(11);
		expect(past.rows.map((r) => r.id)).toEqual(last.rows.map((r) => r.id));
	});

	it('malformed parameters are dropped, not errors', async () => {
		const page = await list(bob, 'loadingType=hydraulic&page=abc');
		expect(page.total).toBe(543);
		expect(page.page).toBe(1);
	});
});

describe('/equipment/[id]', () => {
	it("another user's model is a 404, like a missing id; a global one is visible to all", async () => {
		await expect(show(alice, alicesModelId)).resolves.toMatchObject({
			model: { id: alicesModelId }
		}); // positive first
		await expect(show(bob, alicesModelId)).rejects.toMatchObject({ status: 404 });
		await expect(show(bob, crypto.randomUUID())).rejects.toMatchObject({ status: 404 });
		await expect(show(bob, 'not-a-uuid')).rejects.toMatchObject({ status: 404 });
		await expect(show(alice, ilRowId)).resolves.toMatchObject({ model: { code: 'IL-ROW' } });
		await expect(show(bob, ilRowId)).resolves.toMatchObject({ model: { code: 'IL-ROW' } });
	});

	it('add to a gym creates the instance in that gym, visible only to its owner', async () => {
		const result = await addToGym(alice, ilRowId, {
			gymId: alicesGymId,
			localLabel: 'Row by the window',
			stackLb: '',
			incrementLb: '5'
		});
		expect(result).toEqual({ message: 'Added to your gym' });
		const rows = await testDb
			.db!.select()
			.from(s.gymEquipment)
			.where(eq(s.gymEquipment.localLabel, 'Row by the window'));
		expect(rows).toEqual([
			expect.objectContaining({
				gymId: alicesGymId,
				equipmentModelId: ilRowId,
				equipmentType: 'machine-plate',
				stackLb: null,
				incrementLb: 5
			})
		]);
		const alicesView = (await show(alice, ilRowId)) as { instances: { gymName: string }[] };
		expect(alicesView.instances.map((i) => i.gymName)).toEqual(['Home']);
		const bobsView = (await show(bob, ilRowId)) as { instances: unknown[]; gyms: unknown[] };
		expect(bobsView.instances).toEqual([]);
		expect(bobsView.gyms).toHaveLength(1);
	});

	it("refuses another user's gym, and another user's model, writing nothing", async () => {
		const before = (await testDb.db!.select().from(s.gymEquipment)).length;
		await expect(
			addToGym(alice, ilRowId, { gymId: bobsGymId, localLabel: 'Trespass' })
		).resolves.toMatchObject({ status: 400, data: { message: 'Gym not found' } });
		await expect(
			addToGym(bob, alicesModelId, { gymId: bobsGymId, localLabel: 'Not his' })
		).resolves.toMatchObject({ status: 404 });
		await expect(
			addToGym(alice, ilRowId, { gymId: alicesGymId, localLabel: 'Bad stack', stackLb: '0' })
		).resolves.toMatchObject({ status: 400 });
		expect((await testDb.db!.select().from(s.gymEquipment)).length).toBe(before);
	});
});
