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

/**
 * The status SvelteKit's action envelope reports.
 *
 * A form-action response is HTTP 200 with a JSON body regardless of whether the
 * action called `fail(400)` or `fail(429)`. The real outcome is `type`/`status`
 * inside. Reading the HTTP status instead would make every assertion in this
 * file vacuously true — which is precisely the bug class this suite exists to
 * prevent, so the helper is named to make the distinction obvious at the call
 * site.
 */
function parseEnvelope(res: Response): Promise<ActionEnvelope> {
	return res.json() as Promise<ActionEnvelope>;
}

type ActionEnvelope = {
	type?: string;
	status?: number;
	location?: string;
	/** SvelteKit serialises `fail()` data as devalue, not JSON. */
	data?: unknown;
};

async function actionStatus(res: Response): Promise<number> {
	const body = await parseEnvelope(res);
	expect(body.type, `unexpected envelope: ${JSON.stringify(body).slice(0, 300)}`).toBe('failure');
	return body.status ?? 0;
}

/**
 * Decode SvelteKit's `fail()` payload.
 *
 * SvelteKit serialises action data with devalue, not JSON, so `data` arrives as
 * a nested array of values plus an index table rather than an object. Asserting
 * against the raw array would be asserting against an implementation detail
 * that changes between SvelteKit versions; this reads the two fields the login
 * page actually renders and fails loudly if the shape is not what it expects.
 */
function decodeFailData(data: unknown): { error?: string; retryAfter?: string | null } {
	// The exact shape, captured from the served build:
	//
	//   {"type":"failure","status":429,
	//    "data":"[{\"email\":1,\"error\":2,\"retryAfter\":3},\"nobody@example.com\",
	//            \"Too many sign-in attempts. Try again shortly.\",\"10\"]"}
	//
	// So `data` is a STRING containing the devalue output: a flat array of
	// values whose FIRST element is the key map, followed by the values, and a
	// trailing index pointing at the root object within them.
	//
	// The trailing "10" is `retryAfter` — Better Auth sends no Retry-After
	// header on a 429, so that is the action's fallback to the limiter's own
	// window, and it is what the page renders.
	const envelopeText = data as string;
	expect(typeof envelopeText, `fail() data should be a JSON string, got ${typeof data}`).toBe(
		'string'
	);

	const flat = JSON.parse(envelopeText) as [Record<string, number>, ...unknown[]];
	expect(Array.isArray(flat), 'devalue payload should be an array').toBe(true);

	// flat[0] is the key map, and its values index `flat` DIRECTLY — no +1
	// offset. Verified against the captured payload:
	//
	//   [ {"email":1,"error":2,"retryAfter":3},
	//     "nobody@example.com",            <- flat[1]
	//     "Too many sign-in attempts...",  <- flat[2]
	//     "10" ]                           <- flat[3]
	//
	// Getting this wrong silently returns the wrong string rather than
	// throwing, which is why the assertion below checks the CONTENT.
	const keys = flat[0] as Record<string, number>;
	const valueOf = (key: string): unknown => {
		const idx = keys[key];
		expect(idx, `fail() data has no "${key}" key`).toBeTypeOf('number');
		return flat[idx];
	};

	return { error: valueOf('error') as string, retryAfter: valueOf('retryAfter') as string | null };
}

describe('sign-in rate limit', () => {
	it('refuses the 4th attempt to /login inside the window, and names the wait', async () => {
		const ip = '203.0.113.10';

		// The limiter counts EVERY request, including the first, so MAX_ATTEMPTS
		// allowed means the (MAX_ATTEMPTS + 1)th is refused. Verified directly:
		// four sign-in POSTs from one IP return 401, 401, 429, 429.
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
			//
			// SvelteKit action responses are a JSON envelope, not a rendered
			// page, and the HTTP status is 200 for BOTH fail(400) and fail(429).
			// The status code inside the envelope is the thing to assert —
			// asserting the response status alone would pass for every attempt
			// including the blocked one, which is the bug this file exists to
			// catch. Hence actionStatus() below.
			expect(await actionStatus(res), `attempt ${i} should still be allowed`).toBe(400);
		}

		// Read the envelope ONCE and assert both the status and the payload from
		// it. Calling actionStatus() and then .json() reads the body twice and
		// throws "Body is unusable" — which is a test bug, not a product bug, and
		// worth avoiding because it masks the real assertion underneath.
		const blocked = await parseEnvelope(await wrongPassword(ip));

		expect(blocked.type).toBe('failure');
		expect(blocked.status).toBe(429);

		// The payload the page component actually renders, so a message that
		// stops reaching the template fails here rather than in front of a user.
		const data = decodeFailData(blocked.data);
		expect(data.error).toContain('Too many sign-in attempts');
		expect(data.retryAfter).toBeTruthy();
		// Better Auth sends no Retry-After, so this is the action's fallback to
		// the limiter's own window. It is the number the page shows, so it has
		// to be inside the window it describes.
		expect(Number(data.retryAfter)).toBeGreaterThan(0);
		expect(Number(data.retryAfter)).toBeLessThanOrEqual(WINDOW_SECONDS);

		// The ACTION's own rendering, not a raw framework 429: the login page
		// must show a message and a wait rather than redirect to a blank form.
	}, 30_000);

	it('refuses the 4th attempt at the auth route too — the two paths agree', async () => {
		const ip = '203.0.113.20';

		for (let i = 1; i <= MAX_ATTEMPTS; i++) {
			expect((await wrongPasswordAtAuthRoute(ip)).status, `attempt ${i}`).toBe(401);
		}
		const blocked = await wrongPasswordAtAuthRoute(ip);

		// This path was ALWAYS limited — it is the one the limiter is designed
		// for, and it is public by `isPublicPath` design. Asserting both paths
		// hit the same threshold is what proves the sign-in fix is a real
		// re-route and not a second, differently-configured limiter.
		//
		// This is a RAW Better Auth response, not a SvelteKit envelope, so its
		// HTTP status and its Retry-After header are the ones to read — the
		// /login action translates both into its own 200 + failure envelope.
		expect(blocked.status).toBe(429);
		// 1.7.6 sends no Retry-After at all. Asserted as absent rather than
		// ignored, so a future version that adds the header fails here and gets
		// a deliberate decision instead of silently changing what /login shows.
		expect(blocked.headers.get('retry-after')).toBeNull();
	}, 30_000);

	it('lets a correct password in once the window has passed', async () => {
		const ip = '203.0.113.30';

		// Burn the bucket and confirm it is actually burnt — otherwise this
		// test would pass against a limiter that never engaged.
		for (let i = 0; i <= MAX_ATTEMPTS; i++) await wrongPassword(ip);
		expect(await actionStatus(await wrongPassword(ip))).toBe(429);

		await new Promise((r) => setTimeout(r, (WINDOW_SECONDS + 1) * 1000));

		// A correct password is a SUCCESS envelope carrying the redirect the
		// action threw, not a raw 303: SvelteKit catches the redirect and
		// serialises it into the action response. Asserting the HTTP status
		// here would have read 200 and looked like a failure to sign in.
		const allowed = await correctPassword(ip);
		const body = (await allowed.json()) as {
			type?: string;
			status?: number;
			location?: string;
		};
		expect(body.type).toBe('redirect');
		expect(body.status).toBe(303);
		expect(body.location).toBe('/');
		expect(allowed.headers.get('set-cookie') ?? '').toContain('better-auth.session_token');
	}, 45_000);

	it('keys on the client IP, not the account', async () => {
		// Two IPs, same account. The second is unaffected, which is what makes
		// this a per-IP control and NOT per-account lockout. Recorded in
		// docs/migrations.md as the second control to add if the app goes
		// public.
		const blockedIp = '203.0.113.40';
		for (let i = 0; i <= MAX_ATTEMPTS; i++) await wrongPassword(blockedIp);
		expect(await actionStatus(await wrongPassword(blockedIp))).toBe(429);

		const other = await correctPassword('203.0.113.41');
		expect(((await other.json()) as { type?: string }).type).toBe('redirect');
	}, 30_000);
});
