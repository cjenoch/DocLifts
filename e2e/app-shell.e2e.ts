/**
 * 0.5.5 (spec 0.5.0 Part E): the app shell on a phone-width screen, for a
 * brand-new empty account, through the PRODUCTION build in a real browser.
 * First run on Home, the empty states, the bottom tabs, the account page one
 * tap from anywhere, sign-out from it, the open workout's own bar replacing
 * the tabs, and the home-screen manifest and icons. Strings come from
 * `appShell` and `workoutUi`, never literals.
 *
 * Prerequisites and skip rules are the same as csp.e2e.ts.
 */
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { setupTestDb } from '$lib/server/test-db';
import {
	BUILD_ENTRY,
	freshTestDb,
	seedTestUser,
	signInAs,
	startTestServer
} from '$lib/server/test-auth-helpers';
import * as s from '$lib/server/db/schema';
import { appShell } from '$lib/app-shell';
import { workoutUi } from '$lib/workout-ui';

function chromiumPath(): string | undefined {
	if (process.env.PW_EXECUTABLE_PATH) return process.env.PW_EXECUTABLE_PATH;
	try {
		const p = chromium.executablePath();
		return existsSync(p) ? p : undefined;
	} catch {
		return undefined;
	}
}
const haveBuild = existsSync(BUILD_ENTRY);
const executablePath = chromiumPath();
const missing = [
	...(haveBuild ? [] : [`${BUILD_ENTRY} (run pnpm build)`]),
	...(executablePath ? [] : ['a Chromium for Playwright'])
];
if (missing.length && process.env.CI) {
	throw new Error(`e2e prerequisites missing in CI: ${missing.join('; ')}`);
}
const run = missing.length ? describe.skip : describe;
if (missing.length) console.warn(`[e2e] skipped — missing ${missing.join('; ')}`);

declare global {
	interface Window {
		__cspViolations: string[];
	}
}

const WIDTH = 390;
const EMAIL = 'shell-fresh@test.local';

run('app shell for a new account (production build)', () => {
	let harness: Awaited<ReturnType<typeof setupTestDb>>;
	let stopServer = async () => {};
	let origin: string;
	let cookie: string;
	let browser: Browser;
	let userId: string;

	beforeAll(async () => {
		harness = await freshTestDb();
		// A brand-new account: starter exercises only, no gym, program or workout.
		userId = (await seedTestUser(harness.db, EMAIL)).id;
		const started = await startTestServer();
		origin = started.origin;
		stopServer = started.stop;
		cookie = await signInAs(origin, { email: EMAIL });
		browser = await chromium.launch({ executablePath });
	});

	afterAll(async () => {
		await browser?.close();
		await stopServer();
		await harness?.end();
	});

	async function signedInPage(): Promise<Page> {
		const page = await browser.newPage({ viewport: { width: WIDTH, height: 844 } });
		const eqAt = cookie.indexOf('=');
		await page.context().addCookies([
			{
				name: cookie.slice(0, eqAt),
				value: decodeURIComponent(cookie.slice(eqAt + 1)),
				domain: '127.0.0.1',
				path: '/'
			}
		]);
		await page.addInitScript(() => {
			window.__cspViolations = [];
			document.addEventListener('securitypolicyviolation', (e) => {
				window.__cspViolations.push(`${e.violatedDirective} ${e.blockedURI || 'inline'}`);
			});
		});
		return page;
	}
	const violations = async (page: Page) =>
		(await page.evaluate(() => window.__cspViolations)).filter(
			(v) => !v.startsWith('style-src-attr ')
		);
	const tabs = (page: Page) => page.getByRole('navigation', { name: 'Main navigation' });
	const accountButton = (page: Page) =>
		page.getByRole('link', { name: appShell.accountLabel, exact: true });

	it('Home on first run: three lines and one primary button, nothing about programs', async () => {
		const page = await signedInPage();
		await page.goto(`${origin}/`, { waitUntil: 'networkidle' });
		expect(await page.title()).toBe(`Workout · ${appShell.appName}`);
		expect(await page.getByTestId('first-run').getByRole('listitem').allInnerTexts()).toEqual([
			...appShell.firstRunSteps
		]);
		const main = page.locator('div.max-w-md');
		expect(await main.getByRole('link', { name: workoutUi.startWorkout }).count()).toBe(1);
		const text = await main.innerText();
		expect(text).not.toContain('Create program');
		expect(text).not.toContain('Programs');
		expect(text).not.toContain('Imported workout history');
		expect(await violations(page)).toEqual([]);
		await page.close();
	});

	it('Gyms, History and Reports each say what will appear there', async () => {
		const page = await signedInPage();
		for (const [path, line] of [
			['/gyms', appShell.empty.gyms],
			['/history', appShell.empty.history],
			['/reports', appShell.empty.reports]
		] as const) {
			await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
			expect((await page.getByTestId('empty-state').innerText()).trim(), path).toBe(line);
		}
		await page.close();
	});

	it('the tabs are one row at the bottom, on screen, 44 px or taller, and mark the current page', async () => {
		const page = await signedInPage();
		for (const tab of appShell.tabs) {
			await page.goto(`${origin}${tab.href}`, { waitUntil: 'networkidle' });
			const links = await tabs(page).getByRole('link').all();
			expect(await Promise.all(links.map((l) => l.innerText()))).toEqual(
				appShell.tabs.map((t) => t.label)
			);
			const boxes = await Promise.all(links.map((l) => l.boundingBox()));
			for (const [i, box] of boxes.entries()) {
				const name = `${tab.href}: ${appShell.tabs[i].label}`;
				expect(box, name).not.toBeNull();
				expect(box!.x, name).toBeGreaterThanOrEqual(0);
				expect(box!.x + box!.width, name).toBeLessThanOrEqual(WIDTH);
				expect(box!.height, name).toBeGreaterThanOrEqual(44);
				expect(box!.y, `${name} on the same row`).toBe(boxes[0]!.y);
				// At the bottom of the screen, not the top.
				expect(box!.y + box!.height, name).toBeGreaterThan(844 - 100);
			}
			expect(
				await tabs(page).locator('a[aria-current="page"]').innerText(),
				`${tab.href} current`
			).toBe(tab.label);
			const account = await accountButton(page).boundingBox();
			expect(account!.width, 'account button').toBeGreaterThanOrEqual(44);
			expect(account!.height, 'account button').toBeGreaterThanOrEqual(44);
			expect(account!.x + account!.width, 'account button').toBeLessThanOrEqual(WIDTH);
			const scroll = await page.evaluate(() => document.documentElement.scrollWidth);
			expect(scroll, `${tab.href} scrolls sideways`).toBeLessThanOrEqual(WIDTH);
		}
		await page.close();
	});

	it('the account page is one tap from any page and shows the email and change password', async () => {
		const page = await signedInPage();
		await page.goto(`${origin}/reports`, { waitUntil: 'networkidle' });
		expect(await accountButton(page).innerText()).toBe(EMAIL[0].toUpperCase());
		await accountButton(page).click();
		await page.waitForURL(`${origin}/account`);
		expect(await page.title()).toBe(`Account · ${appShell.appName}`);
		expect(await page.getByTestId('account-email').innerText()).toBe(EMAIL);
		await page.getByRole('link', { name: 'Change password' }).click();
		await page.waitForURL(`${origin}/account/password`);
		expect(await violations(page)).toEqual([]);
		await page.close();
	});

	it('an open workout shows its own bar instead of the tabs; finishing brings the tabs back', async () => {
		const page = await signedInPage();
		await page.goto(`${origin}/workout/start`, { waitUntil: 'networkidle' });
		await page.getByLabel(workoutUi.gymStepNewName).fill('Shell gym');
		await page.getByRole('button', { name: workoutUi.gymStepSubmit }).click();
		await page.waitForURL('**/sessions/*');
		expect(await tabs(page).count(), 'tabs during an open workout').toBe(0);
		const bar = page.locator('footer');
		expect(await bar.getByRole('link', { name: 'Add exercise' }).isVisible()).toBe(true);
		expect(await bar.getByRole('button', { name: 'Finish workout' }).isVisible()).toBe(true);
		// The account button is still one tap away.
		expect(await accountButton(page).isVisible()).toBe(true);

		page.once('dialog', (d) => d.accept());
		await bar.getByRole('button', { name: 'Finish workout' }).click();
		await expect.poll(() => tabs(page).count()).toBe(1);
		await page.close();
	});

	it('serves the manifest, the icons and the head tags a home screen install needs', async () => {
		const res = await fetch(`${origin}/manifest.webmanifest`);
		expect(res.status).toBe(200);
		const manifest = await res.json();
		expect(manifest).toMatchObject({
			name: appShell.appName,
			short_name: appShell.appName,
			start_url: '/',
			display: 'standalone'
		});
		const sizes = new Map<string, number>([['/apple-touch-icon.png', 180]]);
		for (const icon of manifest.icons) sizes.set(icon.src, Number(icon.sizes.split('x')[0]));
		expect([...sizes.values()].sort((a, b) => a - b)).toEqual([180, 192, 512]);
		for (const [src, size] of sizes) {
			const icon = await fetch(`${origin}${src}`);
			expect(icon.status, src).toBe(200);
			expect(icon.headers.get('content-type'), src).toBe('image/png');
			const meta = await sharp(Buffer.from(await icon.arrayBuffer())).metadata();
			expect([meta.width, meta.height], src).toEqual([size, size]);
		}

		const page = await signedInPage();
		await page.goto(`${origin}/`, { waitUntil: 'networkidle' });
		const attr = (selector: string, name: string) =>
			page.locator(selector).first().getAttribute(name);
		// By path: SvelteKit's client rewrites icon links to absolute URLs.
		const path = async (selector: string) =>
			new URL((await attr(selector, 'href'))!, origin).pathname;
		expect(await path('link[rel="manifest"]')).toBe('/manifest.webmanifest');
		expect(await path('link[rel="apple-touch-icon"]')).toBe('/apple-touch-icon.png');
		expect(await attr('meta[name="theme-color"]', 'content')).toBeTruthy();
		expect(await attr('meta[name="viewport"]', 'content')).toContain('viewport-fit=cover');
		expect(await violations(page)).toEqual([]);
		await page.close();
	});

	it('the sign-in page names the app, says what it is, and offers no sign-up', async () => {
		const page = await browser.newPage({ viewport: { width: WIDTH, height: 844 } });
		await page.goto(`${origin}/login`, { waitUntil: 'networkidle' });
		expect(await page.title()).toBe(`Sign in · ${appShell.appName}`);
		expect((await page.getByTestId('tagline').innerText()).trim()).toBe(appShell.tagline);
		expect(await page.getByRole('link', { name: /sign up|create account|register/i }).count()).toBe(
			0
		);
		expect(await tabs(page).count(), 'no tabs signed out').toBe(0);
		await page.close();
	});

	// Last: it ends the session the other tests use.
	it('Sign out on the account page ends the session', async () => {
		const sessions = () =>
			harness.db.select().from(s.authSessions).where(eq(s.authSessions.userId, userId));
		expect((await sessions()).length).toBeGreaterThan(0);
		const page = await signedInPage();
		await page.goto(`${origin}/account`, { waitUntil: 'networkidle' });
		await page.getByRole('button', { name: 'Sign out' }).click();
		await page.waitForURL('**/login');
		// The state, not the redirect: every session row for this user is gone,
		// and a client that kept the cookie is sent to sign in.
		expect(await sessions()).toEqual([]);
		const kept = await fetch(`${origin}/history`, { headers: { cookie }, redirect: 'manual' });
		expect(kept.status).toBe(303);
		await page.close();
	});
});
