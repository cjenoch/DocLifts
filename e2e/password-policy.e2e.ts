/**
 * Raising PASSWORD_MIN_LENGTH cannot lock out a password that already exists.
 *
 * The minimum applies when a password is SET. Sign-in only verifies the hash.
 * That is what makes the setting safe to change on a live account: the owner
 * can raise it without first rotating the password he signs in with. If sign-in
 * ever started enforcing the minimum — a length check in the login action,
 * say, "for consistency" — every account whose password predates the change
 * would be locked out by a config edit. This test is that guard.
 *
 * Served build, because the claim is about the login action as deployed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { auth } from '$lib/server/auth';
import { createUser } from '$lib/server/users';
import { freshTestDb, startTestServer, type TestDb } from '$lib/server/test-auth-helpers';

const EMAIL = 'policy-existing@test.local';
/** 12 characters: valid when set (default minimum), short of the raised one. */
const EXISTING_PASSWORD = 'twelve-chars';

let stopServer = async () => {};
let origin: string;
let db: TestDb;
let userId: string;
let harness: Awaited<ReturnType<typeof freshTestDb>>;

beforeAll(async () => {
	harness = await freshTestDb();
	db = harness.db;
	// Set under the default minimum of 12, in-process.
	({ id: userId } = await createUser(auth, db, {
		email: EMAIL,
		password: EXISTING_PASSWORD,
		name: 'Existing'
	}));
	// Then the server comes up with the minimum raised above it.
	({ origin, stop: stopServer } = await startTestServer({ PASSWORD_MIN_LENGTH: '20' }));
}, 120_000);

afterAll(async () => {
	await stopServer();
	await harness?.end();
});

describe('raising the minimum length', () => {
	it('still signs in with a password shorter than the new minimum', async () => {
		expect(EXISTING_PASSWORD.length).toBeLessThan(20);
		const sessions = async () =>
			(
				await db.execute<{ n: number }>(
					sql`select count(*)::int as n from "auth"."session" where user_id = ${userId}`
				)
			)[0].n;
		const before = await sessions();

		const login = await fetch(new URL('/login', origin), {
			method: 'POST',
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
				accept: 'text/html',
				origin
			},
			body: new URLSearchParams({ email: EMAIL, password: EXISTING_PASSWORD }).toString(),
			redirect: 'manual'
		});

		expect(login.status, (await login.clone().text()).slice(0, 300)).toBe(303);
		// A redirect proves the action ran. The session row proves it worked.
		expect(await sessions(), 'sign-in must create a session row').toBe(before + 1);
	});
});
