import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
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

import { actions } from './+page.server';
import * as s from '$lib/server/db/schema';

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

type ActionEvent = Parameters<(typeof actions)['createGym']>[0];
const post = (form: Record<string, string>): ActionEvent => {
	const fd = new FormData();
	for (const [k, v] of Object.entries(form)) fd.append(k, v);
	return {
		request: new Request('http://test.local/', { method: 'POST', body: fd }),
		params: {}
	} as unknown as ActionEvent;
};

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
	const rows = await testDb.db!
		.select()
		.from(s.gymEquipment)
		.where(eq(s.gymEquipment.gymId, gym.id));
	expect(rows).toHaveLength(1);
	expect(rows[0].localLabel).toBe('Lat Pulldown');
});
