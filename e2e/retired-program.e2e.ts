import { browserSuite, authenticatedPage } from './browser';
/**
 * A retired program version is read-only, with a link to the current one
 * (owner decision, 2026-11-08), through the PRODUCTION build.
 *
 * How this is used on a phone (390 px): the owner opens an old version from
 * History's "(archived)" link or a bookmark. It says it was replaced, offers
 * one tap to the current version, and has no Start or Edit. Its editor URL
 * lands back on that page instead of opening and failing on save.
 *
 * Prerequisites and skip rules are the same as csp.e2e.ts.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { setupTestDb } from '$lib/server/test-db';
import {
	freshTestDb,
	seedTestUser,
	signInAs,
	startTestServer
} from '$lib/server/test-auth-helpers';
import * as s from '$lib/server/db/schema';
import { duplicateProgramForEditInTransaction } from '$lib/server/programs';
import { programUi } from '$lib/program-ui';

const { run, executablePath } = browserSuite();

run('a retired program version (production build)', () => {
	let harness: Awaited<ReturnType<typeof setupTestDb>>;
	let stopServer = async () => {};
	let origin: string;
	let cookie: string;
	let browser: Browser;
	let userId: string;

	beforeAll(async () => {
		harness = await freshTestDb();
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

	it('shows the replaced line and a link to the current version, and no Start or Edit', async () => {
		const [program] = await harness.db
			.insert(s.programs)
			.values({ name: 'Retired e2e', userId })
			.returning();
		await harness.db.insert(s.days).values({ programId: program.id, name: 'Push', position: 1 });
		const current = await harness.db.transaction((tx) =>
			duplicateProgramForEditInTransaction(tx, userId, program.id)
		);

		const page = await authenticatedPage(browser, cookie, {
			viewport: { width: 390, height: 844 }
		});
		// Positive first: the current version offers Start and Edit.
		await page.goto(`${origin}/programs/${current.id}`, { waitUntil: 'networkidle' });
		await expect(page.getByRole('button', { name: 'Start', exact: true }).count()).resolves.toBe(1);
		await expect(page.getByTestId('retired-version').count()).resolves.toBe(0);

		await page.goto(`${origin}/programs/${program.id}`, { waitUntil: 'networkidle' });
		const banner = page.getByTestId('retired-version');
		expect(await banner.innerText()).toContain(programUi.replaced);
		const link = page.getByRole('link', { name: programUi.openCurrent('Retired e2e') });
		expect(await link.getAttribute('href')).toBe(`/programs/${current.id}`);
		expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
		await expect(page.getByRole('button', { name: 'Start', exact: true }).count()).resolves.toBe(0);
		await expect(page.locator(`a[href="/programs/${program.id}/edit"]`).count()).resolves.toBe(0);
		expect(
			await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
		).toBeLessThanOrEqual(0);

		// The editor URL lands back on the read-only page.
		await page.goto(`${origin}/programs/${program.id}/edit`, { waitUntil: 'networkidle' });
		expect(new URL(page.url()).pathname).toBe(`/programs/${program.id}`);
		expect(await page.getByTestId('retired-version').innerText()).toContain(programUi.replaced);

		await link.click();
		await page.waitForURL(`${origin}/programs/${current.id}`);
		await page.close();
	});
});
