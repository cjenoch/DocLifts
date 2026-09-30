import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { setupTestDb, resetTestDb, assertNoUnownedRows } from './test-db';
import { seedDemo } from './demo';
import { findUserByEmail } from './users';
import * as s from './db/schema';

/**
 * The seed path was never covered before (g0): both tests took the
 * `rejects.toThrow('restricted')` branch on an ordinary test database, so
 * `seedDemo` had never actually run anywhere, CI included.
 *
 * This file runs in its own vitest project — see vite.demo.config.ts for why
 * that is the only place the database can be pointed somewhere other than
 * doclifts_test. `seedDemo` creates its owner through `createUser`, which
 * writes via the app's `auth` singleton, and that singleton is bound to
 * DATABASE_URL at module import. The seed's own rows go to the handle it is
 * passed. Unless both name the same database, the demo rows end up pointing
 * at a user_id that does not exist in their own database.
 */
function demoUrl(): string {
	const url = new URL(process.env.TEST_DATABASE_URL ?? 'postgresql://localhost/doclifts_demo_test');
	if (url.pathname.slice(1) !== 'doclifts_demo_test') {
		throw new Error(
			`demo.db.test.ts must run in the \`demo\` vitest project; TEST_DATABASE_URL names ${url.pathname.slice(1)}, not doclifts_demo_test.`
		);
	}
	return url.toString();
}

/** A database that is deliberately NOT a demo database, for the name guard. */
function guardUrl(): string {
	const url = new URL(process.env.TEST_DATABASE_URL ?? 'postgresql://localhost/doclifts_demo_test');
	url.pathname = '/doclifts_notdemo_test';
	return url.toString();
}

let demo: Awaited<ReturnType<typeof setupTestDb>>;

beforeAll(async () => {
	// setupTestDb creates the database if absent and applies migrations. No
	// argument: the `demo` project already points TEST_DATABASE_URL at
	// doclifts_demo_test, which is the arrangement that makes the auth
	// singleton and the seed handle agree.
	demoUrl();
	demo = await setupTestDb();
});

beforeEach(async () => {
	await resetTestDb(demo.client);
});

afterAll(async () => {
	await demo?.end();
});

it('requires explicit demo opt-in and never changes an ordinary test database', async () => {
	// Opt-in first: without DOCLIFTS_DEMO=1 nothing happens at all. The flag
	// is passed explicitly, exactly as seed.ts does.
	await expect(seedDemo(demo.db, false)).rejects.toThrow('DOCLIFTS_DEMO');

	// The name guard, against a second database that is not a demo one. It has
	// to refuse on the NAME alone — the demo project's DATABASE_URL cannot be
	// what makes this fail — and it must leave the existing row alone rather
	// than truncating.
	//
	// setupTestDb is reused rather than a hand-rolled client + migrate pair:
	// drizzle-orm's postgres-js migrator throws a circular-import TypeError
	// ("Cannot read properties of undefined (reading 'migrate')") when a test
	// file imports it directly, which is why it is only reached through here.
	const guard = await setupTestDb(guardUrl());
	const [marker] = await guard.db.insert(s.programs).values({ name: 'Existing data' }).returning();
	try {
		await expect(seedDemo(guard.db, true)).rejects.toThrow('restricted');
		expect((await guard.db.select().from(s.programs)).map((r) => r.name)).toEqual([
			'Existing data'
		]);
	} finally {
		await guard.db.delete(s.programs).where(eq(s.programs.id, marker.id));
		await guard.end();
	}

	await expect(seedDemo(demo.db, true)).resolves.toBe('seeded fictional demo data');
});

it('seeds repeatably without resetting edited demo records', async () => {
	expect(await seedDemo(demo.db, true)).toBe('seeded fictional demo data');
	expect(await demo.db.select().from(s.sessions)).toHaveLength(8);
	expect(await demo.db.select().from(s.sets)).toHaveLength(48);
	expect(await demo.db.select().from(s.exercises)).toHaveLength(9);
	const [program] = await demo.db.select().from(s.programs);
	await demo.db
		.update(s.programs)
		.set({ name: 'My demo edits' })
		.where(eq(s.programs.id, program.id));
	// A second call must reach the "already seeded" short-circuit, which is
	// why seedDemo find-or-creates its owner rather than creating one outright.
	expect(await seedDemo(demo.db, true)).toBe('already seeded');
	expect((await demo.db.select().from(s.programs))[0].name).toBe('My demo edits');
});

/**
 * The (g0) acceptance. seedDemo creates a real, signable demo user and stamps
 * every owned row with that id, because 0011 makes those columns NOT NULL — the
 * seed would fail outright at that point.
 */
it('owns every demo row with a signable demo user', async () => {
	expect(await seedDemo(demo.db, true)).toBe('seeded fictional demo data');

	// The owner is a real account, not a bare row: findUserByEmail resolves it
	// through the same auth.user table Better Auth authenticates against.
	const [program] = await demo.db.select({ id: s.programs.userId }).from(s.programs);
	expect(program.id).toBeTruthy();
	expect(await findUserByEmail(demo.db, 'demo@doclifts.local')).toBe(program.id);

	// Every owned table carries that owner.
	const [gym] = await demo.db.select().from(s.gyms);
	const [session] = await demo.db.select().from(s.sessions);
	const [exercise] = await demo.db.select().from(s.exercises);
	const [set] = await demo.db.select().from(s.sets);
	expect(gym.userId).toBe(program.id);
	expect(session.userId).toBe(program.id);
	expect(exercise.userId).toBe(program.id);
	expect(set.userId).toBe(program.id);

	// The acceptance: no ownerless row anywhere.
	await assertNoUnownedRows(demo.client);
});
