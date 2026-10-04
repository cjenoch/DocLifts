import { browserSuite, authenticatedPage, violations } from './browser';
/**
 * Editor spec Part D, "Accept when": a brand-new account picks a starter
 * template, saves it, starts day one and saves a set, on a phone (390 px),
 * through the PRODUCTION build. The template is only a draft until saved.
 *
 * Prerequisites and skip rules are the same as csp.e2e.ts.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { eq } from 'drizzle-orm';
import { setupTestDb } from '$lib/server/test-db';
import {
	freshTestDb,
	seedTestUser,
	signInAs,
	startTestServer
} from '$lib/server/test-auth-helpers';
import * as s from '$lib/server/db/schema';

const { run, executablePath } = browserSuite();

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

	const signedInPage = () =>
		authenticatedPage(browser, cookie, { viewport: { width: 390, height: 844 } });
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
