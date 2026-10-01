/**
 * Better Auth's origin check is ON regardless of the environment.
 *
 * This runs in-process under Vitest, which is test mode (NODE_ENV=test,
 * TEST=true). Unpinned, better-auth 1.7.6 turns the origin check OFF in test
 * mode, so this file is where the pin in auth-core.ts is discriminating: remove
 * `disableOriginCheck: false` and the refusal below becomes a 200 with a new
 * session.
 *
 * The served-build counterpart is e2e/sign-in-origin.e2e.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type postgres from 'postgres';
import { setupTestDb, resetTestDb, type TestDb } from './test-db';
import { createUser } from './users';
import { auth } from './auth';

const EMAIL = 'origin-pin@test.local';
const PASSWORD = 'correct-horse-battery-staple';

describe('the origin check does not depend on NODE_ENV', () => {
	let db: TestDb;
	let client: postgres.Sql;
	let userId: string;

	beforeAll(async () => {
		({ db, client } = await setupTestDb());
		await resetTestDb(client);
		({ id: userId } = await createUser(auth, db, {
			email: EMAIL,
			password: PASSWORD,
			name: 'Pin'
		}));
	});

	afterAll(async () => {
		await client.end();
	});

	const baseURL = (): string => auth.options.baseURL as string;

	const sessionRows = async (): Promise<number> =>
		(
			await db.execute<{ n: number }>(
				sql`select count(*)::int as n from "auth"."session" where user_id = ${userId}`
			)
		)[0].n;

	const signIn = (headers: Record<string, string>) =>
		auth.handler(
			new Request(new URL('/api/auth/sign-in/email', baseURL()), {
				method: 'POST',
				headers: { 'content-type': 'application/json', cookie: 'theme=dark', ...headers },
				body: JSON.stringify({ email: EMAIL, password: PASSWORD })
			})
		);

	it('runs in test mode, which is the condition that used to switch the check off', () => {
		// The premise of this file. If Vitest ever stops setting these, the
		// test below stops proving anything about the pin.
		expect(process.env.NODE_ENV === 'test' || Boolean(process.env.TEST)).toBe(true);
	});

	it('accepts a cookie-bearing sign-in that carries the real Origin', async () => {
		// Positive first, so the refusal below can only be the origin check.
		const before = await sessionRows();
		const res = await signIn({ origin: new URL(baseURL()).origin });
		expect(res.status, await res.clone().text()).toBe(200);
		expect(await sessionRows()).toBe(before + 1);
	});

	it('refuses a cookie-bearing sign-in without Origin, and creates no session', async () => {
		const before = await sessionRows();
		const res = await signIn({});
		expect(res.status, 'origin check is off: disableOriginCheck is not pinned').toBe(403);
		expect(((await res.json()) as { code?: string }).code).toBe('MISSING_OR_NULL_ORIGIN');
		expect(await sessionRows()).toBe(before);
	});
});
