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
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import {
	BUILD_ENTRY,
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

/** As csp.e2e.ts: a browser is required in CI, skipped with a warning locally. */
function chromiumPath(): string | undefined {
	if (process.env.PW_EXECUTABLE_PATH) return process.env.PW_EXECUTABLE_PATH;
	try {
		const p = chromium.executablePath();
		return existsSync(p) ? p : undefined;
	} catch {
		return undefined;
	}
}
const executablePath = chromiumPath();
const haveBrowser = Boolean(executablePath) && existsSync(BUILD_ENTRY);
if (!haveBrowser && process.env.CI) {
	throw new Error('e2e prerequisites missing in CI: a Chromium for Playwright, or the build');
}
if (!haveBrowser) console.warn('[e2e] login wait countdown skipped — no Chromium or no build');

declare global {
	interface Window {
		__cspViolations: string[];
	}
}

(haveBrowser ? describe : describe.skip)('/login counts down a held attempt (JS)', () => {
	it('shows the wait ticking while the submit hangs, under the CSP, with a cookie in the jar', async () => {
		const browser = await chromium.launch({ executablePath });
		try {
			const context = await browser.newContext();
			await context.addCookies([{ name: 'theme', value: 'dark', domain: '127.0.0.1', path: '/' }]);
			const page = await context.newPage();
			await page.addInitScript(() => {
				window.__cspViolations = [];
				document.addEventListener('securitypolicyviolation', (e) => {
					window.__cspViolations.push(`${e.violatedDirective}: ${e.blockedURI || 'inline'}`);
				});
			});

			// The browser's own requests carry no x-forwarded-for, so the email
			// key alone counts: a fresh address, used nowhere else in this file.
			const email = 'countdown@test.local';
			const notice = page.locator('#login-wait-notice');
			const hydrated = () => page.getByRole('button', { name: 'Show password' }).waitFor();
			const typeWrong = async () => {
				await page.locator('input[type=email]').fill(email);
				await page.locator('#password').fill('wrong');
			};
			const attempt = async () => {
				await typeWrong();
				await Promise.all([
					page.waitForResponse((r) => r.request().method() === 'POST'),
					page.locator('form button[type=submit]').click()
				]);
				await page.waitForLoadState('load');
				await hydrated();
			};

			await page.goto(new URL('/login', origin).href);
			await hydrated();
			await attempt(); // 1: no wait
			await attempt(); // 2: next held 1 s
			await attempt(); // 3: held 1 s, next held 2 s
			expect(await notice.textContent()).toContain('The next will be held for 2 seconds.');

			// 4: held 2 s. While it hangs, the page says so and counts.
			//
			// Read from INSIDE the page. Playwright's click and evaluate both wait
			// out a pending navigation, which here is the whole hold, so asking
			// "what does it say now?" from outside only ever sees the next page.
			// A MutationObserver writes each version of the notice, with its time
			// since the click, to sessionStorage, which survives the same-origin
			// navigation the submit ends in.
			await typeWrong();
			const response = page.waitForResponse((r) => r.request().method() === 'POST');
			await page.evaluate(() => {
				const started = Date.now();
				const el = document.getElementById('login-wait-notice')!;
				sessionStorage.setItem('seen', '[]');
				new MutationObserver(() => {
					const seen = JSON.parse(sessionStorage.getItem('seen') ?? '[]');
					seen.push({ at: Date.now() - started, text: el.textContent ?? '' });
					sessionStorage.setItem('seen', JSON.stringify(seen));
				}).observe(el, { subtree: true, childList: true, characterData: true });
				document.querySelector<HTMLButtonElement>('form button[type=submit]')!.click();
			});
			await response;
			await page.waitForLoadState('load');
			expect(await notice.textContent()).toContain('This one was held for 2 seconds.');

			const seen = (await page.evaluate(() =>
				JSON.parse(sessionStorage.getItem('seen') ?? '[]')
			)) as { at: number; text: string }[];
			const said = (phrase: string) => seen.find((s) => s.text.includes(phrase));
			// At once, the announced wait; a second later, one less. A static
			// sentence would pass the first and fail the second.
			const two = said('your password will be checked in 2 seconds.');
			const one = said('your password will be checked in 1 second.');
			expect(two, `no countdown while held; saw ${JSON.stringify(seen)}`).toBeDefined();
			expect(two!.at).toBeLessThan(500);
			expect(one, `the countdown did not tick; saw ${JSON.stringify(seen)}`).toBeDefined();
			expect(one!.at).toBeGreaterThan(two!.at);
			// The same audit as csp.e2e.ts: no app element carries a style
			// attribute, and the only tolerated violation is SvelteKit's own
			// #svelte-announcer (style-src-attr).
			const styled = await page.evaluate(() =>
				[...document.querySelectorAll('[style]')].map((e) => e.id || e.tagName.toLowerCase())
			);
			expect(styled.filter((id) => id !== 'svelte-announcer')).toEqual([]);
			const violations = await page.evaluate(() => window.__cspViolations);
			expect(violations.filter((v) => !v.startsWith('style-src-attr'))).toEqual([]);
		} finally {
			await browser.close();
		}
	}, 60_000);
});
