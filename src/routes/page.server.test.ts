import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
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

import { load } from './+page.server';
import * as s from '$lib/server/db/schema';
import { startQuickSession } from '$lib/server/quick-workouts';

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

type HomeData = { programs: { id: string; name: string }[] };
const home = async (ownerId: string): Promise<HomeData> =>
	(await load({ locals: { user: { id: ownerId } } } as Parameters<
		typeof load
	>[0])) as unknown as HomeData;

it('returns the owner their own active programs, and none to another user', async () => {
	// 0.4.7: Home selected every user's active programs (no owner filter).
	const { alice, bob } = await withTwoUsers(testDb.db!);
	await testDb.db!.insert(s.programs).values([
		{ userId: alice, name: 'Alice push day' },
		{ userId: alice, name: 'Alice retired plan', isActive: false }
	]);

	const mine = await home(alice);
	expect(mine.programs.map((p) => p.name)).toEqual(['Alice push day']); // positive FIRST
	const theirs = await home(bob);
	expect(theirs.programs).toEqual([]);
});

it('never lists a system program, and offers Resume only to the owner of the open workout', async () => {
	// 0.5.1: the hidden quick-workout program must not appear on Home.
	const { alice, bob } = await withTwoUsers(testDb.db!);
	await testDb.db!.insert(s.programs).values({ userId: alice, name: 'Alice push day' });
	const [gym] = await testDb.db!.insert(s.gyms).values({ userId: alice, name: 'G' }).returning();
	const started = await startQuickSession(testDb.db!, alice, gym.id);
	if (!started.ok) throw new Error(started.message);

	const mine = (await home(alice)) as HomeData & { openQuickSessionId: string | null };
	expect(mine.programs.map((p) => p.name)).toEqual(['Alice push day']); // positive FIRST
	expect(mine.openQuickSessionId).toBe(started.sessionId);
	const theirs = (await home(bob)) as HomeData & { openQuickSessionId: string | null };
	expect(theirs.programs).toEqual([]);
	expect(theirs.openQuickSessionId).toBeNull();
});
