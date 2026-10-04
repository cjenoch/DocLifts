import { browserSuite, authenticatedPage, violations } from './browser';
/**
 * 0.5.2: Trash on History. A quick workout has no program page, so History is
 * the only place its Trash can be reached. Driven from the rendered pages of
 * the PRODUCTION build in a real browser (CLAUDE.md: every action has an e2e
 * that reaches it from a page), asserting the database after each step:
 * trash a quick workout, see it in Trash on History, restore it (it is back
 * in the month's list), trash it again, delete it permanently (its rows are
 * gone). Strings come from `workoutUi`, never literals.
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
import { startQuickSession } from '$lib/server/quick-workouts';
import { addSessionExercise, createGym } from '$lib/server/machines';
import { endSession } from '$lib/server/sessions';
import { workoutUi } from '$lib/workout-ui';

const { run, executablePath } = browserSuite();

run('Trash on History (production build)', () => {
	let harness: Awaited<ReturnType<typeof setupTestDb>>;
	let stopServer = async () => {};
	let origin: string;
	let cookie: string;
	let browser: Browser;
	let userId: string;
	let sessionId: string;

	beforeAll(async () => {
		harness = await freshTestDb();
		userId = (await seedTestUser(harness.db)).id;
		// One ended quick workout with one logged set, built through the same
		// server functions the pages call.
		const gym = await createGym(harness.db, userId, { name: 'Corner gym' });
		const started = await startQuickSession(harness.db, userId, gym.id);
		if (!started.ok) throw new Error(started.message);
		sessionId = started.sessionId;
		const [exercise] = await harness.db
			.insert(s.exercises)
			.values({ name: 'Trash test press', equipmentType: 'machine-stack', userId })
			.returning();
		await addSessionExercise(harness.db, userId, sessionId, {
			exerciseId: exercise.id,
			equipmentType: 'machine-stack',
			loadConvention: 'displayed',
			newMachineName: 'Press by the door',
			setCount: '1',
			repsMin: '8',
			repsMax: '12',
			rir: '1',
			tier: 'secondary',
			progressionPolicy: 'standard'
		});
		await harness.db
			.update(s.sets)
			.set({ executedLoad: 80, executedReps: 10 })
			.where(eq(s.sets.sessionId, sessionId));
		await endSession(harness.db, userId, sessionId);

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
	const styledElements = (page: Page) =>
		page.evaluate(() =>
			[...document.querySelectorAll('[style]')]
				.filter((el) => el.id !== 'svelte-announcer')
				.map((el) => el.outerHTML.slice(0, 120))
		);

	const sessionRow = async () =>
		(await harness.db.select().from(s.sessions).where(eq(s.sessions.id, sessionId)))[0];
	const setCount = async () =>
		(await harness.db.select().from(s.sets).where(eq(s.sets.sessionId, sessionId))).length;
	const occurrenceCount = async () =>
		(
			await harness.db
				.select()
				.from(s.sessionExercises)
				.where(eq(s.sessionExercises.sessionId, sessionId))
		).length;

	/** Move the workout to Trash from its own page, the way a user does. */
	async function trashFromSessionPage(page: Page) {
		await page.goto(`${origin}/sessions/${sessionId}?edit=1`, { waitUntil: 'networkidle' });
		await page.getByRole('button', { name: 'Move to Trash' }).click();
		await page
			.getByRole('group', { name: 'Confirm permanent deletion' })
			.getByRole('button', { name: 'Move to Trash' })
			.click();
		// A quick workout's program has no page; the action lands on History.
		await page.waitForURL(`${origin}/history`);
		await expect.poll(async () => (await sessionRow()).deletedAt).not.toBeNull();
	}

	const trash = (page: Page) => page.locator('details');
	const listLink = (page: Page) => page.locator(`ul a[href="/sessions/${sessionId}"]`);

	it('trash a quick workout, restore it from History, trash it again, delete it permanently', async () => {
		const page = await signedInPage();
		expect(await setCount()).toBe(1);

		// 1. Trash it. It leaves the month's list and shows in Trash, collapsed.
		await trashFromSessionPage(page);
		await page.waitForLoadState('networkidle');
		expect(await listLink(page).count()).toBe(0);
		expect(await trash(page).getAttribute('open')).toBeNull();
		expect((await trash(page).locator('summary').textContent())?.trim()).toBe(
			`${workoutUi.historyTrashHeading} (1)`
		);
		await trash(page).locator('summary').click();
		const item = trash(page).getByRole('listitem');
		expect(await item.count()).toBe(1);
		expect(await item.getByRole('heading').textContent()).toBe(workoutUi.quickWorkoutLabel);
		expect(await item.getByText(workoutUi.historyTrashSets(1)).count()).toBe(1);
		// The Trash list itself is CSP-clean: no style attribute anywhere.
		expect(await styledElements(page)).toEqual([]);

		// 2. Restore it. It is back in the list, and the row is live again.
		await item.getByRole('button', { name: workoutUi.historyTrashRestore }).click();
		await expect.poll(() => listLink(page).count()).toBe(1);
		expect((await sessionRow()).deletedAt).toBeNull();
		expect(await setCount()).toBe(1);
		expect((await trash(page).locator('summary').textContent())?.trim()).toBe(
			`${workoutUi.historyTrashHeading} (0)`
		);

		// 3. Trash it again, then delete it permanently, through the
		// confirmation step the program page uses.
		await trashFromSessionPage(page);
		await page.waitForLoadState('networkidle');
		await trash(page).locator('summary').click();
		await trash(page).getByRole('button', { name: workoutUi.historyTrashDelete }).click();
		const confirm = trash(page).getByRole('group', { name: 'Confirm permanent deletion' });
		expect(await confirm.textContent()).toContain(
			workoutUi.historyTrashConfirmDelete(workoutUi.quickWorkoutLabel, '').split(' from ')[0]
		);
		// Nothing is deleted until the confirmation is pressed.
		expect(await sessionRow()).toBeDefined();
		await confirm.getByRole('button', { name: workoutUi.historyTrashDelete }).click();

		// 4. Its rows are gone: the session, its sets, its exercises.
		await expect.poll(sessionRow).toBeUndefined();
		expect(await setCount()).toBe(0);
		expect(await occurrenceCount()).toBe(0);
		await expect
			.poll(async () => (await trash(page).locator('summary').textContent())?.trim())
			.toBe(`${workoutUi.historyTrashHeading} (0)`);
		expect(await listLink(page).count()).toBe(0);

		expect(await violations(page)).toEqual([]);
		await page.close();
	});
});
