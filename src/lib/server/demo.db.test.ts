import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { setupTestDb, resetTestDb } from './test-db';
import { seedDemo } from './demo';
import * as s from './db/schema';

let handle: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
	handle = await setupTestDb();
});
beforeEach(async () => {
	await resetTestDb(handle.client);
});
afterAll(async () => {
	await handle?.end();
});

it('requires explicit demo opt-in and never changes an ordinary test database', async () => {
	await expect(seedDemo(handle.db, false)).rejects.toThrow('DOCLIFTS_DEMO');
	const database = new URL(
		process.env.TEST_DATABASE_URL ?? 'postgresql://localhost/doclifts_test'
	).pathname.slice(1);
	if (!/^doclifts_demo(?:_test)?$/.test(database))
		await expect(seedDemo(handle.db, true)).rejects.toThrow('restricted');
	else {
		await handle.db.insert(s.programs).values({ name: 'Existing data' });
		await expect(seedDemo(handle.db, true)).rejects.toThrow('empty database');
		expect((await handle.db.select().from(s.programs))[0].name).toBe('Existing data');
	}
});

it('seeds repeatably without resetting edited demo records', async () => {
	const database = new URL(
		process.env.TEST_DATABASE_URL ?? 'postgresql://localhost/doclifts_test'
	).pathname.slice(1);
	if (!/^doclifts_demo(?:_test)?$/.test(database)) {
		await expect(seedDemo(handle.db, true)).rejects.toThrow('restricted');
		return;
	}
	expect(await seedDemo(handle.db, true)).toBe('seeded fictional demo data');
	expect(await handle.db.select().from(s.sessions)).toHaveLength(8);
	expect(await handle.db.select().from(s.sets)).toHaveLength(48);
	expect(await handle.db.select().from(s.exercises)).toHaveLength(9);
	const [program] = await handle.db.select().from(s.programs);
	await handle.db
		.update(s.programs)
		.set({ name: 'My demo edits' })
		.where(eq(s.programs.id, program.id));
	expect(await seedDemo(handle.db, true)).toBe('already seeded');
	expect((await handle.db.select().from(s.programs))[0].name).toBe('My demo edits');
});
