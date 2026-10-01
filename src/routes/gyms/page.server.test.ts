import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
	createTestUser,
	setupTestDb,
	resetTestDb,
	withTwoUsers,
	type TestDb
} from '$lib/server/test-db';

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
beforeEach(async () => {
	await resetTestDb(harness.client);
	userId = await createTestUser(harness.db, 'gyms-route');
});
afterAll(async () => {
	await harness?.end();
});

type ActionEvent = Parameters<(typeof actions)['createGym']>[0];

// The actions call requireUser(locals), so every posted event carries a signed-in
// user — the same shape hooks.server.ts populates. Recreated per test because
// resetTestDb() truncates auth.user.
let userId: string;
const postAs =
	(as: string) =>
	(form: Record<string, string>): ActionEvent => {
		const fd = new FormData();
		for (const [k, v] of Object.entries(form)) fd.append(k, v);
		return {
			request: new Request('http://test.local/', { method: 'POST', body: fd }),
			params: {},
			locals: { user: { id: as } } as App.Locals
		} as unknown as ActionEvent;
	};
const post = (form: Record<string, string>): ActionEvent => postAs(userId)(form);

it('createGym creates a gym and confirms', async () => {
	const result = await actions.createGym(post({ name: 'Downtown' }));
	expect(result).toEqual({ message: 'Gym created' });
	const rows = await testDb.db!.select().from(s.gyms).where(eq(s.gyms.name, 'Downtown'));
	expect(rows).toHaveLength(1);
});

it('createGym maps an empty name to 400', async () => {
	const result = await actions.createGym(post({ name: '' }));
	expect(result).toMatchObject({ status: 400 });
	const rows = await testDb.db!.select().from(s.gyms);
	expect(rows).toHaveLength(0);
});

it('createMachine maps an unknown gym to 400', async () => {
	const result = await actions.createMachine(
		post({ gymId: randomUUID(), localLabel: 'Press', equipmentType: 'machine-plate' })
	);
	expect(result).toMatchObject({ status: 400, data: { message: 'Gym not found' } });
});

it('createMachine maps invalid input to 400', async () => {
	const result = await actions.createMachine(post({}));
	expect(result).toMatchObject({ status: 400 });
});

it('createMachine creates a machine and confirms', async () => {
	const created = await actions.createGym(post({ name: 'Garage' }));
	expect(created).toEqual({ message: 'Gym created' });
	const [gym] = await testDb.db!.select().from(s.gyms).where(eq(s.gyms.name, 'Garage'));
	const result = await actions.createMachine(
		post({ gymId: gym.id, localLabel: 'Lat Pulldown', equipmentType: 'cable' })
	);
	expect(result).toEqual({ message: 'Machine created' });
	const rows = await testDb
		.db!.select()
		.from(s.gymEquipment)
		.where(eq(s.gymEquipment.gymId, gym.id));
	expect(rows).toHaveLength(1);
	expect(rows[0].localLabel).toBe('Lat Pulldown');
});

// 0.3.2: the label may be blank when a model is chosen; with no model it is
// refused with a message the page shows.
it('createMachine: blank label takes the model name; blank and no model is a 400', async () => {
	await actions.createGym(post({ name: 'Garage' }));
	const db = testDb.db!;
	const [gym] = await db.select().from(s.gyms).where(eq(s.gyms.name, 'Garage'));
	const refused = await actions.createMachine(
		post({ gymId: gym.id, localLabel: '', equipmentType: 'cable', equipmentModelId: '' })
	);
	expect(refused).toMatchObject({
		status: 400,
		data: {
			message: 'Give the machine a label, or choose its model so the label can be taken from it'
		}
	});
	expect(await db.select().from(s.gymEquipment)).toHaveLength(0);

	const [model] = await db
		.insert(s.equipmentModels)
		.values({ manufacturer: 'Nautilus', name: 'Leverage Row', loadingType: 'machine-plate' })
		.returning();
	const made = await actions.createMachine(
		post({
			gymId: gym.id,
			localLabel: '',
			equipmentType: 'machine-plate',
			equipmentModelId: model.id
		})
	);
	expect(made).toEqual({ message: 'Machine created' });
	const rows = await db.select().from(s.gymEquipment).where(eq(s.gymEquipment.gymId, gym.id));
	expect(rows.map((r) => r.localLabel)).toEqual(['Nautilus Leverage Row']);
});

// Cross-tenant: another user's gym is reported exactly as a nonexistent one —
// 'Gym not found', the module's existing message. No 403, no distinct wording
// (D6), so a caller cannot probe for the existence of someone else's gym.
it("createMachine treats another user's gym as not found", async () => {
	const { alice, bob } = await withTwoUsers(harness.db);
	const created = await actions.createGym(postAs(alice)({ name: 'Alice Gym' }));
	expect(created).toEqual({ message: 'Gym created' });
	const [gym] = await testDb.db!.select().from(s.gyms).where(eq(s.gyms.name, 'Alice Gym'));

	const result = await actions.createMachine(
		postAs(bob)({ gymId: gym.id, localLabel: 'Sneaky', equipmentType: 'machine-plate' })
	);
	expect(result).toMatchObject({ status: 400, data: { message: 'Gym not found' } });

	// Same message as a gym that never existed, and nothing written.
	const missing = await actions.createMachine(
		postAs(bob)({ gymId: randomUUID(), localLabel: 'Sneaky', equipmentType: 'machine-plate' })
	);
	expect(result).toEqual(missing);
	expect(await testDb.db!.select().from(s.gymEquipment)).toHaveLength(0);
});

it('createGym writes the caller as the owner', async () => {
	const { alice } = await withTwoUsers(harness.db);
	await actions.createGym(postAs(alice)({ name: 'Owned' }));
	const [gym] = await testDb.db!.select().from(s.gyms).where(eq(s.gyms.name, 'Owned'));
	expect(gym.userId).toBe(alice);
});

// 0.3.0 A5: the model list is narrowed by GET parameters, server-side.
it('load narrows the model list to the selected gym, with all=1 and q to widen', async () => {
	const db = testDb.db!;
	const models = await db
		.insert(s.equipmentModels)
		.values([
			{
				manufacturer: 'Hammer Strength',
				code: 'IL-ROW',
				name: 'Iso-Lateral Row',
				loadingType: 'machine-plate'
			},
			{
				manufacturer: 'Hammer Strength',
				code: 'IL-HBP',
				name: 'Bench Press',
				loadingType: 'machine-plate'
			},
			{ manufacturer: 'Matrix', code: 'G3-S10', name: 'Chest Press', loadingType: 'machine-stack' }
		])
		.returning();
	const [gym] = await db.insert(s.gyms).values({ name: 'A gym', userId }).returning();
	await db.insert(s.gymEquipment).values({
		gymId: gym.id,
		localLabel: 'Row',
		equipmentType: 'machine-plate',
		equipmentModelId: models[0].id
	});
	const view = async (query: string) =>
		(await load({
			url: new URL(`http://test.local/gyms?${query}`),
			locals: { user: { id: userId } } as App.Locals
		} as Parameters<typeof load>[0])) as {
			models: { code: string | null }[];
			selectedGymId: string;
			scope: string;
		};
	// No `gym` parameter: the first gym is chosen, and narrowed to its makers.
	const first = await view('');
	expect(first.selectedGymId).toBe(gym.id);
	expect(first.models.map((m) => m.code).sort()).toEqual(['IL-HBP', 'IL-ROW']);
	expect((await view(`gym=${gym.id}&all=1`)).models).toHaveLength(3);
	expect((await view(`gym=${gym.id}&q=G3-S10`)).models.map((m) => m.code)).toEqual(['G3-S10']);
	// A malformed gym id falls back to the first gym rather than erroring.
	expect((await view('gym=nope')).selectedGymId).toBe(gym.id);
});
