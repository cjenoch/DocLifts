import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { isRedirect } from '@sveltejs/kit';
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
beforeEach(async () => {
	await resetTestDb(harness.client);
});
afterAll(async () => {
	await harness?.end();
});

type LoadEvent = Parameters<typeof load>[0];
type ActionEvent = Parameters<(typeof actions)['default']>[0];
const loadAs = (userId: string) =>
	load({ locals: { user: { id: userId } } } as unknown as LoadEvent) as Promise<{
		gyms: { id: string; name: string }[];
		defaultGymId: string | null;
	}>;
const postAs = (userId: string, form: Record<string, string>) => {
	const fd = new FormData();
	for (const [k, v] of Object.entries(form)) fd.append(k, v);
	return actions.default({
		request: new Request('http://test.local/workout/start', { method: 'POST', body: fd }),
		locals: { user: { id: userId } }
	} as unknown as ActionEvent);
};
const caught = (p: unknown) =>
	Promise.resolve(p).then(
		(v) => v,
		(e: unknown) => e
	);
const sessionsOf = (userId: string) =>
	testDb.db!.select().from(s.sessions).where(eq(s.sessions.userId, userId));

it('a new user names a gym, the workout opens, and the step then redirects to it', async () => {
	const { alice } = await withTwoUsers(testDb.db!);
	expect(await loadAs(alice)).toEqual({ gyms: [], defaultGymId: null });

	const posted = await caught(postAs(alice, { newGymName: 'Corner gym' }));
	expect(isRedirect(posted)).toBe(true);
	const [session] = await sessionsOf(alice);
	expect(posted).toMatchObject({ status: 303, location: `/sessions/${session.id}` });
	const [gym] = await testDb.db!.select().from(s.gyms).where(eq(s.gyms.userId, alice));
	expect(gym.name).toBe('Corner gym');
	expect(session.gymId).toBe(gym.id);

	// The step is skipped while that workout is open.
	expect(await caught(loadAs(alice))).toMatchObject({
		status: 303,
		location: `/sessions/${session.id}`
	});
});

it('lists only the owner gyms; another user posting that gym gets 404 and nothing is written', async () => {
	const { alice, bob } = await withTwoUsers(testDb.db!);
	const [gym] = await testDb
		.db!.insert(s.gyms)
		.values({ userId: alice, name: "Alice's gym" })
		.returning();
	expect(await loadAs(alice)).toEqual({
		gyms: [{ id: gym.id, name: "Alice's gym" }],
		defaultGymId: gym.id
	}); // positive FIRST
	expect(await loadAs(bob)).toEqual({ gyms: [], defaultGymId: null });

	const refused = await postAs(bob, { gymId: gym.id });
	expect(refused).toMatchObject({ status: 404, data: { message: 'Gym not found' } });
	expect(await sessionsOf(bob)).toEqual([]);
	expect(await testDb.db!.select().from(s.programs).where(eq(s.programs.userId, bob))).toEqual([]);
});

it('refuses an empty form with 400', async () => {
	const { alice } = await withTwoUsers(testDb.db!);
	expect(await postAs(alice, {})).toMatchObject({ status: 400 });
	expect(await sessionsOf(alice)).toEqual([]);
});
