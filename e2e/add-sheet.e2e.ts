/**
 * 0.8.0 (machines spec Parts I and J): the add sheet and the Exercises page,
 * through the PRODUCTION build at 390 px. Every action is reached from the
 * rendered page; each test checks the database, not only the screen.
 * Strings come from `pickerUi`.
 *
 * Prerequisites and skip rules are the same as csp.e2e.ts.
 */
import { existsSync } from 'node:fs';
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
import * as s from '$lib/server/db/schema';
import { addSessionExercise, createGym, createMachine } from '$lib/server/machines';
import { startQuickSession } from '$lib/server/quick-workouts';
import { endSession } from '$lib/server/sessions';
import { pickerUi as ui } from '$lib/picker-ui';

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

run('the add sheet and the Exercises page (production build)', () => {
	let harness: Awaited<ReturnType<typeof setupTestDb>>;
	let stopServer = async () => {};
	let origin: string;
	let cookie: string;
	let browser: Browser;
	let userId: string;
	let gymId: string;
	let machineId: string;

	beforeAll(async () => {
		harness = await freshTestDb();
		userId = (await seedTestUser(harness.db)).id;
		gymId = (await createGym(harness.db, userId, { name: 'Sheet gym' })).id;
		// Last visit: "Leg curl" on the gym's curl machine, 100 x 10, weight shown on the stack.
		machineId = (
			await createMachine(harness.db, userId, {
				gymId,
				localLabel: 'Curl by the door',
				equipmentType: 'machine-stack'
			})
		).id;
		const started = await startQuickSession(harness.db, userId, gymId);
		if (!started.ok) throw new Error(started.message);
		const [curl] = await harness.db
			.select()
			.from(s.exercises)
			.where(and(eq(s.exercises.userId, userId), eq(s.exercises.name, 'Leg curl')));
		const block = await addSessionExercise(harness.db, userId, started.sessionId, {
			exerciseId: curl.id,
			equipmentType: 'machine-stack',
			gymId,
			gymEquipmentId: machineId,
			loadConvention: 'displayed',
			setCount: 1,
			repsMin: 8,
			repsMax: 12,
			rir: 2,
			tier: 'secondary',
			progressionPolicy: 'standard'
		});
		await harness.db
			.update(s.sets)
			.set({ executedLoad: 100, executedReps: 10 })
			.where(eq(s.sets.sessionExerciseId, block.id));
		await endSession(harness.db, userId, started.sessionId);

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

	/** A new quick workout at the gym, its page open, the sheet open. */
	async function openSheet(page: Page) {
		await page.goto(origin + '/workout/start', { waitUntil: 'networkidle' });
		const existing = await harness.db
			.select({ id: s.sessions.id })
			.from(s.sessions)
			.where(and(eq(s.sessions.userId, userId)));
		for (const row of existing)
			await harness.db
				.update(s.sessions)
				.set({ endedAt: new Date() })
				.where(and(eq(s.sessions.id, row.id), eq(s.sessions.userId, userId)));
		await page.goto(origin + '/workout/start', { waitUntil: 'networkidle' });
		await page.getByRole('radio', { name: 'Sheet gym' }).check();
		await page.getByRole('button', { name: 'Start', exact: true }).click();
		await page.waitForURL('**/sessions/*');
		const sessionId = page.url().split('/').pop()!;
		await page.getByRole('button', { name: `+ ${ui.addExercise}` }).click();
		const sheet = page.getByRole('dialog', { name: ui.addExercise });
		await sheet.waitFor();
		return { sheet, sessionId };
	}
	const blocksOf = (sessionId: string) =>
		harness.db.select().from(s.sessionExercises).where(eq(s.sessionExercises.sessionId, sessionId));

	it('a known machine and its usual exercise: two taps, last time shown, the format remembered', async () => {
		const page = await signedInPage();
		const { sheet, sessionId } = await openSheet(page);
		// Machines first: this gym has machines.
		expect(
			await sheet.getByRole('tab', { name: ui.machinesTab }).getAttribute('aria-selected')
		).toBe('true');
		const row = sheet.getByTestId('machine-row').filter({ hasText: 'Curl by the door' }).first();
		expect(await row.innerText()).toContain('Leg curl');
		await row.click();
		await sheet.getByRole('button', { name: /^Leg curl/ }).click();
		await expect.poll(() => page.getByRole('heading', { name: 'Leg curl' }).count()).toBe(1);
		expect(
			await page.getByRole('spinbutton', { name: 'Weight', exact: true }).first().inputValue()
		).toBe('100');
		const [block] = await blocksOf(sessionId);
		expect(block).toMatchObject({ gymEquipmentId: machineId, loadConvention: 'displayed' });
		// At 390 px the page never scrolls sideways.
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
			390
		);
		expect(await violations(page)).toEqual([]);
		await page.close();
	});

	it('a free weight is added at once, with no gym equipment', async () => {
		const page = await signedInPage();
		const { sheet, sessionId } = await openSheet(page);
		await sheet.getByRole('tab', { name: ui.exercisesTab }).click();
		await sheet.getByRole('searchbox', { name: ui.searchExercises }).fill('Dumbbell curl');
		await sheet.getByTestId('exercise-row').filter({ hasText: 'Dumbbell curl' }).first().click();
		await expect.poll(() => page.getByRole('heading', { name: 'Dumbbell curl' }).count()).toBe(1);
		const [block] = await blocksOf(sessionId);
		expect(block).toMatchObject({ gymEquipmentId: null, equipmentType: 'dumbbell' });
		await page.close();
	});

	it('the sheet reopens on the tab used last in this workout', async () => {
		const page = await signedInPage();
		const { sheet } = await openSheet(page);
		await sheet.getByRole('tab', { name: ui.exercisesTab }).click();
		await sheet.getByRole('button', { name: ui.close }).click();
		await page.getByRole('button', { name: `+ ${ui.addExercise}` }).click();
		expect(
			await page
				.getByRole('dialog', { name: ui.addExercise })
				.getByRole('tab', { name: ui.exercisesTab })
				.getAttribute('aria-selected')
		).toBe('true');
		await page.close();
	});

	it('create from typed text: chips for equipment and region, then a new machine by name', async () => {
		const page = await signedInPage();
		const { sheet, sessionId } = await openSheet(page);
		await sheet.getByRole('tab', { name: ui.exercisesTab }).click();
		await sheet.getByRole('searchbox', { name: ui.searchExercises }).fill('Cable woodchop');
		await sheet.getByRole('button', { name: ui.create('Cable woodchop') }).click();
		await sheet.getByRole('button', { name: 'Cable', exact: true }).click();
		await sheet.getByRole('button', { name: 'core', exact: true }).click();
		await sheet.getByRole('button', { name: ui.add, exact: true }).click();
		// A cable exercise: name the machine it is on.
		await sheet.getByRole('button', { name: ui.addByName }).click();
		await sheet.getByLabel(ui.machineName).fill('Cable tower');
		await sheet.getByRole('button', { name: ui.add, exact: true }).click();
		await sheet.getByRole('button', { name: ui.add, exact: true }).click();
		await expect.poll(() => page.getByRole('heading', { name: 'Cable woodchop' }).count()).toBe(1);
		const [created] = await harness.db
			.select()
			.from(s.exercises)
			.where(and(eq(s.exercises.userId, userId), eq(s.exercises.name, 'Cable woodchop')));
		expect(created).toMatchObject({ equipmentType: 'cable', bodyRegion: 'core' });
		const [block] = await blocksOf(sessionId);
		expect(block.machineLabel).toBe('Cable tower');
		await page.close();
	});

	it('the Exercises page: rename, region and hide; a hidden exercise leaves the sheet and comes back', async () => {
		const page = await signedInPage();
		await page.goto(origin + '/account', { waitUntil: 'networkidle' });
		await page.getByRole('link', { name: 'Exercises' }).click();
		await page.waitForURL('**/exercises');
		const row = page.getByTestId('exercise-row').filter({ hasText: 'Pallof press' });
		await row.locator('summary').click();
		await row.getByRole('textbox', { name: ui.rename }).fill('Pallof hold');
		await row.getByRole('button', { name: ui.save }).click();
		await expect
			.poll(
				async () =>
					(
						await harness.db
							.select()
							.from(s.exercises)
							.where(and(eq(s.exercises.userId, userId), eq(s.exercises.name, 'Pallof hold')))
					).length
			)
			.toBe(1);
		const renamed = page.getByTestId('exercise-row').filter({ hasText: 'Pallof hold' });
		if ((await renamed.getAttribute('open')) === null) await renamed.locator('summary').click();
		await renamed.getByRole('button', { name: ui.hide }).click();
		await page.getByTestId('hidden-exercises').waitFor();

		const { sheet } = await openSheet(page);
		await sheet.getByRole('tab', { name: ui.exercisesTab }).click();
		await sheet.getByRole('searchbox', { name: ui.searchExercises }).fill('Pallof');
		expect(await sheet.getByTestId('exercise-row').count()).toBe(0);

		await page.goto(origin + '/exercises', { waitUntil: 'networkidle' });
		const hidden = page.getByTestId('hidden-exercises');
		await hidden.locator('summary').click();
		await hidden.getByRole('button', { name: ui.restore }).click();
		await expect
			.poll(
				async () =>
					(
						await harness.db
							.select()
							.from(s.exercises)
							.where(and(eq(s.exercises.userId, userId), eq(s.exercises.name, 'Pallof hold')))
					).map((r) => r.archivedAt)[0]
			)
			.toBeNull();
		expect(await violations(page)).toEqual([]);
		await page.close();
	});
});
