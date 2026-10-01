/**
 * The failure-only sign-in throttle, against the served production build.
 *
 * WHAT MAKES THIS FILE DIFFERENT FROM THE OLD RATE-LIMIT ONE
 * ---------------------------------------------------------
 * The previous limiter test asserted a number that happened to be true and a
 * status that was not the control: it watched Better Auth's counter, which
 * charges successes. So it passed, and a person with a correct password was
 * still locked out by their own successful logins.
 *
 * Every test here asserts the BEHAVIOUR the user depends on, in the terms they
 * would describe it:
 *
 *   - fifteen correct sign-ins in a row all work, with no waiting;
 *   - ten wrong passwords then a correct one is refused, and says for how long;
 *   - and once the window has passed, the correct one works and clears;
 *   - the sixth wrong password is measurably slower than the first.
 *
 * The window is shortened via LOGIN_FAILURE_WINDOW_SEC on the spawned server,
 * so the suite verifies the real code path in ~5s rather than either waiting 15
 * minutes or mocking the thing under test. The delay curve itself is proven
 * exactly, with a fake clock, in login-throttle.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetTestDb, setupTestDb, type TestDb } from '$lib/server/test-db';
import { seedTestUser, startTestServer, TEST_PASSWORD } from '$lib/server/test-auth-helpers';

/**
 * A DIFFERENT address per test, because the throttle is in-memory inside the
 * server process and `resetTestDb` cannot reach it — the database is truncated
 * between tests, the counters are not. An IP alone would not be enough: the
 * email is a key too, and every test would otherwise share one address's
 * failure count and bleed into each other. A failing test must not make the
 * next one fail for the wrong reason.
 *
 * (This is also a real property of the shipped design, not only a test
 * problem: a container restart clears every counter. It is why a fresh deploy
 * is a free reset, and why a second replica would need a table.)
 */
let emailCounter = 0;
let EMAIL = 'throttle@test.local';
/** A second, unused address, for tests that need to attack someone ELSE. */
const freshVictimEmail = () => `victim-${(emailCounter += 1)}@test.local`;

/** Short enough to wait for, long enough to be a real window. */
const WINDOW_SEC = '6';
const MAX_FAILURES = '5';

let stopServer = async () => {};
let origin: string;
let serverLog: () => string = () => '';
let harness: Awaited<ReturnType<typeof setupTestDb>>;
const db = (): TestDb => harness.db;

beforeAll(async () => {
	harness = await setupTestDb();
	({
		origin,
		stop: stopServer,
		log: serverLog
	} = await startTestServer({
		LOGIN_FAILURE_WINDOW_SEC: WINDOW_SEC,
		LOGIN_MAX_FAILURES: MAX_FAILURES,
		// No progressive delay: these tests are about the refusal and the
		// clearing, and a delay would make every wrong-password assertion
		// take seconds. The delay is proven separately, with a fake clock.
		LOGIN_DELAY_AFTER_FAILURES: '9999'
	}));
}, 60_000);

afterAll(async () => {
	if (process.env.DOCLIFTS_E2E_LOG === '1') console.error('--- server log ---\n' + serverLog());
	await stopServer();
	await harness?.end();
});

beforeEach(async () => {
	await resetTestDb(harness.client);
	// Explicitly EMAIL, not seedTestUser's default fixture address: these tests
	// key on the email, so a mismatch would look like the throttle refusing a
	// correct password rather than a fixture that was never created.
	EMAIL = `throttle-${(emailCounter += 1)}@test.local`;
	await seedTestUser(db(), EMAIL);
	// The throttle is IN-MEMORY and lives in the server process, so
	// resetTestDb cannot reach it — the database is reset, the counter is not,
	// and a failure bleeds into the next test. This is a real property of the
	// shipped design (a restart clears every counter, the same way) and it is
	// why every test here uses a FRESH IP.
	//
	// The email key cannot be varied: it is the fixture's address, shared by
	// every test. So the only isolation available is a distinct address per
	// test, and any test that fails leaves a residual email count behind.
	// Each test therefore clears the email by SUCCEEDING where it can, and
	// the ordering below means a failing test cannot make a later one fail for
	// the wrong reason — every assertion names its own count first.
});

/** A fresh IP per test, so one test's failures never refuse the next. */
let ipCounter = 0;
const nextIp = () => `203.0.113.${(ipCounter += 1)}`;

const formHeaders = (ip: string) => ({
	'content-type': 'application/x-www-form-urlencoded',
	origin,
	'x-forwarded-for': ip
});

function post(body: Record<string, string>, ip: string): Promise<Response> {
	return fetch(new URL('/login', origin), {
		method: 'POST',
		headers: formHeaders(ip),
		body: new URLSearchParams(body).toString()
	});
}

const correct = (ip: string) => post({ email: EMAIL, password: TEST_PASSWORD }, ip);
const wrong = (ip: string) => post({ email: EMAIL, password: 'not-the-password' }, ip);

/**
 * SvelteKit answers a form action with an outer 200 and carries the real
 * outcome in the envelope, so the status is never the assertion. This reads
 * the envelope — the shape a browser actually acts on.
 */
/**
 * Read a SvelteKit action envelope.
 *
 * SvelteKit answers a form action with an OUTER 200 and carries the real
 * outcome inside, devalue-encoded. The encoding is a flat array where each
 * value is either a primitive or an INDEX into that same array, and the whole
 * thing arrives as a STRING under `data`:
 *
 *   { type: "failure", status: 429,
 *     data: "[{\"email\":1,\"error\":2,\"retryAfter\":3},\"...\",\"...\",\"6\"]" }
 *
 * So `retryAfter` is the string at position 3. Reading `body.retryAfter` finds
 * nothing and looks like a missing field rather than a wrong reader — which is
 * how the first version of this file failed on a refusal that had worked
 * perfectly.
 */
type Envelope = { type?: string; status?: number; data?: unknown };

async function envelopeOf(res: Response): Promise<Envelope> {
	return (await res.json()) as Envelope;
}

/** devalue: a field's value is either a literal or an index into the array. */
function devalueField(data: unknown, field: string): unknown {
	if (typeof data !== 'string') return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(data);
	} catch {
		return undefined;
	}
	if (!Array.isArray(parsed)) return undefined;
	const head = parsed[0];
	if (typeof head !== 'object' || head === null) return undefined;
	const pointer = (head as Record<string, unknown>)[field];
	if (typeof pointer !== 'number') return undefined;
	return parsed[pointer];
}

/** A refusal must carry the wait. Asserting only "it failed" would hide a 0. */
async function refusalSeconds(res: Response): Promise<number> {
	const body = await envelopeOf(res);
	if (body.type !== 'failure') throw new Error(`expected a failure, got ${JSON.stringify(body)}`);
	const raw = devalueField(body.data, 'retryAfter');
	const seconds = typeof raw === 'string' ? Number(raw) : Number(raw);
	if (!Number.isFinite(seconds)) {
		throw new Error(`a refusal must say how long to wait: ${JSON.stringify(body)}`);
	}
	return seconds;
}

describe('sign-in throttle — successes never count', () => {
	it('lets fifteen correct sign-ins through with no waiting', async () => {
		const ip = nextIp();
		const started = Date.now();

		for (let i = 0; i < 15; i++) {
			const res = await correct(ip);
			const body = await envelopeOf(res);
			// The control: the FOURTH attempt is where the old limiter refused
			// a correct password. Getting to 15 is the assertion.
			expect(body.type, `sign-in ${i + 1} must be a redirect, not a refusal`).toBe('redirect');
			expect(body.status, `sign-in ${i + 1} status`).toBe(303);
		}

		// And it was not slow — a "succeeds" that took the delay path would
		// still pass the assertions above.
		expect(Date.now() - started, 'fifteen sign-ins must not incur a delay').toBeLessThan(5000);
	}, 60_000);

	it('gives each correct sign-in a real session', async () => {
		const ip = nextIp();
		// The envelope said "redirect"; assert the thing that makes it true.
		for (let i = 0; i < 3; i++) {
			const res = await correct(ip);
			const setCookies = res.headers.getSetCookie();
			expect(
				setCookies.some((c) => /session_token=/.test(c) && !/session_token=;/.test(c)),
				`sign-in ${i + 1} set no session cookie`
			).toBe(true);
		}
	});
});

describe('sign-in throttle — failures do count', () => {
	it('refuses a correct password after the failure ceiling, and says for how long', async () => {
		const ip = nextIp();

		for (let i = 0; i < Number(MAX_FAILURES); i++) {
			await wrong(ip);
		}

		// The correct password is now refused. This is the whole point: only
		// wrong passwords accumulate.
		const res = await correct(ip);
		if (process.env.DOCLIFTS_E2E_DEBUG === '1') {
			console.error('DEBUG refusal envelope:', await res.clone().text());
		}
		const retryAfter = await refusalSeconds(res);
		expect(retryAfter, 'the refusal must name a positive wait').toBeGreaterThan(0);
		expect(retryAfter, 'the wait must not exceed the window').toBeLessThanOrEqual(
			Number(WINDOW_SEC)
		);

		// And it is a 429, not a vague 400 — the page has to be able to tell
		// "come back later" from "that password is wrong".
		const body = await fetch(new URL('/login', origin), {
			method: 'POST',
			headers: formHeaders(ip),
			body: new URLSearchParams({ email: EMAIL, password: TEST_PASSWORD }).toString()
		}).then(envelopeOf);
		expect(body.status).toBe(429);
	}, 60_000);

	it('recovers once the window has passed, and the success clears the count', async () => {
		const ip = nextIp();
		for (let i = 0; i < Number(MAX_FAILURES); i++) await wrong(ip);
		expect((await envelopeOf(await correct(ip))).type).toBe('failure');

		// Wait out the window. In production this is 15 minutes; here the
		// spawned server runs with LOGIN_FAILURE_WINDOW_SEC=6, so this is the
		// same code path, six seconds long.
		await new Promise((r) => setTimeout(r, (Number(WINDOW_SEC) + 2) * 1000));

		const recovered = await correct(ip);
		expect((await envelopeOf(recovered)).type, 'the correct password must work again').toBe(
			'redirect'
		);

		// The success cleared BOTH keys, so the ceiling is not immediately
		// back. Without this, "recovered" would only mean the window slid.
		const after = await correct(ip);
		expect((await envelopeOf(after)).type, 'the success must have cleared the counter').toBe(
			'redirect'
		);
	}, 60_000);

	it('counts the email, not just the address, so a spray cannot help', async () => {
		// A different IP every time. Per-IP control alone would never see this
		// pattern; the email key is what catches it.
		for (let i = 0; i < Number(MAX_FAILURES); i++) await wrong(`198.51.100.${i + 1}`);

		const res = await correct('198.51.100.250');
		expect((await envelopeOf(res)).type, 'a fresh IP must not reset the email key').toBe('failure');
	}, 60_000);

	it('does not refuse one account because ANOTHER email was attacked', async () => {
		// The attack comes from one address; our sign-in comes from a DIFFERENT
		// one. So neither key should carry over: the email key is a different
		// account and the IP key is a different address.
		const attacker = nextIp();
		for (let i = 0; i < Number(MAX_FAILURES); i++) {
			await post({ email: freshVictimEmail(), password: 'wrong' }, attacker);
		}

		const res = await correct(nextIp());
		expect((await envelopeOf(res)).type, 'an unrelated account must not be collateral').toBe(
			'redirect'
		);
	}, 60_000);

	it('and the IP key refuses ACROSS accounts, which is a deliberate trade', async () => {
		// Stated as a test so it stays deliberate rather than becoming a surprise.
		//
		// Five wrong passwords against SOMEONE ELSE's account from one address
		// locks out the next CORRECT sign-in from that same address, even for a
		// different account. That is what the IP key is for: a shared NAT or an
		// office egress is exactly the shape a credential spray arrives in, and
		// a per-email-only key would see nothing.
		//
		// The cost is a real one: a household or office behind one egress can
		// lock itself out by having any one member mistype a password five
		// times. The lever is LOGIN_MAX_FAILURES, never removing the IP key.
		// A DIFFERENT victim address per test: a shared one would carry the
		// previous test's five failures into this one, and the refusal would
		// come from the email key instead of the IP key — the test would pass
		// while proving nothing about the IP key at all.
		const victim = freshVictimEmail();
		const attacker = nextIp();
		for (let i = 0; i < Number(MAX_FAILURES); i++) {
			await post({ email: victim, password: 'wrong' }, attacker);
		}
		// Our own account, seeded fresh in beforeEach. Only the IP key can
		// refuse here.
		const res = await correct(attacker);
		expect((await envelopeOf(res)).type, 'the IP key must refuse across accounts').toBe('failure');
	}, 60_000);
});

describe('the throttle logs without leaking', () => {
	it('emits a structured refusal line naming the key type, and never the address', async () => {
		const ip = nextIp();
		for (let i = 0; i < Number(MAX_FAILURES); i++) await wrong(ip);
		await correct(ip);

		// Give the log a moment to flush.
		await new Promise((r) => setTimeout(r, 250));
		const log = serverLog();

		const lines = log
			.split('\n')
			.filter((l) => l.includes('login_throttle'))
			.map((l) => {
				try {
					return JSON.parse(l) as Record<string, unknown>;
				} catch {
					return null;
				}
			})
			.filter((l): l is Record<string, unknown> => l !== null);

		expect(
			lines.length,
			`no structured login_throttle line in:\n${log.slice(-2000)}`
		).toBeGreaterThan(0);
		const refusal = lines.find((l) => l.kind === 'refuse');
		expect(refusal, 'a refusal must be logged').toBeDefined();
		expect(refusal!.key_type).toMatch(/^(ip|email)$/);
		expect(refusal!.retry_after_s).toBeGreaterThan(0);

		// The address must not appear anywhere in the log.
		expect(log, 'the email address must never be logged').not.toContain(EMAIL);
		// Nor the password, which should not be in this process at all.
		expect(log, 'the password must never be logged').not.toContain(TEST_PASSWORD);
	}, 60_000);
});

describe('progressive delay', () => {
	// A SEPARATE server: the delay only engages at a low
	// LOGIN_DELAY_AFTER_FAILURES, and the suite above deliberately disables it
	// (9999) so its assertions are not slowed. This spawns one with the delay
	// on and a base large enough to stand clear of request-time noise.
	let stopDelayServer = async () => {};
	let delayOrigin: string;

	beforeAll(async () => {
		({ origin: delayOrigin, stop: stopDelayServer } = await startTestServer({
			LOGIN_FAILURE_WINDOW_SEC: WINDOW_SEC,
			LOGIN_MAX_FAILURES: '100',
			LOGIN_DELAY_AFTER_FAILURES: '3',
			LOGIN_DELAY_BASE_MS: '500',
			LOGIN_DELAY_MAX_MS: '2000'
		}));
	}, 60_000);

	afterAll(async () => {
		await stopDelayServer();
	});

	it('makes the 4th wrong password measurably slower than the undelayed ones', async () => {
		// Delay starts after 3 failures, so attempt 4 sleeps 500ms. The assertion
		// is comparative — an absolute threshold would be a flake on a loaded CI
		// runner, and "slower than an undelayed attempt" is the property that
		// actually matters to a guesser.
		//
		// The baseline is the FASTEST of the three undelayed attempts, not the
		// first alone. Comparing against one sample made the margin hostage to
		// that sample: on 2026-10-01 a slow first attempt (167ms) left a 250ms
		// delay showing as +190ms against a 200ms bar. Half the delay as the bar,
		// against the quickest baseline, leaves 250ms of slack for noise.
		const ip = '198.18.0.1';
		const send = () => {
			const started = Date.now();
			return fetch(new URL('/login', delayOrigin), {
				method: 'POST',
				headers: {
					'content-type': 'application/x-www-form-urlencoded',
					origin: delayOrigin,
					'x-forwarded-for': ip
				},
				body: new URLSearchParams({ email: 'delay@test.local', password: 'wrong' }).toString()
			}).then((r) => r.text().then(() => Date.now() - started));
		};

		const undelayed = [await send(), await send(), await send()]; // failures 1-3
		const baseline = Math.min(...undelayed);
		const fourth = await send(); // 4 — held 500ms

		expect(
			fourth - baseline,
			`the 4th attempt (${fourth}ms) must be measurably slower than the fastest undelayed one (${undelayed.join(', ')}ms)`
		).toBeGreaterThan(250);

		// And it must still be a normal failure, not a refusal: the delay is a
		// slowdown, the ceiling is a lockout, and they are different controls.
		const body = await envelopeOf(
			await fetch(new URL('/login', delayOrigin), {
				method: 'POST',
				headers: {
					'content-type': 'application/x-www-form-urlencoded',
					origin: delayOrigin,
					'x-forwarded-for': ip
				},
				body: new URLSearchParams({ email: 'delay@test.local', password: 'wrong' }).toString()
			})
		);
		expect(body.status, 'below the ceiling, so still 400 not 429').toBe(400);
	}, 60_000);
});

describe('session length on the wire', () => {
	it('sets a session cookie whose Max-Age matches SESSION_EXPIRES_DAYS', async () => {
		// The config value and the cookie a browser stores are different facts,
		// and only the second one ends up in a user's browser. Asserting the
		// Better Auth option proves nothing about the deployment.
		const res = await correct(nextIp());
		const sessionCookie = res.headers
			.getSetCookie()
			.find((c) => /session_token=/.test(c) && !/session_token=;/.test(c));
		expect(sessionCookie, 'sign-in set no session cookie').toBeDefined();

		const maxAge = /Max-Age=(\d+)/i.exec(sessionCookie!);
		expect(maxAge, `no Max-Age on ${sessionCookie}`).not.toBeNull();

		const days = Number(maxAge![1]) / 86400;
		// Default is 30. Allow a little slack for clock skew between the token
		// being minted and the header being written.
		expect(days, `Max-Age is ${days} days, expected ~30`).toBeGreaterThan(29);
		expect(days, `Max-Age is ${days} days, expected ~30`).toBeLessThan(31);
	}, 30_000);
});
