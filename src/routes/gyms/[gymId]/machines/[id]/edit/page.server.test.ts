/**
 * The machine edit route (0.3.2): the owner's POST updates the row; another
 * user's POST on the same machine is a 404 and writes nothing (D6).
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
let alice: string;
let bob: string;
let gymId: string;
let machine: typeof s.gymEquipment.$inferSelect;
beforeAll(async () => {
	harness = await setupTestDb();
	testDb.db = harness.db;
});
beforeEach(async () => {
	await resetTestDb(harness.client);
	({ alice, bob } = await withTwoUsers(harness.db));
	[{ id: gymId }] = await harness.db
		.insert(s.gyms)
		.values({ name: 'Alice Gym', userId: alice })
		.returning();
	[machine] = await harness.db
		.insert(s.gymEquipment)
		.values({ gymId, localLabel: 'Old label', equipmentType: 'cable' })
		.returning();
});
afterAll(async () => {
	await harness?.end();
});

type ActionEvent = Parameters<(typeof actions)['update']>[0];
const as = (user: string) =>
	({
		params: { gymId, id: machine.id },
		locals: { user: { id: user } } as App.Locals
	}) as Parameters<typeof load>[0];
const post = (user: string, form: Record<string, string>) => {
	const fd = new FormData();
	for (const [k, v] of Object.entries(form)) fd.append(k, v);
	return {
		request: new Request('http://test.local/', { method: 'POST', body: fd }),
		params: { gymId, id: machine.id },
		locals: { user: { id: user } } as App.Locals
	} as unknown as ActionEvent;
};
const reread = async () =>
	(await harness.db.select().from(s.gymEquipment).where(eq(s.gymEquipment.id, machine.id)))[0];

it("the owner edits their machine; another user's POST is a 404 and changes nothing", async () => {
	await expect(load(as(alice))).resolves.toMatchObject({ machine: { id: machine.id } });
	await expect(
		actions.update(post(alice, { localLabel: 'New label', stackLb: '150', incrementLb: '' }))
	).rejects.toMatchObject({ status: 303, location: `/gyms?gym=${gymId}` });
	const mine = await reread();
	expect(mine).toMatchObject({ localLabel: 'New label', stackLb: 150, incrementLb: null });

	await expect(load(as(bob))).rejects.toMatchObject({ status: 404 });
	await expect(
		actions.update(post(bob, { localLabel: 'Bob was here', stackLb: '10' }))
	).resolves.toMatchObject({ status: 404, data: { message: 'Machine not found' } });
	expect(await reread()).toEqual(mine);
});

it('a blank label with no model, or a zero stack, is a 400 with the reason', async () => {
	await expect(actions.update(post(alice, { localLabel: '' }))).resolves.toMatchObject({
		status: 400,
		data: {
			message: 'Give the machine a label, or choose its model so the label can be taken from it'
		}
	});
	await expect(
		actions.update(post(alice, { localLabel: 'X', stackLb: '0' }))
	).resolves.toMatchObject({ status: 400 });
	expect(await reread()).toEqual(machine);
});
