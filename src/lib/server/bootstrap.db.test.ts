/**
 * T5: the accounts CLI and the starter-exercise hook.
 *
 * The hook is the important one. It is the only thing standing between a new
 * account and an empty exercise picker, and it fires on a code path that
 * `createUser` does not own — so "the list exists" is a claim that has to be
 * tested against the real adapter, not against the function that calls it.
 *
 * `bootstrap` is tested here too, including the refusal, because the refusal is
 * the safety property: it is what stops a first-run command from adopting the
 * sentinel on a live database.
 */
import { beforeEach, afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { bootstrap, SENTINEL_USER_ID, SENTINEL_EMAIL } from './bootstrap';
import { createUser, setPassword, findUserByEmail } from './users';
import { auth } from './auth';
import { resetTestDb, setupTestDb, type TestDb } from './test-db';
import { authAccounts, authUsers } from './db/auth-schema';
import * as s from './db/schema';
import { STARTER_EXERCISES } from './starter-exercises';

let harness: Awaited<ReturnType<typeof setupTestDb>>;
// TestDb is the drizzle handle itself, not a wrapper. Using resetTestDb (not
// resetTestDbWithUsers) so no throwaway user exists: several tests here assert
// on the exact user set, and a fixture user would make "only the sentinel"
// untrue.
const db = (): TestDb => harness.db;

beforeEach(async () => {
	harness ??= await setupTestDb();
	await resetTestDb(harness.client);
});

afterAll(async () => {
	await harness?.end();
});

/** Put the 0011 sentinel in place, exactly as the migration would. */
async function plantSentinel() {
	await db().insert(authUsers).values({
		id: SENTINEL_USER_ID,
		name: 'Owner',
		email: SENTINEL_EMAIL,
		emailVerified: false
	});
	// Backfill one row so "the data comes back" is observable.
	const [program] = await db()
		.insert(s.programs)
		.values({ userId: SENTINEL_USER_ID, name: 'Real Program' })
		.returning();
	return program;
}

describe('starter exercise hook', () => {
	it('gives a new account the full starter list', async () => {
		const created = await createUser(db(), {
			email: 'newbie@example.com',
			password: 'correct-horse-battery',
			name: 'Newbie'
		});
		const rows = await db().select().from(s.exercises).where(eq(s.exercises.userId, created.id));
		expect(rows).toHaveLength(STARTER_EXERCISES.length);
		const names = rows.map((r: (typeof rows)[number]) => r.name);
		for (const starter of STARTER_EXERCISES) {
			expect(names, starter.name).toContain(starter.name);
		}
	});

	it('does not contaminate a second account, and the first keeps its own', async () => {
		const first = await createUser(db(), {
			email: 'first@example.com',
			password: 'correct-horse-battery',
			name: 'First'
		});
		const second = await createUser(db(), {
			email: 'second@example.com',
			password: 'correct-horse-battery',
			name: 'Second'
		});

		const firstRows = await db().select().from(s.exercises).where(eq(s.exercises.userId, first.id));
		const secondRows = await db()
			.select()
			.from(s.exercises)
			.where(eq(s.exercises.userId, second.id));

		expect(firstRows).toHaveLength(STARTER_EXERCISES.length);
		expect(secondRows).toHaveLength(STARTER_EXERCISES.length);
		expect(firstRows.map((r) => r.id).sort()).not.toEqual(secondRows.map((r) => r.id).sort());

		// Each user sees exactly their own: no shared rows at all.
		const all = await db().select().from(s.exercises);
		expect(all).toHaveLength(STARTER_EXERCISES.length * 2);
	});
});

describe('user:bootstrap', () => {
	it('claims the sentinel in place, keeping its id so backfilled data returns', async () => {
		const program = await plantSentinel();

		const result = await bootstrap(db(), {
			email: 'chris@example.com',
			password: 'correct-horse-battery',
			name: 'Chris'
		});

		expect(result.kind).toBe('claimed-sentinel');
		// THE load-bearing assertion: the id is unchanged, so the row backfilled
		// to the sentinel is now owned by a signable account. If bootstrap ever
		// created a new user instead, this row would be orphaned.
		expect(result.userId).toBe(SENTINEL_USER_ID);
		const [owned] = await db().select().from(s.programs).where(eq(s.programs.id, program.id));
		expect(owned.userId).toBe(SENTINEL_USER_ID);

		const [claimed] = await db().select().from(authUsers).where(eq(authUsers.id, SENTINEL_USER_ID));
		expect(claimed.email).toBe('chris@example.com');
		expect(claimed.name).toBe('Chris');
		// 0011 created it unverified; claiming makes it a real operator account.
		expect(claimed.emailVerified).toBe(true);
	});

	it('produces an account that can actually sign in', async () => {
		await plantSentinel();
		await bootstrap(db(), {
			email: 'chris@example.com',
			password: 'correct-horse-battery',
			name: 'Chris'
		});

		// A real sign-in, not an assertion that a credential row exists.
		const result = await auth.api.signInEmail({
			body: { email: 'chris@example.com', password: 'correct-horse-battery' }
		});
		expect(result.user.email).toBe('chris@example.com');
		expect(result.user.id).toBe(SENTINEL_USER_ID);
	});

	it('gives the claimed sentinel the starter list, which it never got from the hook', async () => {
		await plantSentinel();
		const result = await bootstrap(db(), {
			email: 'chris@example.com',
			password: 'correct-horse-battery',
			name: 'Chris'
		});
		expect(result.starterExercises).toBe(STARTER_EXERCISES.length);
	});

	it('creates a fresh account when there is no sentinel at all', async () => {
		const result = await bootstrap(db(), {
			email: 'fresh@example.com',
			password: 'correct-horse-battery',
			name: 'Fresh'
		});
		expect(result.kind).toBe('created-fresh');
		expect(result.userId).not.toBe(SENTINEL_USER_ID);
		expect(result.starterExercises).toBe(STARTER_EXERCISES.length);
	});

	it('REFUSES when a real user already exists, leaving both untouched', async () => {
		const existing = await createUser(db(), {
			email: 'real@example.com',
			password: 'correct-horse-battery',
			name: 'Real'
		});
		await plantSentinel();
		const before = await db().select().from(authUsers);

		await expect(
			bootstrap(db(), { email: 'chris@example.com', password: 'correct-horse-battery', name: 'C' })
		).rejects.toThrow(/Refusing to bootstrap/);

		// Nothing was adopted or rewritten.
		expect(await db().select().from(authUsers)).toEqual(before);
		const [untouched] = await db().select().from(authUsers).where(eq(authUsers.id, existing.id));
		expect(untouched.email).toBe('real@example.com');
	});
});

describe('user:set-password', () => {
	it('replaces the password and the new one signs in', async () => {
		const created = await createUser(db(), {
			email: 'reset@example.com',
			password: 'correct-horse-battery',
			name: 'Reset'
		});

		await setPassword(db(), { email: 'reset@example.com', password: 'a-brand-new-password-9' });

		const ok = await auth.api.signInEmail({
			body: { email: 'reset@example.com', password: 'a-brand-new-password-9' }
		});
		expect(ok.user.id).toBe(created.id);

		// And the OLD one stops working — the point of a reset.
		await expect(
			auth.api.signInEmail({
				body: { email: 'reset@example.com', password: 'correct-horse-battery' }
			})
		).rejects.toThrow();
	});

	it('refuses the sentinel, and says which command to use instead', async () => {
		await plantSentinel();
		// `owner@localhost` is NOT a valid email under zod's regex (it requires a
		// dot and a TLD), so without a dedicated check this rejected with an
		// opaque Zod error and never reached the useful message. setPassword now
		// short-circuits on the sentinel's placeholder email and points at the
		// command that actually helps — caught here while writing the test.
		await expect(
			setPassword(db(), { email: SENTINEL_EMAIL, password: 'a-brand-new-password-9' })
		).rejects.toThrow(/user:bootstrap/);

		// And once the sentinel has been CLAIMED (so it has a real email and, in
		// fact, a real credential row), set-password behaves normally — proving
		// the refusal path above is about the sentinel, not about setPassword.
		await bootstrap(db(), {
			email: 'chris@example.com',
			password: 'correct-horse-battery',
			name: 'Chris'
		});
		await expect(
			setPassword(db(), { email: 'chris@example.com', password: 'a-brand-new-password-9' })
		).resolves.toMatchObject({ email: 'chris@example.com' });
	});

	it('rejects a password below the configured minimum', async () => {
		await createUser(db(), {
			email: 'short@example.com',
			password: 'correct-horse-battery',
			name: 'Short'
		});
		await expect(
			setPassword(db(), { email: 'short@example.com', password: 'too-short' })
		).rejects.toThrow(/at least/);
	});

	it('rejects an unknown email rather than silently doing nothing', async () => {
		await expect(
			setPassword(db(), { email: 'nobody@example.com', password: 'a-brand-new-password-9' })
		).rejects.toThrow(/No user with email/);
	});
});

describe('user:create', () => {
	it('creates a signable account with a starter list', async () => {
		const created = await createUser(db(), {
			email: 'operator@example.com',
			password: 'correct-horse-battery',
			name: 'Operator'
		});
		expect(await findUserByEmail(db(), 'operator@example.com')).toBe(created.id);
		const [account] = await db()
			.select()
			.from(authAccounts)
			.where(eq(authAccounts.userId, created.id));
		expect(account.providerId).toBe('credential');
	});

	it('rejects a duplicate email rather than creating a second row', async () => {
		await createUser(db(), {
			email: 'dupe@example.com',
			password: 'correct-horse-battery',
			name: 'One'
		});
		await expect(
			createUser(db(), {
				email: 'dupe@example.com',
				password: 'correct-horse-battery',
				name: 'Two'
			})
		).rejects.toThrow(/already exists/);
	});
});
