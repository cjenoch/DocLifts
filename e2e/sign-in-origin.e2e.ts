/**
 * The 0.2.3 lockout, reproduced at the behavior level.
 *
 * WHAT HAPPENED IN PRODUCTION
 * ---------------------------
 * Every sign-in from a browser that already held ANY cookie for the origin was
 * answered 403 before the password was compared. Better Auth validates Origin
 * only when the request carries a cookie (origin-check.mjs: `if
 * (headers.has("cookie")) return await validateOrigin(ctx)`), and the sign-in
 * proxy stripped Origin. The fix, 908e70b, forwards Origin and Referer.
 *
 * WHY THE HARNESS COULD NOT SEE IT UNTIL NOW
 * -----------------------------------------
 * Not because SvelteKit consumed the cookie header — the cookie reaches the
 * proxy intact. Because the served build inherited Vitest's TEST=true and
 * NODE_ENV=test, and Better Auth turns its origin check OFF in test mode
 * (`skipOriginCheck` defaults to isTest()). The container runs
 * NODE_ENV=production with no TEST, so it checked and the harness did not.
 * `startTestServer` now runs the build in production mode; the comment there
 * has the measurement.
 *
 * Since 0.2.4 the check is also PINNED on in auth-core.ts
 * (`advanced.disableOriginCheck: false`), so it no longer depends on the
 * environment at all. Two layers, each tested where it discriminates:
 *
 *   - the pin: src/lib/server/auth-origin-check.db.test.ts, which runs
 *     in-process in test mode and fails without it;
 *   - the harness: this file's CANARY. With the pin in place it passes either
 *     way; it fails only if BOTH the pin is removed and the harness drifts back
 *     into test mode — the exact pre-0.2.4 state, measured.
 *
 * The BEHAVIOR test fails if the proxy stops forwarding Origin. Verified: with
 * 'origin' and 'referer' removed from FORWARDED in auth-proxy.ts it fails.
 *
 * And it holds an unrelated cookie on purpose — see CLAUDE.md, "a fixture that
 * is always fresh is not a neutral fixture".
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
	freshTestDb,
	seedTestUser,
	startTestServer,
	TEST_PASSWORD,
	type TestDb
} from '$lib/server/test-auth-helpers';

const EMAIL = 'origin-check@test.local';

/** What a browser that has visited before carries. Its value is irrelevant. */
const UNRELATED_COOKIE = 'theme=dark';

let stopServer = async () => {};
let origin: string;
let db: TestDb;
let userId: string;
let harness: Awaited<ReturnType<typeof freshTestDb>>;

const sessionRows = async (): Promise<number> =>
	(
		await db.execute<{ n: number }>(
			sql`select count(*)::int as n from "auth"."session" where user_id = ${userId}`
		)
	)[0].n;

beforeAll(async () => {
	harness = await freshTestDb();
	db = harness.db;
	({ id: userId } = await seedTestUser(db, EMAIL, 'Origin Check'));
	({ origin, stop: stopServer } = await startTestServer());
}, 120_000);

afterAll(async () => {
	await stopServer();
	await harness?.end();
});

describe('the served build checks Origin the way production does (canary)', () => {
	/** A JSON sign-in straight to Better Auth's handler, bypassing our proxy. */
	const directSignIn = (headers: Record<string, string>) =>
		fetch(new URL('/api/auth/sign-in/email', origin), {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie: UNRELATED_COOKIE, ...headers },
			body: JSON.stringify({ email: EMAIL, password: TEST_PASSWORD })
		});

	it('accepts a cookie-bearing sign-in that carries the real Origin', async () => {
		// Positive first: proves the credentials and the route are fine, so the
		// refusal below can only be the origin check.
		const before = await sessionRows();
		const res = await directSignIn({ origin });
		expect(res.status, await res.clone().text()).toBe(200);
		expect(await sessionRows()).toBe(before + 1);
	});

	it('refuses the same sign-in without Origin, before the password is compared', async () => {
		const before = await sessionRows();
		const res = await directSignIn({});

		// Under the old harness (TEST=true inherited) this was a 200 and a new
		// session row: the check production runs was not running here at all.
		expect(res.status, 'the harness is serving Better Auth in test mode').toBe(403);
		const body = (await res.json()) as { code?: string };
		expect(body.code).toBe('MISSING_OR_NULL_ORIGIN');
		expect(await sessionRows(), 'a refused sign-in must not create a session').toBe(before);
	});
});

describe('a browser that has visited before can sign in (behavior)', () => {
	it('signs in through /login while holding an unrelated cookie', async () => {
		const before = await sessionRows();

		const login = await fetch(new URL('/login', origin), {
			method: 'POST',
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
				accept: 'text/html',
				origin,
				cookie: UNRELATED_COOKIE
			},
			body: new URLSearchParams({ email: EMAIL, password: TEST_PASSWORD }).toString(),
			redirect: 'manual'
		});

		// 0.2.3 in production: the action rendered "do not match" with a 200
		// here, for a password that was correct.
		expect(login.status, (await login.clone().text()).slice(0, 400)).toBe(303);

		// A redirect proves the action ran, not that it worked. Assert the state:
		// a session row exists, and the cookie we were handed authenticates.
		expect(await sessionRows(), 'sign-in must create a session row').toBe(before + 1);

		const session = login.headers
			.getSetCookie()
			.find((c) => c.startsWith('better-auth.session_token='));
		expect(session, 'sign-in must set the session cookie').toBeDefined();

		const page = await fetch(new URL('/history', origin), {
			headers: { cookie: `${UNRELATED_COOKIE}; ${session!.split(';')[0]}` },
			redirect: 'manual'
		});
		expect(page.status, 'the new session must authenticate a guarded page').toBe(200);
	});
});
