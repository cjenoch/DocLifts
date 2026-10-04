/**
 * SPEC 0.5.0 Part F, "Accept when", through the PRODUCTION build at 390 px:
 * a set with the right prefill saves in one tap; weight moves one machine
 * increment per tap with no keyboard; the rest timer shows the right time
 * after a reload; the next set to log comes into view.
 *
 * Prerequisites and skip rules are the same as csp.e2e.ts.
 */
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { and, asc, eq } from 'drizzle-orm';
import { setupTestDb } from '$lib/server/test-db';
import {
	BUILD_ENTRY,
	freshTestDb,
	seedTestUser,
	signInAs,
	startTestServer
} from '$lib/server/test-auth-helpers';
import * as s from '$lib/server/db/schema';
import { blankSetDraft } from '$lib/program-draft';
import { saveProgramDraft } from '$lib/server/program-builder';
import { startSessionForDay } from '$lib/server/sessions';
import { bindSessionMachine, createGym, createMachine } from '$lib/server/machines';
import { workoutUi as ui } from '$lib/workout-ui';

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

run('faster set entry (production build)', () => {
	let harness: Awaited<ReturnType<typeof setupTestDb>>;
	let stopServer = async () => {};
	let origin: string;
	let cookie: string;
	let browser: Browser;
	let userId: string;
	let sessionId: string;

	beforeAll(async () => {
		harness = await freshTestDb();
		const db = harness.db;
		userId = (await seedTestUser(db)).id;
		const library = await db.select().from(s.exercises).where(eq(s.exercises.userId, userId));
		const id = (name: string) => library.find((e) => e.name === name)!.id;
		const row = (name: string, initialLoad: number | null) => ({
			exerciseId: id(name),
			newExercise: null,
			tier: 'secondary' as const,
			progressionPolicy: 'standard' as const,
			notes: null,
			sets: [1, 2].map(() => ({ ...blankSetDraft(), initialLoad }))
		});
		const program = await saveProgramDraft(db, userId, {
			requestId: randomUUID(),
			sourceProgramId: null,
			draft: {
				name: 'Fast sets',
				description: null,
				days: [
					{
						name: 'Day',
						notes: null,
						alternateGroupId: null,
						exercises: [row('Dumbbell press', 50), row('Lat pulldown', null)]
					}
				]
			}
		});
		const [day] = await db.select().from(s.days).where(eq(s.days.programId, program.id));
		const started = await startSessionForDay(db, userId, day.id);
		if (!started.ok) throw new Error(started.message);
		sessionId = started.sessionId;
		const gym = await createGym(db, userId, { name: 'Fast gym' });
		const machine = await createMachine(db, userId, {
			gymId: gym.id,
			localLabel: 'Pulldown 1',
			equipmentType: 'machine-stack',
			incrementLb: '10'
		});
		const [pulldown] = await db
			.select()
			.from(s.sessionExercises)
			.where(
				and(
					eq(s.sessionExercises.sessionId, sessionId),
					eq(s.sessionExercises.exerciseName, 'Lat pulldown')
				)
			);
		await bindSessionMachine(db, userId, sessionId, pulldown.id, {
			confirm: 'CHANGE',
			gymId: gym.id,
			gymEquipmentId: machine.id,
			loadConvention: 'displayed'
		});
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
	const logged = async () =>
		(
			await harness.db
				.select()
				.from(s.sets)
				.where(eq(s.sets.sessionId, sessionId))
				.orderBy(asc(s.sets.loggedAt))
		)
			.filter((x) => x.executedLoad != null)
			.map((x) => [x.executedLoad, x.executedReps]);
	const seconds = async (page: Page) => {
		const [m, sec] = (await page.getByTestId('rest-clock').innerText()).replace('+', '').split(':');
		return Number(m) * 60 + Number(sec);
	};

	it('one tap, machine steps, the next set in view, and a timer that survives a reload', async () => {
		const page = await signedInPage();
		await page.goto(`${origin}/sessions/${sessionId}`, { waitUntil: 'networkidle' });
		expect(await page.getByTestId('rest-timer').count()).toBe(0);

		// One tap: 50 x 8 is shown, and the check saves it.
		const weight = page.getByRole('spinbutton', { name: 'Weight', exact: true });
		expect(await weight.first().inputValue()).toBe('50');
		expect(
			await page.getByRole('spinbutton', { name: 'Reps', exact: true }).first().inputValue()
		).toBe('8');
		await page
			.getByRole('button', { name: ui.saveSet(1) })
			.first()
			.click();
		await expect.poll(logged).toEqual([[50, 8]]);
		// The next set to log comes into view.
		await expect
			.poll(() =>
				page.evaluate(() => {
					const r = document.querySelectorAll('li[id^="set-"]')[1].getBoundingClientRect();
					return r.top >= 0 && r.bottom <= window.innerHeight;
				})
			)
			.toBe(true);
		expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('INPUT');

		// The rest timer started, and keeps its time through a reload.
		expect(await seconds(page)).toBeGreaterThan(ui.defaultRestSeconds - 5);
		await page.evaluate((id) => {
			const key = `doclifts:rest:${id}`;
			const rest = JSON.parse(localStorage.getItem(key)!);
			localStorage.setItem(key, JSON.stringify({ ...rest, startedAt: rest.startedAt - 60_000 }));
		}, sessionId);
		await page.reload({ waitUntil: 'networkidle' });
		const left = await seconds(page);
		expect(left).toBeLessThanOrEqual(ui.defaultRestSeconds - 60);
		expect(left).toBeGreaterThan(ui.defaultRestSeconds - 66);
		await page.getByRole('button', { name: ui.restAdd, exact: true }).click();
		expect(await seconds(page)).toBeGreaterThan(left + ui.restAddSeconds - 3);
		await page.getByRole('button', { name: ui.restDismiss, exact: true }).click();
		expect(await page.getByTestId('rest-timer').count()).toBe(0);
		await page.reload({ waitUntil: 'networkidle' });
		expect(await page.getByTestId('rest-timer').count()).toBe(0);

		// The pulldown's machine steps by 10 lb a tap, with no keyboard.
		const pulldown = page.locator('section.exercise').filter({ hasText: 'Lat pulldown' });
		await pulldown.getByRole('button', { name: ui.moreWeight, exact: true }).first().click();
		await pulldown.getByRole('button', { name: ui.moreWeight, exact: true }).first().click();
		expect(
			await pulldown.getByRole('spinbutton', { name: 'Weight', exact: true }).first().inputValue()
		).toBe('20');
		await pulldown
			.getByRole('button', { name: ui.moreReps(false), exact: true })
			.first()
			.click();
		expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('INPUT');
		await pulldown.getByRole('button', { name: ui.saveSet(1) }).click();
		await expect.poll(logged).toEqual([
			[50, 8],
			[20, 9]
		]);
		// The DB commit can precede the enhanced form response and timer render.
		await page.getByTestId('rest-timer').waitFor({ state: 'visible' });
		expect(await page.getByTestId('rest-timer').count()).toBe(1);
		expect(
			await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
		).toBe(true);
		expect(await violations(page)).toEqual([]);
		await page.close();
	});
	it('switches views without losing drafts, saved RIR or notes, and remembers the choice after reload', async () => {
		const page = await signedInPage();
		await page.goto(`${origin}/sessions/${sessionId}`, { waitUntil: 'networkidle' });
		const first = page.locator('li[id^="set-"]').first();
		const rowId = (await first.getAttribute('id'))!.slice(4);
		expect(
			await page
				.getByRole('button', { name: 'Simple view', exact: true })
				.getAttribute('aria-pressed')
		).toBe('true');
		expect(await first.locator('input[name="executedRir"]').isVisible()).toBe(false);
		await page.getByRole('button', { name: 'Advanced view', exact: true }).click();
		await first.getByRole('spinbutton', { name: 'Weight', exact: true }).fill('67.5');
		await first.getByRole('spinbutton', { name: 'Reps', exact: true }).fill('11');
		await first.locator('input[name="executedRir"]').fill('0');
		await first.getByRole('button', { name: '+ Note', exact: true }).click();
		await first
			.getByRole('textbox', { name: 'Set note', exact: true })
			.fill('A draft across both views');
		await page.getByRole('button', { name: 'Simple view', exact: true }).click();
		expect(await first.getByRole('spinbutton', { name: 'Weight', exact: true }).inputValue()).toBe(
			'67.5'
		);
		expect(await first.locator('input[name="executedRir"]').isVisible()).toBe(false);
		await first.getByRole('button', { name: ui.saveSet(1), exact: true }).click();
		await expect
			.poll(async () => {
				const [row] = await harness.db.select().from(s.sets).where(eq(s.sets.id, rowId));
				return [row.executedLoad, row.executedReps, row.executedRir, row.notes];
			})
			.toEqual([67.5, 11, 0, 'A draft across both views']);
		await first.getByRole('button', { name: 'Notes & effort · entered', exact: true }).click();
		expect(await first.locator('input[name="executedRir"]').inputValue()).toBe('0');
		expect(await first.getByRole('textbox', { name: 'Set note', exact: true }).inputValue()).toBe(
			'A draft across both views'
		);
		await page.getByRole('button', { name: 'Advanced view', exact: true }).click();
		await page.reload({ waitUntil: 'networkidle' });
		expect(
			await page
				.getByRole('button', { name: 'Advanced view', exact: true })
				.getAttribute('aria-pressed')
		).toBe('true');
		expect(await first.locator('input[name="executedRir"]').isVisible()).toBe(true);
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
			390
		);
		expect(await violations(page)).toEqual([]);
		if (process.env.DOCLIFTS_UI_SCREENSHOTS) {
			await page.evaluate(() => window.scrollTo(0, 0));
			await page.screenshot({ path: '/tmp/doclifts-view-advanced.png' });
			await page.getByRole('button', { name: 'Simple view', exact: true }).click();
			await page.screenshot({ path: '/tmp/doclifts-view-simple.png' });
		}
		await page.close();
	});
});
