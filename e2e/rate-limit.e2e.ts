/**
 * The sign-in rate limit, measured against the served production build.
 *
 * WHY THIS TEST EXISTS
 * --------------------
 * T6 found the limit was completely inert. `onRequestRateLimit` lives inside
 * `auth.handler`, and `/login`'s action called
 * `auth.api.signInEmail({ body })` — a server-side API call, which Better Auth
 * documents as NOT rate limited. Measured at the time: six consecutive
 * wrong-password POSTs to `/login` all returned 200, at a configured 3 per 10
 * seconds. Unlimited password guessing, with `rateLimit: { enabled: true }`
 * sitting in the config looking like protection.
 *
 * So this asserts the NUMBER, not the presence of the setting.
 *
 * WHY EACH TEST SENDS ITS OWN X-FORWARDED-FOR
 * --------------------------------------------
 * The limiter keys on the client IP read from `x-forwarded-for`. Running after
 * another test in this file, from the same implicit localhost, a new test would
 * inherit the previous test's exhausted bucket and fail for the wrong reason.
 * A distinct IP per test is what makes each assertion about its own behaviour.
 *
 * The header is not cosmetic either: `getIPFromHeader` returns null for a
 * multi-value X-Forwarded-For when no `trustedProxies` are configured, and a
 * null IP disables rate limiting for that request. One value per request.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetTestDb, setupTestDb, type TestDb } from '$lib/server/test-db';
import { seedTestUser, startTestServer, TEST_PASSWORD } from '$lib/server/test-auth-helpers';
import type { ChildProcess } from 'node:child_process';

/**
 * Better Auth 1.7.6's defaults for /sign-in/*, read from
 * dist/api/rate-limiter/index.mjs `getDefaultSpecialRules()`:
 *
 *   path starts with /sign-in  ->  window: 10 seconds, max: 3
 *
 * Asserted as constants, so a library upgrade that changes them fails here
 * rather than quietly loosening the control.
 */
const WINDOW_SECONDS = 10;
const MAX_ATTEMPTS = 3;

let server: ChildProcess;
let origin: string;
let serverLog: () => string = () => '';
let harness: Awaited<ReturnType<typeof setupTestDb>>;
const db = (): TestDb => harness.db;

beforeAll(async () => {
	harness = await setupTestDb();
	({ origin, server, log: serverLog } = await startTestServer());
}, 60_000);

afterAll(async () => {
	// The auth handler returns a generic {"type":"error"} body and logs the real
	// cause to the child process's stderr, which the helper captures. Print it
	// when DOCLIFTS_E2E_LOG=1, so a 500 here is diagnosable from test output
	// alone rather than by attaching to the server by hand.
	if (process.env.DOCLIFTS_E2E_LOG === '1') {
		console.error('--- server log ---\n' + serverLog());
	}
	server?.kill();
	await harness?.end();
});

beforeEach(async () => {
	await resetTestDb(harness.client);
	await seedTestUser(db());
});

const FORM_HEADERS = (ip: string, origin: string) => ({
	'content-type': 'application/x-www-form-urlencoded',
	origin,
	'x-forwarded-for': ip
});

/** One wrong-password POST to /login, as the browser sends it. */
function wrongPassword(ip: string): Promise<Response> {
	return fetch(new URL('/login', origin), {
		method: 'POST',
		headers: FORM_HEADERS(ip, origin),
		body: new URLSearchParams({
			email: 'guardtest@test.local',
			password: 'wrong-password-here'
		}).toString()
	});
}

/** The same wrong credentials straight at Better Auth's own route. */
function wrongPasswordAtAuthRoute(ip: string): Promise<Response> {
	return fetch(new URL('/api/auth/sign-in/email', origin), {
		method: 'POST',
		headers: { 'content-type': 'application/json', origin, 'x-forwarded-for': ip },
		body: JSON.stringify({ email: 'guardtest@test.local', password: 'wrong-password-here' })
	});
}

/** A correct-password POST, as the browser sends it. */
function correctPassword(ip: string): Promise<Response> {
	return fetch(new URL('/login', origin), {
		method: 'POST',
		headers: FORM_HEADERS(ip, origin),
		body: new URLSearchParams({
			email: 'guardtest@test.local',
			password: TEST_PASSWORD
		}).toString(),
		redirect: 'manual'
	});
}

describe('sign-in rate limit', () => {
	it('refuses the 4th attempt to /login inside the window, and names the wait', async () => {
		const ip = '203.0.113.10';

		for (let i = 1; i <= MAX_ATTEMPTS; i++) {
			const res = await wrongPassword(ip);
			if (res.status >= 500) {
				throw new Error(
					`attempt ${i}: server error ${res.status}: ${(await res.text()).slice(0, 800)}`
				);
			}
			// The first MAX_ATTEMPTS are ALLOWED. They are wrong passwords, so
			// the action returns its 400 — not a 429. Asserting this per attempt
			// is what proves the threshold is exactly where the library says it
			// is, rather than 1 or 2.
			expect(res.status, `attempt ${i} should still be allowed`).toBe(400);
		}

		expect((await wrongPassword(ip)).status).toBe(429);

		// The ACTION's own rendering, not a raw framework 429: the login page
		// must show a message and a wait rather than redirect to a blank form.
		const html = await blocked.text();
		expect(html).toContain('Too many sign-in attempts');
		expect(html).toMatch(/Try again in about \d+ seconds?/);
	}, 30_000);

	it('refuses the 4th attempt at the auth route too — the two paths agree', async () => {
		const ip = '203.0.113.20';

		for (let i = 1; i <= MAX_ATTEMPTS; i++) {
			expect((await wrongPasswordAtAuthRoute(ip)).status, `attempt ${i}`).not.toBe(429);
		}
		const blocked = await wrongPasswordAtAuthRoute(ip);

		// This path was ALWAYS limited — it is the one the limiter is designed
		// for, and it is public by `isPublicPath` design. Asserting both paths
		// hit the same threshold is what proves the sign-in fix is a real
		// re-route and not a second, differently-configured limiter.
		expect(blocked.status).toBe(429);
		const retryAfter = Number(blocked.headers.get('retry-after'));
		expect(retryAfter).toBeGreaterThan(0);
		expect(retryAfter).toBeLessThanOrEqual(WINDOW_SECONDS);
	}, 30_000);

	it('lets a correct password in once the window has passed', async () => {
		const ip = '203.0.113.30';

		// Burn the bucket and confirm it is actually burnt — otherwise this
		// test would pass against a limiter that never engaged.
		for (let i = 0; i <= MAX_ATTEMPTS; i++) await wrongPassword(ip);
		expect((await wrongPassword(ip)).status).toBe(429);

		await new Promise((r) => setTimeout(r, (WINDOW_SECONDS + 1) * 1000));

		const allowed = await correctPassword(ip);
		// 303 to the post-sign-in page, and a session cookie.
		expect(allowed.status).toBe(303);
		expect(allowed.headers.get('set-cookie') ?? '').toContain('better-auth.session_token');
	}, 45_000);

	it('keys on the client IP, not the account', async () => {
		// Two IPs, same account. The second is unaffected, which is what makes
		// this a per-IP control and NOT per-account lockout. Recorded in
		// docs/migrations.md as the second control to add if the app goes
		// public.
		const blockedIp = '203.0.113.40';
		for (let i = 0; i <= MAX_ATTEMPTS; i++) await wrongPassword(blockedIp);
		expect((await wrongPassword(blockedIp)).status).toBe(429);

		expect((await correctPassword('203.0.113.41')).status).toBe(303);
	}, 30_000);
});
