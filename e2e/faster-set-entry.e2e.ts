import { browserSuite, authenticatedPage, violations } from './browser';
/**
 * SPEC 0.5.0 Part F, "Accept when", through the PRODUCTION build at 390 px:
 * a set with the right prefill saves in one tap; weight moves one machine
 * increment per tap with no keyboard; the rest timer shows the right time
 * after a reload; the next set to log comes into view.
 *
 * Prerequisites and skip rules are the same as csp.e2e.ts.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { and, asc, eq } from 'drizzle-orm';
import { setupTestDb } from '$lib/server/test-db';
import {
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

const { run, executablePath } = browserSuite();

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

	const signedInPage = () =>
		authenticatedPage(browser, cookie, { viewport: { width: 390, height: 844 } });
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
		await page.getByRole('button', { name: 'Customize workout view' }).click();
		await page.getByLabel('Weight and reps +/− buttons').check();
		await page.getByRole('button', { name: 'Done customizing' }).click();
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
	it('four layouts preserve distinct drafts, zero RIR and notes when fields are hidden', async () => {
		const page = await signedInPage();
		await page.goto(`${origin}/sessions/${sessionId}`, { waitUntil: 'networkidle' });
		const first = page.locator('li[id^="set-"]').first();
		const rowId = (await first.getAttribute('id'))!.slice(4);
		await page.getByRole('button', { name: 'Customize workout view' }).click();
		await page.getByLabel('RIR field', { exact: true }).selectOption('show');
		await page.getByLabel('Set notes', { exact: true }).check();
		await page.getByRole('button', { name: 'Done customizing' }).click();
		await first.getByRole('spinbutton', { name: 'Weight', exact: true }).fill('67.5');
		await first.getByRole('spinbutton', { name: 'Reps', exact: true }).fill('11');
		await first.getByRole('spinbutton', { name: 'RIR', exact: true }).fill('0');
		await first
			.getByRole('textbox', { name: 'Set note', exact: true })
			.fill('Distinct draft across four layouts');
		for (const layout of ['notebook', 'tap', 'guided', 'table']) {
			await page.getByLabel('Workout layout', { exact: true }).selectOption(layout);
			if (layout === 'guided')
				await page
					.locator('section.exercise')
					.first()
					.getByLabel('Current set', { exact: true })
					.selectOption(rowId);
			if (process.env.LAYOUT_SCREENSHOTS)
				await page.screenshot({
					path: `${process.env.LAYOUT_SCREENSHOTS}/${layout}.png`,
					fullPage: true
				});
			expect(
				await first.getByRole('spinbutton', { name: 'Weight', exact: true }).inputValue()
			).toBe('67.5');
			expect(await first.getByRole('spinbutton', { name: 'Reps', exact: true }).inputValue()).toBe(
				'11'
			);
			expect(await first.getByRole('spinbutton', { name: 'RIR', exact: true }).inputValue()).toBe(
				'0'
			);
		}
		await page.getByRole('button', { name: 'Customize workout view' }).click();
		await page.getByLabel('RIR field', { exact: true }).selectOption('hide');
		await page.getByLabel('Set notes', { exact: true }).uncheck();
		await page.getByRole('button', { name: 'Done customizing' }).click();
		expect(await first.locator('input[name="executedRir"]').isVisible()).toBe(false);
		await first.getByRole('button', { name: ui.saveSet(1), exact: true }).click();
		await expect
			.poll(async () => {
				const [row] = await harness.db.select().from(s.sets).where(eq(s.sets.id, rowId));
				return [row.executedLoad, row.executedReps, row.executedRir, row.notes];
			})
			.toEqual([67.5, 11, 0, 'Distinct draft across four layouts']);
		await page.getByLabel('Workout layout', { exact: true }).selectOption('notebook');
		await page.reload({ waitUntil: 'networkidle' });
		expect(await page.getByLabel('Workout layout', { exact: true }).inputValue()).toBe('notebook');
		expect(await first.locator('input[name="executedRir"]').inputValue()).toBe('0');
		await page.setViewportSize({ width: 320, height: 740 });
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
			true
		);
		expect(await violations(page)).toEqual([]);
		await page.close();
	});
	it('a failed save retains distinct entries and does not start rest', async () => {
		const page = await signedInPage();
		await page.goto(`${origin}/sessions/${sessionId}`, { waitUntil: 'networkidle' });
		const first = page.locator('li[id^="set-"]').first();
		await first.getByRole('spinbutton', { name: 'Weight', exact: true }).fill('82.5');
		await first.getByRole('spinbutton', { name: 'Reps', exact: true }).fill('7');
		await page.route('**/sessions/**', (route) =>
			route.request().method() === 'POST' ? route.abort('failed') : route.continue()
		);
		await first.getByRole('button', { name: ui.saveSet(1), exact: true }).click();
		await first.getByRole('alert').waitFor();
		expect(await first.getByRole('spinbutton', { name: 'Weight', exact: true }).inputValue()).toBe(
			'82.5'
		);
		expect(await first.getByRole('spinbutton', { name: 'Reps', exact: true }).inputValue()).toBe(
			'7'
		);
		expect(await page.getByTestId('rest-timer').count()).toBe(0);
		await page.getByLabel('Workout layout', { exact: true }).selectOption('notebook');
		expect(await first.getByRole('spinbutton', { name: 'Weight', exact: true }).inputValue()).toBe(
			'82.5'
		);
		await page.close();
	});
	it('clock settings are opt-in, survive reload, and countdown expiration leaves editing open', async () => {
		const page = await signedInPage();
		await page.goto(`${origin}/sessions/${sessionId}`, { waitUntil: 'networkidle' });
		await page.getByRole('button', { name: 'Timer settings', exact: true }).click();
		expect(await page.getByLabel('Play a chime', { exact: true }).isChecked()).toBe(false);
		await page.getByLabel('Rest duration', { exact: true }).selectOption('5');
		await page.getByLabel('Visual alert', { exact: true }).selectOption('shake');
		await page.getByRole('button', { name: 'Close timer settings', exact: true }).click();
		await page.getByRole('button', { name: 'Start rest', exact: true }).click();
		await page.getByRole('button', { name: 'Edit workout', exact: true }).click();
		await expect
			.poll(() => page.getByTestId('rest-clock').innerText(), { timeout: 8000 })
			.toBe('0:00');
		expect(await page.getByRole('button', { name: 'Done editing', exact: true }).isVisible()).toBe(
			true
		);
		await page.reload({ waitUntil: 'networkidle' });
		await page.getByRole('button', { name: 'Timer settings', exact: true }).click();
		expect(await page.getByLabel('Rest duration', { exact: true }).inputValue()).toBe('5');
		expect(await page.getByLabel('Visual alert', { exact: true }).inputValue()).toBe('shake');
		expect(await violations(page)).toEqual([]);
		await page.close();
	});
});
