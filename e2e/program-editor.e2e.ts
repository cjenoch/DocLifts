/**
 * Editor spec Part N, "Accept when": a three-day program is built on a phone
 * (390 px) with no sideways scrolling on any screen, a standard exercise in
 * at most four fields, and saved, through the PRODUCTION build.
 *
 * Prerequisites and skip rules are the same as csp.e2e.ts.
 */
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { asc, eq } from 'drizzle-orm';
import { setupTestDb } from '$lib/server/test-db';
import {
	BUILD_ENTRY,
	freshTestDb,
	seedTestUser,
	signInAs,
	startTestServer
} from '$lib/server/test-auth-helpers';
import * as s from '$lib/server/db/schema';
import { editorUi as ui } from '$lib/editor-ui';

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

run('the phone program editor (production build)', () => {
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
	const overflow = (page: Page) =>
		page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

	it('builds and saves a three-day program at 390 px with no sideways scroll', async () => {
		const page = await signedInPage();
		await page.goto(`${origin}/programs/new`, { waitUntil: 'networkidle' });
		const widths: number[] = [await overflow(page)];
		await page.getByLabel(ui.programName, { exact: true }).fill('Phone three-day');
		const plan = [
			['Push', 'Barbell bench press'],
			['Pull', 'Lat pulldown'],
			['Legs', 'Leg press']
		] as const;
		for (const [i, [day, exercise]] of plan.entries()) {
			if (i === 0)
				await page.getByRole('button', { name: new RegExp(`^${ui.openDay('Day 1')}`) }).click();
			else await page.getByRole('button', { name: ui.addDay, exact: true }).click();
			await page.getByLabel(ui.dayName(i + 1), { exact: true }).fill(day);
			await page.getByRole('button', { name: ui.addExercise, exact: true }).click();
			const sheet = page.getByRole('dialog');
			await sheet.getByRole('searchbox').fill(exercise);
			widths.push(await overflow(page));
			await sheet.getByTestId('chooser-row').filter({ hasText: exercise }).first().click();
			// One field touched: the default pattern plus one more set.
			await page.getByRole('button', { name: ui.more('sets'), exact: true }).click();
			widths.push(await overflow(page));
			await page
				.getByRole('button', { name: ui.backToDay(day), exact: true })
				.first()
				.click();
			widths.push(await overflow(page));
			expect(await page.getByTestId('exercise-row').innerText()).toContain(
				`${exercise} · 4 × 8–12 · RIR 2`
			);
			await page.getByRole('button', { name: ui.backToProgram, exact: true }).click();
		}
		widths.push(await overflow(page));
		await page.getByRole('button', { name: ui.review, exact: true }).click();
		widths.push(await overflow(page));
		await page.getByRole('button', { name: ui.save, exact: true }).click();
		await page.waitForURL(/\/programs\/[0-9a-f-]{36}$/);
		expect(widths.every((w) => w <= 0)).toBe(true);

		const [program] = await harness.db
			.select()
			.from(s.programs)
			.where(eq(s.programs.name, 'Phone three-day'));
		const days = await harness.db
			.select()
			.from(s.days)
			.where(eq(s.days.programId, program.id))
			.orderBy(asc(s.days.position));
		expect(days.map((d) => d.name)).toEqual(['Push', 'Pull', 'Legs']);
		for (const day of days) {
			const [dx] = await harness.db
				.select()
				.from(s.dayExercises)
				.where(eq(s.dayExercises.dayId, day.id));
			const sets = await harness.db
				.select()
				.from(s.prescribedSets)
				.where(eq(s.prescribedSets.dayExerciseId, dx.id));
			expect(sets).toHaveLength(4);
		}
		// Saving cleared the stored draft: a new program starts clean.
		await page.goto(`${origin}/programs/new`, { waitUntil: 'networkidle' });
		expect(await page.getByLabel(ui.programName, { exact: true }).inputValue()).toBe('');
		expect(await violations(page)).toEqual([]);
		await page.close();
	});
});
