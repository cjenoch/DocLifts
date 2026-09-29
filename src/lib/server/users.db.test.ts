/**
 * createUser must work with sign-up DISABLED — that is its entire reason for
 * existing. This test runs against the real Better Auth instance with
 * DOCLIFTS_OPEN_SIGNUP unset.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, resetTestDb, type TestDb } from './test-db';
import { createUser, findUserByEmail } from './users';
import { authAccounts, authUsers } from './db/auth-schema';
import { eq } from 'drizzle-orm';
import type postgres from 'postgres';

describe('createUser', () => {
	let db: TestDb;
	let client: postgres.Sql;
	beforeAll(async () => {
		({ db, client } = await setupTestDb());
		await resetTestDb(client);
	});
	afterAll(async () => {
		await client.end();
	});

	it('creates a user AND a credential account, with signup disabled', async () => {
		const created = await createUser(db, {
			email: 'Bootstrap@Test.local',
			password: 'correct-horse-battery-staple',
			name: 'Bootstrap'
		});
		expect(created.email).toBe('bootstrap@test.local'); // normalized
		expect(await findUserByEmail(db, 'BOOTSTRAP@test.local')).toBe(created.id);

		const [acct] = await db.select().from(authAccounts).where(eq(authAccounts.userId, created.id));
		expect(acct, 'credential account row must exist or sign-in cannot work').toBeTruthy();
		expect(acct.providerId).toBe('credential');
		expect(acct.password).toBeTruthy();
		// must be a real hash, not the plaintext
		expect(acct.password).not.toBe('correct-horse-battery-staple');

		const [u] = await db.select().from(authUsers).where(eq(authUsers.id, created.id));
		// Operator-created accounts ARE email-verified: there is no email flow
		// to complete, so unverified would only mean locked out later.
		expect(u.emailVerified).toBe(true);
	});

	it('parity with signUpEmail: mixed-case email signs in lowercase', async () => {
		// signUpEmail normalizes (`normalizedEmail = email.toLowerCase()`),
		// and sign-in looks up the same form. createUser must agree or an
		// operator-created account cannot log in.
		const created = await createUser(db, {
			email: 'Chris@Enoch.AI',
			password: 'correct-horse-battery-staple',
			name: 'MixedCase'
		});
		expect(created.email).toBe('chris@enoch.ai');
		expect(await findUserByEmail(db, 'chris@enoch.ai')).toBe(created.id);

		const { auth } = await import('./auth');
		const r = await auth.api.signInEmail({
			body: { email: 'chris@enoch.ai', password: 'correct-horse-battery-staple' },
			headers: new Headers()
		});
		expect(r.user.id).toBe(created.id);
	});

	it('enforces the configured maximum password length', async () => {
		await expect(
			createUser(db, {
				email: 'long@test.local',
				password: 'x'.repeat(200),
				name: 'Long'
			})
		).rejects.toThrow(/at most/);
	});

	it('rejects a duplicate email', async () => {
		await createUser(db, {
			email: 'dupe@test.local',
			password: 'correct-horse-battery-staple',
			name: 'Dupe'
		});
		await expect(
			createUser(db, {
				email: 'dupe@test.local',
				password: 'correct-horse-battery-staple',
				name: 'Dupe2'
			})
		).rejects.toThrow(/already exists/);
	});

	it('enforces the 12-char minimum password', async () => {
		await expect(
			createUser(db, { email: 'short@test.local', password: 'tooshort', name: 'S' })
		).rejects.toThrow(/12 characters/);
	});

	it('the password actually authenticates', async () => {
		const { auth } = await import('./auth');
		const created = await createUser(db, {
			email: 'signin@test.local',
			password: 'correct-horse-battery-staple',
			name: 'Signer'
		});
		const r = await auth.api.signInEmail({
			body: { email: 'signin@test.local', password: 'correct-horse-battery-staple' },
			headers: new Headers()
		});
		expect(r.user.id).toBe(created.id);
	});
});
