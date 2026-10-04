import { browserSuite, authenticatedPage, violations } from './browser';
/**
 * Editor spec Part M: save a finished workout as a program, through the
 * PRODUCTION build at 390 px. "A quick workout of five exercises becomes a
 * saved program in under a minute, with no retyping"; a workout from History
 * becomes a new day of an existing program; the source workout is unchanged.
 *
 * Prerequisites and skip rules are the same as csp.e2e.ts.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { asc, eq } from 'drizzle-orm';
import { setupTestDb } from '$lib/server/test-db';
import {
	freshTestDb,
	seedTestUser,
	signInAs,
	startTestServer
} from '$lib/server/test-auth-helpers';
import * as s from '$lib/server/db/schema';
import { addSessionExercise, createGym } from '$lib/server/machines';
import { startQuickSession } from '$lib/server/quick-workouts';
import { editorUi } from '$lib/editor-ui';
import { workoutUi } from '$lib/workout-ui';

const { run, executablePath } = browserSuite();

run('saving a finished workout as a program (production build)', () => {
	let harness: Awaited<ReturnType<typeof setupTestDb>>;
	let stopServer = async () => {};
	let origin: string;
	let cookie: string;
	let browser: Browser;
	let userId: string;
	let gymId: string;

	beforeAll(async () => {
		harness = await freshTestDb();
		userId = (await seedTestUser(harness.db)).id;
		gymId = (await createGym(harness.db, userId, { name: 'Home gym' })).id;
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
	const FIVE = [
		'Dumbbell press',
		'Incline dumbbell press',
		'Dumbbell curl',
		'Goblet squat',
		'Barbell curl'
	];
	/** A quick workout of the five, every set logged, still open. */
	async function quickWorkout() {
		const db = harness.db;
		const started = await startQuickSession(db, userId, gymId);
		if (!started.ok) throw new Error(started.message);
		const library = await db.select().from(s.exercises).where(eq(s.exercises.userId, userId));
		for (const name of FIVE) {
			const exercise = library.find((e) => e.name === name)!;
			await addSessionExercise(db, userId, started.sessionId, {
				exerciseId: exercise.id,
				equipmentType: exercise.equipmentType,
				loadConvention: 'displayed',
				setCount: '2',
				repsMin: '8',
				repsMax: '12',
				rir: '2',
				tier: 'secondary',
				progressionPolicy: 'standard'
			});
		}
		const rows = await db.select().from(s.sets).where(eq(s.sets.sessionId, started.sessionId));
		for (const [i, row] of rows.entries())
			await db
				.update(s.sets)
				.set({ executedLoad: 30, executedReps: 9 + (i % 2), executedRir: 2 })
				.where(eq(s.sets.id, row.id));
		return started.sessionId;
	}
	const snapshot = async (sessionId: string) =>
		harness.db.select().from(s.sets).where(eq(s.sets.sessionId, sessionId)).orderBy(asc(s.sets.id));

	it('a quick workout of five exercises becomes a saved program in under a minute', async () => {
		const sessionId = await quickWorkout();
		const page = await signedInPage();
		await page.goto(`${origin}/sessions/${sessionId}`, { waitUntil: 'networkidle' });
		const started = Date.now();
		await page.getByRole('button', { name: 'Finish workout' }).click();
		// A quick workout finishes on its own page: the finish screen.
		await page.waitForURL(`${origin}/sessions/${sessionId}`);
		const before = await snapshot(sessionId);
		await page.getByRole('link', { name: workoutUi.newProgramFromWorkout, exact: true }).click();
		await page.waitForURL(/\/programs\/new\?fromSession=/);
		// The editor opens on the day built from the workout: nothing to retype.
		const rows = await page.getByTestId('exercise-row').allInnerTexts();
		expect(rows.map((r) => r.split(' · ')[0])).toEqual(FIVE);
		expect(rows[0]).toContain('2 × 9–10 · RIR 2');
		await page.getByRole('button', { name: editorUi.backToProgram, exact: true }).click();
		await page.getByRole('button', { name: editorUi.review, exact: true }).click();
		await page.getByRole('button', { name: editorUi.save, exact: true }).click();
		await page.waitForURL(/\/programs\/[0-9a-f-]{36}$/);
		expect(Date.now() - started).toBeLessThan(60_000);
		const programId = page.url().split('/').at(-1)!;
		const [day] = await harness.db.select().from(s.days).where(eq(s.days.programId, programId));
		const exercises = await harness.db
			.select()
			.from(s.dayExercises)
			.where(eq(s.dayExercises.dayId, day.id));
		expect(exercises).toHaveLength(5);
		expect(await snapshot(sessionId)).toEqual(before);
		expect(
			await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
		).toBe(true);
		expect(await violations(page)).toEqual([]);
		await page.close();
	});

	it('from History, a workout becomes a new day of an existing program', async () => {
		// The program the first test saved.
		const target = (
			await harness.db.select().from(s.programs).where(eq(s.programs.userId, userId))
		).find((p) => p.systemKind === null && p.isActive)!;
		const sessionId = await quickWorkout();
		await harness.db
			.update(s.sessions)
			.set({ endedAt: new Date() })
			.where(eq(s.sessions.id, sessionId));
		const page = await signedInPage();
		await page.goto(`${origin}/history`, { waitUntil: 'networkidle' });
		await page.locator(`a[href="/sessions/${sessionId}"]`).first().click();
		await page.waitForURL(`${origin}/sessions/${sessionId}`);
		await page.getByRole('link', { name: workoutUi.addAsDayTo(target.name), exact: true }).click();
		await page.waitForURL(/\/edit\?fromSession=/);
		expect(await page.getByRole('heading', { level: 1 }).innerText()).toBe('Workout 2');
		await page.getByRole('button', { name: editorUi.backToProgram, exact: true }).click();
		await page.getByRole('button', { name: editorUi.review, exact: true }).click();
		await page.getByRole('button', { name: editorUi.saveVersion, exact: true }).click();
		await page.waitForURL(/\/programs\/[0-9a-f-]{36}$/);
		const days = await harness.db
			.select()
			.from(s.days)
			.where(eq(s.days.programId, page.url().split('/').at(-1)!))
			.orderBy(asc(s.days.position));
		expect(days.map((d) => d.name)).toEqual(['Workout', 'Workout 2']);
		await page.close();
	});
});
