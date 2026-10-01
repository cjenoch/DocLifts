/**
 * The login page states the throttle's wait — spec item 4 (0.2.2), shipped in
 * 0.2.5: "When the throttle delays or refuses, the page says so with the
 * number of seconds. Never a silent wait."
 *
 * Production runs with the ceiling off (LOGIN_MAX_FAILURES=0), so the delay
 * curve is the only throttle actually live, and at its 30 s cap a silent wait
 * reads as a hung page. These tests read the page a person without JavaScript
 * would get — the rendered HTML of the form POST — and assert the sentences on
 * it, not the action envelope.
 *
 * Every request carries an unrelated cookie (CLAUDE.md): the origin check runs
 * only when a cookie is present, and production always has one.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	freshTestDb,
	seedTestUser,
	startTestServer,
	TEST_PASSWORD
} from '$lib/server/test-auth-helpers';

const EMAIL = 'wait-notice@test.local';
/** No account behind it. The page must say exactly the same things. */
const NO_ACCOUNT = 'no-such-account@test.local';
const UNRELATED_COOKIE = 'theme=dark';

let stopServer = async () => {};
let origin: string;
let harness: Awaited<ReturnType<typeof freshTestDb>>;

beforeAll(async () => {
	harness = await freshTestDb();
	await seedTestUser(harness.db, EMAIL);
	({ origin, stop: stopServer } = await startTestServer({
		// Production's shape: ceiling off, delay curve live. Started at the 3rd
		// attempt with a 1 s base and a 2 s cap so the whole curve — no wait,
		// announced wait, served wait — fits in a few seconds.
		LOGIN_MAX_FAILURES: '0',
		LOGIN_FAILURE_WINDOW_SEC: '120',
		LOGIN_DELAY_AFTER_FAILURES: '2',
		LOGIN_DELAY_BASE_MS: '1000',
		LOGIN_DELAY_MAX_MS: '2000'
	}));
}, 120_000);

afterAll(async () => {
	await stopServer();
	await harness?.end();
});

/** A no-JS form submit: the browser renders whatever HTML comes back. */
async function submit(email: string, password: string, ip: string) {
	const started = Date.now();
	const res = await fetch(new URL('/login', origin), {
		method: 'POST',
		headers: {
			'content-type': 'application/x-www-form-urlencoded',
			accept: 'text/html',
			origin,
			cookie: UNRELATED_COOKIE,
			'x-forwarded-for': ip
		},
		body: new URLSearchParams({ email, password }).toString(),
		redirect: 'manual'
	});
	const html = await res.text();
	return { res, html, ms: Date.now() - started };
}

/** The visible text of an element by id, or null when it is not rendered. */
function textOf(html: string, id: string): string | null {
	const m = new RegExp(`<p[^>]*id="${id}"[^>]*>([\\s\\S]*?)</p>`).exec(html);
	if (!m) return null;
	return m[1]
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<[^>]+>/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

const notice = (html: string) => textOf(html, 'login-wait-notice');
const MISMATCH = 'That email and password do not match.';

describe('/login states the throttle wait', () => {
	const seenForAccount: (string | null)[] = [];

	it('announces the wait before it happens, then says how long the attempt was held', async () => {
		const ip = '203.0.113.50';

		// 1st wrong password: nothing to wait for, nothing announced.
		const first = await submit(EMAIL, 'wrong', ip);
		expect(first.html).toContain(MISMATCH);
		expect(notice(first.html), 'no wait yet, so no notice').toBeNull();

		// 2nd: the threshold is reached. This attempt was not held, but the NEXT
		// one will be — and the page says so before the user submits it.
		const second = await submit(EMAIL, 'wrong', ip);
		expect(second.html).toContain(MISMATCH);
		const announced = notice(second.html);
		expect(announced, 'the coming wait must be announced').toContain(
			'The next will be held for 1 second.'
		);
		expect(announced).not.toContain('This one was held');

		// 3rd: held for the announced second, and the page says so — beside the
		// mismatch, not instead of it — and names the next, longer wait.
		const third = await submit(EMAIL, 'wrong', ip);
		expect(third.ms, 'the 3rd attempt must actually have been held').toBeGreaterThanOrEqual(900);
		expect(third.html, 'the outcome is still stated').toContain(MISMATCH);
		const held = notice(third.html);
		expect(held).toContain('This one was held for 1 second.');
		expect(held).toContain('The next will be held for 2 seconds.');
		expect(held, 'the notice is not the mismatch message').not.toContain('do not match');

		seenForAccount.push(notice(first.html), announced, held);

		// The wait slows; it never locks. The correct password, held for the
		// announced 2 s, still signs in.
		const ok = await submit(EMAIL, TEST_PASSWORD, ip);
		expect(ok.ms).toBeGreaterThanOrEqual(1900);
		expect(ok.res.status).toBe(303);
		expect(ok.res.headers.getSetCookie().some((c) => /session_token=[^;]/.test(c))).toBe(true);
	}, 60_000);

	it('says exactly the same for an address with no account', async () => {
		// Same sequence from a different IP, so only this address's own count
		// is in play. A different notice here would tell a guesser which
		// addresses are real.
		expect(seenForAccount, 'run after the test above').toHaveLength(3);
		const ip = '203.0.113.51';
		const seen: (string | null)[] = [];
		for (let i = 0; i < 3; i++) {
			const r = await submit(NO_ACCOUNT, 'wrong', ip);
			expect(r.html).toContain(MISMATCH);
			seen.push(notice(r.html));
		}
		expect(seen).toEqual(seenForAccount);
	}, 60_000);
});
