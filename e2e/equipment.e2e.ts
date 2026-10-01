/**
 * The 0.3.0 equipment pages, driven from the rendered page in a real browser
 * against the PRODUCTION build (CLAUDE.md: "every action has an e2e that
 * reaches it from a page"). The real 543-row catalog is imported first, so the
 * pages are exercised at the size they ship with.
 *
 * Prerequisites and skip rules are the same as csp.e2e.ts.
 */
import { existsSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { and, eq } from 'drizzle-orm';
import { setupTestDb } from '$lib/server/test-db';
import {
	BUILD_ENTRY,
	freshTestDb,
	seedTestUser,
	signInAs,
	startTestServer
} from '$lib/server/test-auth-helpers';
import { importCatalog } from '$lib/server/catalog-import';
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

run('equipment pages (production build)', () => {
	let harness: Awaited<ReturnType<typeof setupTestDb>>;
	let stopServer = async () => {};
	let origin: string;
	let cookie: string;
	let browser: Browser;
	let userId: string;
	let gymId: string;

	beforeAll(async () => {
		harness = await freshTestDb();
		const db = harness.db;
		const user = await seedTestUser(db);
		userId = user.id;
		const csv = readFileSync('data/catalog/equipment_models_seed_2026-09-30.csv', 'utf8');
		expect((await importCatalog(db, csv, { dryRun: false })).failed).toBe(false);
		[{ id: gymId }] = await db
			.insert(s.gyms)
			.values({ name: 'E2E Gym', userId: user.id })
			.returning();
		const started = await startTestServer();
		origin = started.origin;
		stopServer = started.stop;
		cookie = await signInAs(origin);
		browser = await chromium.launch({ executablePath });
	});

	afterAll(async () => {
		await browser?.close();
		await stopServer();
		await harness?.end();
	});

	async function signedInPage(): Promise<Page> {
		const page = await browser.newPage();
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
	// The #svelte-announcer style-src-attr violation is the one tolerated
	// framework artifact (see csp.e2e.ts); everything else fails.
	const violations = async (page: Page) =>
		(await page.evaluate(() => window.__cspViolations)).filter(
			(v) => !v.startsWith('style-src-attr ')
		);

	it('search by code, open the model, and add it to a gym from the page', async () => {
		const page = await signedInPage();
		await page.goto(origin + '/equipment', { waitUntil: 'networkidle' });
		await expect.poll(() => page.getByRole('status').textContent()).toContain('543 models');
		await page.getByLabel('Search name or model code').fill('IL-ROW');
		await page.getByRole('button', { name: 'Apply' }).click();
		await page.waitForURL('**/equipment?**q=IL-ROW**');
		await expect.poll(() => page.getByRole('status').textContent()).toContain('1 model');
		await page.getByRole('link', { name: 'Iso-Lateral Row' }).click();
		await page.waitForURL('**/equipment/*');

		await page.getByLabel('Gym').selectOption(gymId);
		await page.getByLabel('Local label').fill('Row by the window');
		await page.getByLabel('Stack (lb, optional)').fill('200');
		await page.getByRole('button', { name: 'Add to gym' }).click();
		await expect.poll(() => page.getByRole('status').textContent()).toBe('Added to your gym');
		await expect
			.poll(() => page.getByText('E2E Gym · Row by the window · 200 lb stack').count())
			.toBe(1);

		// The state, not the response: the row exists, in this user's gym.
		const rows = await harness.db
			.select()
			.from(s.gymEquipment)
			.where(
				and(eq(s.gymEquipment.gymId, gymId), eq(s.gymEquipment.localLabel, 'Row by the window'))
			);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ stackLb: 200, equipmentType: 'machine-plate' });
		expect(await violations(page)).toEqual([]);
		void userId;
		await page.close();
	});

	it('the /gyms model picker narrows to the gym, expands to all, and searches', async () => {
		const db = harness.db;
		const [gym] = await db.insert(s.gyms).values({ name: 'Picker Gym', userId }).returning();
		const hammer = await db
			.select()
			.from(s.equipmentModels)
			.where(eq(s.equipmentModels.manufacturer, 'Hammer Strength'));
		const bench = hammer.find((m) => m.code === 'IL-HBP')!;
		const row = hammer.find((m) => m.code === 'IL-ROW')!;
		await db.insert(s.gymEquipment).values({
			gymId: gym.id,
			localLabel: 'Bench',
			equipmentType: bench.loadingType,
			equipmentModelId: bench.id
		});

		const page = await signedInPage();
		await page.goto(`${origin}/gyms?gym=${gym.id}`, { waitUntil: 'networkidle' });
		const modelOptions = () => page.getByLabel('Known model (optional)').locator('option').count();
		// "Unknown / enter below" plus every Hammer Strength model, nothing else.
		expect(await modelOptions()).toBe(hammer.length + 1);

		await page.getByRole('link', { name: 'Show all manufacturers' }).click();
		await page.waitForURL('**all=1**');
		expect(await modelOptions()).toBe(543 + 1);

		await page.getByLabel('Search models by name or code').fill('IL-ROW');
		await page.getByRole('button', { name: 'Show models' }).click();
		await page.waitForURL('**q=IL-ROW**');
		expect(await modelOptions()).toBe(2);

		// And the narrowed list feeds the real action.
		await page.getByLabel('Local machine label').fill('Picked row');
		await page.getByLabel('Equipment type').selectOption('machine-plate');
		await page.getByLabel('Known model (optional)').selectOption(row.id);
		await page.getByRole('button', { name: 'Add machine' }).click();
		await expect.poll(() => page.getByRole('status').textContent()).toBe('Machine created');
		const made = await db
			.select()
			.from(s.gymEquipment)
			.where(and(eq(s.gymEquipment.gymId, gym.id), eq(s.gymEquipment.localLabel, 'Picked row')));
		expect(made).toHaveLength(1);
		expect(made[0].equipmentModelId).toBe(row.id);
		expect(await violations(page)).toEqual([]);
		await page.close();
	});
});
