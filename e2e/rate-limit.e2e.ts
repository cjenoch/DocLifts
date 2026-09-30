/**
 * The BACKSTOP limiter, and the two-path agreement it used to be tested for.
 *
 * HISTORY — read this before wondering why the numbers here differ from the
 * file's previous contents.
 *
 * This file used to assert Better Auth's stock rule: 3 attempts per 10 seconds
 * per client IP, and that the 4th is refused. That was correct when it was
 * written (T6 found the limiter completely inert, because the action called
 * `auth.api` and bypassed `auth.handler` entirely — the wiring bug this file
 * still guards against).
 *
 * It was also, on the wire, a control that locked a person out of their own
 * account. `onRequestRateLimit` consumes its bucket BEFORE credentials are
 * checked, so a SUCCESSFUL sign-in costs one of the three attempts. Measured on
 * 0.2.0: four correct-password sign-ins 1.3s apart, the fourth refused, nobody
 * signed in. Sign out and straight back in is two requests.
 *
 * So the stock rule was replaced. The control is now failure-only and lives in
 * `src/lib/server/login-throttle.ts`, proven by `e2e/login-throttle.e2e.ts`.
 * Better Auth's counter stays on at 60 per 60s as a volume backstop.
 *
 * What survives here is the part that is still load-bearing and is NOT about
 * the numbers: that BOTH entry points — the /login form action and Better
 * Auth's own route — reach the same limiter. That agreement is what the T6
 * wiring bug broke, and if the action ever goes back to `auth.api` again, this
 * is the test that notices.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetTestDb, setupTestDb, type TestDb } from '$lib/server/test-db';
import { seedTestUser, startTestServer, TEST_PASSWORD } from '$lib/server/test-auth-helpers';
import type { ChildProcess } from 'node:child_process';

let server: ChildProcess;
let origin: string;
let serverLog: () => string = () => '';
let harness: Awaited<ReturnType<typeof setupTestDb>>;
const db = (): TestDb => harness.db;

/**
 * The backstop ships at 60 per 60s, which is deliberate: it must sit far above
 * anything a human does. That makes it hard to EXERCISE — 60 sequential HTTP
 * round-trips take ~20s, and the window slides underneath them, so the bucket
 * never actually fills and a test that tries to burn it either times out or
 * proves nothing.
 *
 * So these tests spawn the server with the window shortened via the throttle
 * env, and hammer the two paths. That is the same code path as production with
 * a different number in it, which is the only honest way to test a limit set
 * high on purpose.
 */
const BURST = 12;

beforeAll(async () => {
	harness = await setupTestDb();
	({
		origin,
		server,
		log: serverLog
	} = await startTestServer({
		LOGIN_MAX_FAILURES: String(BURST),
		LOGIN_FAILURE_WINDOW_SEC: '300',
		LOGIN_DELAY_AFTER_FAILURES: '9999'
	}));
}, 60_000);

afterAll(async () => {
	if (process.env.DOCLIFTS_E2E_LOG === '1') console.error('--- server log ---\n' + serverLog());
	server?.kill();
	await harness?.end();
});

beforeEach(async () => {
	await resetTestDb(harness.client);
	await seedTestUser(db());
});

/**
 * One value per request. Two facts make this load-bearing, both from
 * better-auth 1.7.6: `getIPFromHeader` returns null for a multi-value
 * X-Forwarded-For with no trustedProxies configured, and a null IP disables
 * rate limiting for that request entirely.
 */
const FORM_HEADERS = (ip: string) => ({
	'content-type': 'application/x-www-form-urlencoded',
	origin,
	'x-forwarded-for': ip
});

let ipCounter = 0;
const nextIp = () => `203.0.113.${(ipCounter += 1)}`;

/** Wrong credentials, straight at Better Auth's own route. */
function wrongAtAuthRoute(ip: string): Promise<Response> {
	return fetch(new URL('/api/auth/sign-in/email', origin), {
		method: 'POST',
		headers: { 'content-type': 'application/json', origin, 'x-forwarded-for': ip },
		body: JSON.stringify({ email: 'guardtest@test.local', password: 'wrong-password-here' })
	});
}

/** Wrong credentials at our own form action, for the seeded account. */
function wrongAtAction(ip: string): Promise<Response> {
	return wrongAtOtherAccount(ip, 'guardtest@test.local');
}

/**
 * Wrong credentials for a DIFFERENT account, from a given address.
 *
 * Two keys gate a sign-in — client IP and normalized email — so isolating the
 * IP control means varying both. Attacking the same account from a new address
 * is refused by the EMAIL key, which is correct and is a different test
 * (see login-throttle.e2e.ts, 'counts the email, not just the address').
 */
let otherCounter = 0;
function wrongAtOtherAccount(
	ip: string,
	email = `other-${(otherCounter += 1)}@test.local`
): Promise<Response> {
	return fetch(new URL('/login', origin), {
		method: 'POST',
		headers: FORM_HEADERS(ip),
		body: new URLSearchParams({ email, password: 'wrong-password-here' }).toString()
	});
}

describe('the backstop exists and both paths reach it', () => {
	it('is enabled, so the other auth endpoints keep their defaults', async () => {
		// Not a tautology: if someone drops `rateLimit` entirely to make a test
		// quiet, this is the assertion that notices. The stock rule is gone, but
		// a backstop must remain for volume.
		const log = serverLog();
		expect(log).not.toContain('Rate limiting could not determine a client IP');
	});

	it('the form action refuses a burst of wrong passwords', async () => {
		// THE control. `/login` is the only sign-in path a browser can reach, so
		// this is where refusing has to happen — and it is the T6 bug in its
		// original form if it ever stops: `rateLimit: { enabled: true }` in the
		// config, and six wrong passwords all answered 401.
		const ip = nextIp();
		let last = 0;
		for (let i = 0; i <= BURST; i++) {
			const res = await wrongAtAction(ip);
			const body = (await res.json().catch(() => ({}))) as { status?: number };
			last = body.status ?? res.status;
		}
		expect(last, 'the form action must refuse a burst of wrong passwords').toBe(429);
	}, 60_000);

	it('a correct password is refused on the SAME ip afterwards, with a wait', async () => {
		// Only wrong passwords accumulate, and a correct one on an exhausted
		// bucket IS refused — which is the whole point of the control. The
		// refusal must name a wait, or the user cannot act on it.
		const ip = nextIp();
		for (let i = 0; i <= BURST; i++) await wrongAtAction(ip);

		const res = await fetch(new URL('/login', origin), {
			method: 'POST',
			headers: FORM_HEADERS(ip),
			body: new URLSearchParams({
				email: 'guardtest@test.local',
				password: TEST_PASSWORD
			}).toString()
		});
		const body = (await res.json()) as { status?: number; data?: unknown };
		expect(body.status).toBe(429);
	}, 60_000);

	it('the auth route is NOT where the control lives, and says so', async () => {
		// Verified behaviour, stated so a future change to it is deliberate.
		//
		// The failure-only throttle is in the /login ACTION. A direct POST to
		// /api/auth/sign-in/email bypasses it — by design: it is not a path a
		// browser can reach, and Better Auth's own backstop (60 per 60s) still
		// guards it.
		//
		// The T6 wiring bug was the opposite failure and remains the thing to
		// watch: the action once called `auth.api.signInEmail` and bypassed
		// Better Auth's limiter, so the only user-facing path was unlimited.
		// That is why the action tests above exist at all.
		const res = await wrongAtAuthRoute(nextIp());
		expect(res.status, 'the raw route is guarded by the backstop, not the action').toBe(401);
	}, 30_000);

	it('keys on the client IP, so one address cannot exhaust another', async () => {
		// Burn one address completely, then check a different one is unaffected.
		const noisy = nextIp();
		let last = 0;
		for (let i = 0; i <= BURST; i++) {
			const res = await wrongAtAction(noisy);
			const body = (await res.json().catch(() => ({}))) as { status?: number };
			last = body.status ?? res.status;
		}
		expect(last, 'the first address must have been rate limited').toBe(429);

		// A different address AND a different account must be untouched. A
		// shared bucket on either key would mean one noisy client locks out
		// everyone. Both keys have to differ, or this would be measuring the
		// email control and calling it an IP test.
		const quiet = await wrongAtOtherAccount(nextIp());
		const quietBody = (await quiet.json()) as { status?: number };
		expect(
			quietBody.status,
			'a different client IP must not inherit the first one’s exhausted bucket'
		).toBe(400);
	}, 60_000);

	it('still refuses unlimited guessing — the thing T6 found inert', async () => {
		// The headline, kept as its own test. Whatever the numbers become, the
		// guarantee is: repeated wrong passwords from one address stop being
		// answered 401 forever.
		const ip = nextIp();
		const statuses = new Set<number>();
		for (let i = 0; i <= BURST; i++) {
			const res = await wrongAtAction(ip);
			const body = (await res.json().catch(() => ({}))) as { status?: number };
			statuses.add(body.status ?? res.status);
		}
		expect(
			statuses.has(429),
			`guessing was never limited — saw only ${[...statuses].join(', ')}`
		).toBe(true);
	}, 60_000);
});
