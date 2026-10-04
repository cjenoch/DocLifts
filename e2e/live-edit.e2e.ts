import { browserSuite, authenticatedPage, violations } from './browser';
/**
 * Editor spec Part L: editing a live workout from its page, through the
 * PRODUCTION build at 390 px. Move, remove with Undo, swap "From now on",
 * skip the rest, remove logged sets with a confirm, and the finished
 * workout's line saying the program changed.
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
import { workoutUi as ui } from '$lib/workout-ui';

const { run, executablePath } = browserSuite();

run('editing a live workout (production build)', () => {
	let harness: Awaited<ReturnType<typeof setupTestDb>>;
	let stopServer = async () => {};
	let origin: string;
	let cookie: string;
	let browser: Browser;
	let userId: string;
	let programId: string;
	let dayId: string;

	beforeAll(async () => {
		harness = await freshTestDb();
		const db = harness.db;
		userId = (await seedTestUser(db)).id;
		const library = await db.select().from(s.exercises).where(eq(s.exercises.userId, userId));
		const id = (name: string) => library.find((e) => e.name === name)!.id;
		const row = (name: string, count: number) => ({
			exerciseId: id(name),
			newExercise: null,
			tier: 'secondary' as const,
			progressionPolicy: 'standard' as const,
			notes: null,
			sets: Array.from({ length: count }, blankSetDraft)
		});
		programId = (
			await saveProgramDraft(db, userId, {
				requestId: randomUUID(),
				sourceProgramId: null,
				draft: {
					name: 'Edit me',
					description: null,
					days: [
						{
							name: 'Arms day',
							notes: null,
							alternateGroupId: null,
							exercises: [row('Dumbbell press', 3), row('Dumbbell curl', 2), row('Goblet squat', 2)]
						}
					]
				}
			})
		).id;
		[{ id: dayId }] = await db.select().from(s.days).where(eq(s.days.programId, programId));
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
	const headings = (page: Page) => page.locator('section.exercise h2').allInnerTexts();
	async function openMenu(page: Page, name: string) {
		if (await page.getByRole('button', { name: 'Edit workout', exact: true }).isVisible())
			await page.getByRole('button', { name: 'Edit workout', exact: true }).click();
		await page.getByLabel(ui.exerciseMenu(name), { exact: true }).click();
	}
	const occurrenceNames = async (sessionId: string) =>
		(
			await harness.db
				.select()
				.from(s.sessionExercises)
				.where(eq(s.sessionExercises.sessionId, sessionId))
				.orderBy(asc(s.sessionExercises.position))
		).map((o) => o.exerciseName);

	it('move, remove with Undo, swap from now on, skip, remove logged sets, finish', async () => {
		const started = await startSessionForDay(harness.db, userId, dayId);
		if (!started.ok) throw new Error(started.message);
		const sessionId = started.sessionId;
		const page = await signedInPage();
		await page.goto(`${origin}/sessions/${sessionId}`, { waitUntil: 'networkidle' });
		expect(await headings(page)).toEqual(['Dumbbell press', 'Dumbbell curl', 'Goblet squat']);

		// Move up, and the order survives a reload.
		await openMenu(page, 'Dumbbell curl');
		await page.getByRole('button', { name: ui.moveUp, exact: true }).click();
		await expect
			.poll(() => headings(page))
			.toEqual(['Dumbbell curl', 'Dumbbell press', 'Goblet squat']);
		await page.reload({ waitUntil: 'networkidle' });
		expect(await headings(page)).toEqual(['Dumbbell curl', 'Dumbbell press', 'Goblet squat']);

		// Remove with nothing logged: Undo in place of a confirm.
		await openMenu(page, 'Goblet squat');
		await page.getByRole('button', { name: ui.remove, exact: true }).click();
		expect(await page.getByTestId('undo-remove').innerText()).toContain(
			ui.removedLine('Goblet squat')
		);
		expect(await headings(page)).toEqual(['Dumbbell curl', 'Dumbbell press']);
		await page.getByRole('button', { name: ui.undo, exact: true }).click();
		expect(await headings(page)).toEqual(['Dumbbell curl', 'Dumbbell press', 'Goblet squat']);
		expect(await occurrenceNames(sessionId)).toHaveLength(3);
		await openMenu(page, 'Goblet squat');
		await page.getByRole('button', { name: ui.remove, exact: true }).click();
		await expect
			.poll(() => occurrenceNames(sessionId), { timeout: (ui.undoSeconds + 5) * 1000 })
			.toEqual(['Dumbbell curl', 'Dumbbell press']);
		await expect.poll(() => page.getByTestId('undo-remove').count()).toBe(0);

		// Swap the untouched press "From now on".
		await openMenu(page, 'Dumbbell press');
		await page.getByRole('button', { name: ui.swap, exact: true }).click();
		const sheet = page.getByRole('dialog');
		await sheet
			.getByTestId('exercise-row')
			.filter({ hasText: 'Incline dumbbell press' })
			.first()
			.click();
		expect(await sheet.getByTestId('swap-confirm').innerText()).toBe(
			ui.swapConfirm('Dumbbell press', 'Incline dumbbell press')
		);
		await sheet.getByRole('button', { name: ui.swapFromNow, exact: true }).click();
		await expect.poll(() => page.getByRole('dialog').count()).toBe(0);
		expect(await headings(page)).toEqual(['Dumbbell curl', 'Incline dumbbell press']);

		// A logged set: swap is closed and says why; skip the rest keeps it.
		await page.getByRole('spinbutton', { name: 'Weight', exact: true }).first().fill('25');
		await page.getByRole('spinbutton', { name: 'Reps', exact: true }).first().fill('10');
		await page.getByRole('button', { name: 'Save set 1' }).first().click();
		await expect.poll(() => page.getByText('✓ Saved').count()).toBe(1);
		await openMenu(page, 'Dumbbell curl');
		expect(await page.getByText(ui.swapLocked).count()).toBe(1);
		expect(await page.getByRole('button', { name: ui.swap, exact: true }).count()).toBe(0);
		await page.getByRole('button', { name: ui.skipRest, exact: true }).click();
		await expect
			.poll(
				async () =>
					(
						await harness.db
							.select()
							.from(s.sets)
							.where(and(eq(s.sets.sessionId, sessionId), eq(s.sets.userId, userId)))
					).length
			)
			.toBe(4);

		// Remove the curl and its one logged set, after the confirm.
		await openMenu(page, 'Dumbbell curl');
		let question = '';
		page.once('dialog', (d) => {
			question = d.message();
			void d.accept();
		});
		await page.getByRole('button', { name: ui.removeWithSets, exact: true }).click();
		await expect.poll(() => occurrenceNames(sessionId)).toEqual(['Incline dumbbell press']);
		expect(question).toBe(ui.confirmRemoveLogged('Dumbbell curl', 1));

		// Finish: the program now has the swap.
		page.once('dialog', (d) => void d.accept());
		await page.getByRole('button', { name: 'Finish workout' }).click();
		await page.waitForURL(/program=updated/);
		expect(await page.getByTestId('program-update').innerText()).toContain(ui.programUpdated);
		const [old] = await harness.db.select().from(s.programs).where(eq(s.programs.id, programId));
		expect(old.isActive).toBe(false);
		expect(
			await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
		).toBe(true);
		expect(await violations(page)).toEqual([]);
		await page.close();
	});
});
