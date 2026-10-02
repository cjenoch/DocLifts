import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setupTestDb, resetTestDb, withTwoUsers, type TestDb } from './test-db';
import * as s from './db/schema';
import { homeState } from './home';
import { startQuickSession } from './quick-workouts';
import { createGym } from './machines';

let db: TestDb;
let handle: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
	handle = await setupTestDb();
	db = handle.db;
});
afterAll(async () => {
	await handle?.end();
});
beforeEach(async () => {
	await resetTestDb(handle.client);
});

async function importOneWorkout(userId: string) {
	const importId = randomUUID();
	await db.insert(s.workoutLogImports).values({
		id: importId,
		userId,
		sourceSha256: randomUUID(),
		sourceName: 'log.txt',
		sourceText: 'x'
	});
	await db.insert(s.importedWorkouts).values({
		id: randomUUID(),
		importId,
		sourceLine: 1,
		title: 'Legs',
		dateNote: '',
		lines: []
	});
}

describe('homeState (first run on Home)', () => {
	it('a fresh account has no workouts and no imported history', async () => {
		const { alice } = await withTwoUsers(db);
		expect(await homeState(db, alice)).toEqual({ hasWorkouts: false, hasImported: false });
	});

	it('sees the owner’s own workout and import, and nothing of another user’s', async () => {
		const { alice, bob } = await withTwoUsers(db);
		const gym = await createGym(db, alice, { name: 'Home gym' });
		await startQuickSession(db, alice, gym.id);
		await importOneWorkout(alice);
		// Positive first: the owner sees both.
		expect(await homeState(db, alice)).toEqual({ hasWorkouts: true, hasImported: true });
		// Bob's account is still a first run.
		expect(await homeState(db, bob)).toEqual({ hasWorkouts: false, hasImported: false });
	});

	it('a workout in Trash still counts: the account is no longer new', async () => {
		const { alice } = await withTwoUsers(db);
		const gym = await createGym(db, alice, { name: 'Home gym' });
		const started = await startQuickSession(db, alice, gym.id);
		await db.update(s.sessions).set({ deletedAt: new Date() }).where(eq(s.sessions.userId, alice));
		expect(started).toBeTruthy();
		expect((await homeState(db, alice)).hasWorkouts).toBe(true);
	});
});
