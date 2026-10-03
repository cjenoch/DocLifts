/**
 * Editor spec Part D, "Accept when": a brand-new account picks a starter
 * template, saves it, starts day one and saves a set, on a phone (390 px),
 * through the PRODUCTION build. The template is only a draft until saved.
 *
 * Prerequisites and skip rules are the same as csp.e2e.ts.
 */
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { eq } from 'drizzle-orm';
import { setupTestDb } from '$lib/server/test-db';
import {
	BUILD_ENTRY,
	freshTestDb,
	seedTestUser,
	signInAs,
	startTestServer
} from '$lib/server/test-auth-helpers';
import * as s from '$lib/server/db/schema';

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

run('starting from a starter template (production build)', () => {
	let harness: Awaited<ReturnType<typeof setupTestDb>>;
	let stopServer = async () => {};
	let origin: string;
	let cookie: string;
	let browser: Browser;
	let userId: string;

	beforeAll(async () => {
		harness = await freshTestDb();
		// A new account through the real sign-up path, so it has the starter list.
		userId = (await seedTestUser(harness.db)).id;
		const server = await startTestServer();
		origin = server.origin;
		stopServer = server.stop;
		cookie = await signInAs(origin);
		browser = await chromium.launch({ executablePath });
	});

	afterAll(async () => {
		await browser?.close();
		await stopServer();
		await harness?.end();
	});

	async function signedInPage(): Promise<Page> {
		const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
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
	const programCount = async () =>
		(await harness.db.select().from(s.programs).where(eq(s.programs.userId, userId))).filter(
			(p) => p.systemKind === null
		).length;

	it('picks Barbell Strength, saves it, starts day one and saves a set', async () => {
		const page = await signedInPage();
		await page.goto(`${origin}/programs/new`, { waitUntil: 'networkidle' });
		await page.getByRole('button', { name: 'Use Barbell Strength, 4 days', exact: true }).click();
		expect(await page.getByLabel('Program name', { exact: true }).inputValue()).toBe(
			'Barbell Strength, 4 days'
		);
		// A draft only: nothing is saved by choosing a template.
		expect(await programCount()).toBe(0);
		await page.getByRole('button', { name: 'Review program', exact: true }).click();
		await page.getByRole('button', { name: 'Save program', exact: true }).click();
		await page.waitForURL(/\/programs\/[0-9a-f-]{36}$/);
		expect(await programCount()).toBe(1);

		await page.getByRole('button', { name: 'Start', exact: true }).first().click();
		await page.waitForURL(/\/sessions\/[0-9a-f-]{36}$/);
		await page.waitForLoadState('networkidle');
		expect(await page.getByText('Overhead press').count()).toBeGreaterThan(0);
		await page.getByRole('spinbutton', { name: 'Weight', exact: true }).first().fill('95');
		await page.getByRole('spinbutton', { name: 'Reps', exact: true }).first().fill('5');
		await page.getByRole('button', { name: 'Save set 1' }).first().click();
		await expect.poll(() => page.getByText('✓ Saved').count()).toBe(1);
		const saved = await harness.db.select().from(s.sets);
		expect(saved.filter((set) => set.executedLoad === 95 && set.executedReps === 5)).toHaveLength(
			1
		);
		expect(
			await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
		).toBe(true);
		expect(await violations(page)).toEqual([]);
		await page.close();
	});
});
