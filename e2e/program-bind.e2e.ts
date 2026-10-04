import { browserSuite, authenticatedPage, violations } from './browser';
/**
 * 0.8.1 (machines spec Part I, "In a program workout"): a planned exercise's
 * machine is chosen in the add sheet, with a confirm step in place of the old
 * "CHANGE" checkbox, through the PRODUCTION build at 390 px. The refusal after
 * a logged set stays: the control is gone once a set is saved.
 *
 * Prerequisites and skip rules are the same as csp.e2e.ts.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { and, eq } from 'drizzle-orm';
import { setupTestDb } from '$lib/server/test-db';
import {
	freshTestDb,
	seedTestUser,
	signInAs,
	startTestServer
} from '$lib/server/test-auth-helpers';
import * as s from '$lib/server/db/schema';
import { createGym, createMachine } from '$lib/server/machines';
import { startSessionForDay } from '$lib/server/sessions';
import { pickerUi as ui } from '$lib/picker-ui';

const { run, executablePath } = browserSuite();

run('choosing a planned exercise machine in a program workout (production build)', () => {
	let harness: Awaited<ReturnType<typeof setupTestDb>>;
	let stopServer = async () => {};
	let origin: string;
	let cookie: string;
	let browser: Browser;
	let userId: string;
	let gymId: string;
	let pressId: string;
	let dayId: string;

	beforeAll(async () => {
		harness = await freshTestDb();
		const db = harness.db;
		userId = (await seedTestUser(db)).id;
		gymId = (await createGym(db, userId, { name: 'Program gym' })).id;
		pressId = (
			await createMachine(db, userId, {
				gymId,
				localLabel: 'Leg press 2',
				equipmentType: 'machine-plate'
			})
		).id;
		await createMachine(db, userId, {
			gymId,
			localLabel: 'Pulldown',
			equipmentType: 'machine-stack'
		});
		const [program] = await db
			.insert(s.programs)
			.values({ name: 'Legs program', userId })
			.returning();
		const [day] = await db
			.insert(s.days)
			.values({ programId: program.id, name: 'Legs', position: 1 })
			.returning();
		dayId = day.id;
		const [press] = await db
			.select()
			.from(s.exercises)
			.where(and(eq(s.exercises.userId, userId), eq(s.exercises.name, 'Leg press')));
		const [dx] = await db
			.insert(s.dayExercises)
			.values({
				dayId,
				exerciseId: press.id,
				position: 1,
				tier: 'secondary',
				progressionPolicy: 'standard'
			})
			.returning();
		await db.insert(s.prescribedSets).values({
			dayExerciseId: dx.id,
			position: 1,
			setRole: 'working',
			targetMetric: 'reps',
			targetRepsMin: 8,
			targetRepsMax: 12,
			targetRir: 2
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

	it('Choose machine: only machines of its type, a confirm step, then bound; gone once a set is logged', async () => {
		const started = await startSessionForDay(harness.db, userId, dayId);
		if (!started.ok) throw new Error(started.message);
		const page = await signedInPage();
		await page.goto(`${origin}/sessions/${started.sessionId}`, { waitUntil: 'networkidle' });
		await page.getByRole('button', { name: ui.chooseMachine }).click();
		const sheet = page.getByRole('dialog', { name: ui.addExercise });
		await sheet.waitFor();
		expect(
			await sheet.getByRole('heading', { name: ui.chooseMachineFor('Leg press') }).count()
		).toBe(1);
		// Plate-loaded only: the stack machine is not offered.
		const labels = await sheet.getByTestId('machine-row').allInnerTexts();
		expect(labels.some((l) => l.includes('Leg press 2'))).toBe(true);
		expect(labels.some((l) => l.includes('Pulldown'))).toBe(false);
		await sheet.getByTestId('machine-row').filter({ hasText: 'Leg press 2' }).first().click();
		expect(await sheet.getByTestId('bind-confirm').innerText()).toBe(
			ui.useMachineFor('Leg press 2')
		);
		await sheet.getByRole('button', { name: ui.useThisMachine }).click();
		await expect.poll(() => page.getByRole('dialog').count()).toBe(0);
		const [block] = await harness.db
			.select()
			.from(s.sessionExercises)
			.where(eq(s.sessionExercises.sessionId, started.sessionId));
		expect(block).toMatchObject({ gymEquipmentId: pressId, loadConvention: 'plates_per_side' });

		// A logged set: the control is gone (the server refuses a change anyway).
		await page.getByRole('spinbutton', { name: 'Weight', exact: true }).first().fill('90');
		await page.getByRole('spinbutton', { name: 'Reps', exact: true }).first().fill('10');
		await page.getByRole('button', { name: 'Save set 1' }).click();
		await expect.poll(() => page.getByText('✓ Saved').count()).toBe(1);
		await page.reload({ waitUntil: 'networkidle' });
		expect(await page.getByRole('button', { name: ui.changeMachine }).count()).toBe(0);
		expect(await violations(page)).toEqual([]);
		await page.close();
	});
});
