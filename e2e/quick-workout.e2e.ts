import { browserSuite, authenticatedPage, violations } from './browser';
/**
 * 0.5.1 (spec 0.5.0 Part B): a brand-new account goes from the rendered Home
 * to a saved first set without building a program, and a second quick workout
 * shows last time's numbers for the same exercise and machine. Driven through
 * the PRODUCTION build in a real browser (CLAUDE.md: every action has an e2e
 * that reaches it from a page). Strings come from `workoutUi`, never literals.
 *
 * Prerequisites and skip rules are the same as csp.e2e.ts.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { and, eq, isNotNull } from 'drizzle-orm';
import { setupTestDb } from '$lib/server/test-db';
import {
	freshTestDb,
	seedTestUser,
	signInAs,
	startTestServer
} from '$lib/server/test-auth-helpers';
import * as s from '$lib/server/db/schema';
import { workoutUi } from '$lib/workout-ui';
import { conventionLabel, pickerUi } from '$lib/picker-ui';

const { run, executablePath } = browserSuite();

run('quick workout from Home (production build)', () => {
	let harness: Awaited<ReturnType<typeof setupTestDb>>;
	let stopServer = async () => {};
	let origin: string;
	let cookie: string;
	let browser: Browser;
	let userId: string;

	beforeAll(async () => {
		harness = await freshTestDb();
		// A brand-new account: the operator path, starter exercises only, no
		// gym, no program, no workout.
		userId = (await seedTestUser(harness.db)).id;
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

	const signedInPage = () =>
		authenticatedPage(browser, cookie, { viewport: { width: 390, height: 844 } });

	const EXERCISE = 'Lat pulldown';
	const MACHINE = 'Pulldown by the mirrors';
	const GYM = 'Corner gym';

	async function addExercise(page: Page, machine: 'new' | 'existing') {
		// The add sheet (0.8.0) opens on the workout's gym.
		await page.getByRole('button', { name: `+ ${pickerUi.addExercise}` }).click();
		const sheet = page.getByRole('dialog', { name: pickerUi.addExercise });
		await sheet.waitFor();
		expect(await sheet.getByTestId('sheet-gym').innerText()).toBe(GYM);
		if (machine === 'new') {
			// No machines here yet: the sheet opens on Exercises.
			await sheet.getByRole('searchbox', { name: pickerUi.searchExercises }).fill(EXERCISE);
			await sheet.getByTestId('exercise-row').filter({ hasText: EXERCISE }).first().click();
			// A machine exercise: name the machine it is on.
			await sheet.getByRole('button', { name: pickerUi.addByName }).click();
			await sheet.getByLabel(pickerUi.machineName).fill(MACHINE);
			await sheet.getByRole('button', { name: pickerUi.add, exact: true }).click();
			// First time on this machine: the weight format, preselected.
			expect(
				await sheet
					.getByRole('button', { name: conventionLabel('displayed') })
					.getAttribute('aria-pressed')
			).toBe('true');
			await sheet.getByRole('button', { name: pickerUi.add, exact: true }).click();
		} else {
			// Two taps: the machine, then its usual exercise; the format is remembered.
			await sheet.getByTestId('machine-row').filter({ hasText: MACHINE }).first().click();
			await sheet.getByRole('button', { name: new RegExp(`^${EXERCISE}`) }).click();
		}
		await expect.poll(() => page.getByRole('heading', { name: EXERCISE }).count()).toBe(1);
		expect(await sheet.count()).toBe(0);
	}

	it('start, create a gym, add an exercise, save a first set; the next workout prefills it', async () => {
		const page = await signedInPage();
		await page.goto(origin + '/', { waitUntil: 'networkidle' });
		await page.getByRole('link', { name: workoutUi.startWorkout, exact: true }).click();
		await page.waitForURL('**/workout/start');

		// First run: no gyms, so the step is a gym name.
		await page.getByLabel(workoutUi.gymStepNewName).fill(GYM);
		await page.getByRole('button', { name: workoutUi.gymStepSubmit, exact: true }).click();
		await page.waitForURL('**/sessions/*');
		expect(await page.getByRole('heading', { level: 1 }).textContent()).toBe(
			workoutUi.sessionHeading
		);
		const firstUrl = page.url();

		await addExercise(page, 'new');
		await page.getByRole('spinbutton', { name: 'Weight', exact: true }).first().fill('100');
		await page.getByRole('spinbutton', { name: 'Reps', exact: true }).first().fill('10');
		await page.getByRole('button', { name: 'Save set 1' }).click();
		await expect.poll(() => page.getByText('✓ Saved').count()).toBe(1);

		// State, not response: the set row holds what was typed, in the
		// workout's gym, on the machine just created.
		const saved = await harness.db
			.select({ load: s.sets.executedLoad, reps: s.sets.executedReps, gymId: s.gyms.id })
			.from(s.sets)
			.innerJoin(s.gymEquipment, eq(s.gymEquipment.id, s.sets.gymEquipmentId))
			.innerJoin(s.gyms, eq(s.gyms.id, s.gymEquipment.gymId))
			.where(and(eq(s.sets.userId, userId), isNotNull(s.sets.executedLoad)));
		const [session] = await harness.db
			.select()
			.from(s.sessions)
			.where(eq(s.sessions.userId, userId));
		expect(saved).toEqual([{ load: 100, reps: 10, gymId: session.gymId }]);

		// Home now resumes this workout instead of starting another.
		await page.goto(origin + '/', { waitUntil: 'networkidle' });
		await page.getByRole('link', { name: workoutUi.resumeWorkout, exact: true }).click();
		await page.waitForURL(firstUrl);
		// Two of the three sets are empty, so Finish asks first.
		page.once('dialog', (d) => d.accept());
		await page.getByRole('button', { name: 'Finish workout' }).click();
		// A quick workout finishes on its own page, where it can become a
		// program (editor spec, Part M); Home is one tap away.
		await page.waitForURL(firstUrl);
		expect(await page.getByTestId('save-as-program').isVisible()).toBe(true);
		await page.goto(origin + '/', { waitUntil: 'networkidle' });

		// Second workout: the gym used last is preselected; one tap starts it.
		await page.getByRole('link', { name: workoutUi.startWorkout, exact: true }).click();
		await page.waitForURL('**/workout/start');
		expect(await page.getByRole('radio', { name: GYM }).isChecked()).toBe(true);
		await page.getByRole('button', { name: workoutUi.gymStepSubmit, exact: true }).click();
		await page.waitForURL('**/sessions/*');
		expect(page.url()).not.toBe(firstUrl);

		await addExercise(page, 'existing');
		expect(
			await page.getByRole('spinbutton', { name: 'Weight', exact: true }).first().inputValue()
		).toBe('100');
		expect(await page.getByText('Last: 100 × 10').count()).toBe(1);

		// History labels both as quick workouts.
		await page.goto(origin + '/history', { waitUntil: 'networkidle' });
		expect(await page.getByText(workoutUi.quickWorkoutLabel, { exact: true }).count()).toBe(2);
		expect(await violations(page)).toEqual([]);
		await page.close();
	});
});
