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
