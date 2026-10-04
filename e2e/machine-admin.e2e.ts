import { browserSuite, authenticatedPage, violations } from './browser';
/**
 * 0.7.0 (machines spec Parts G, H, K): remove, restore, change model, replace
 * and merge, each reached from the rendered page (CLAUDE.md: every action has
 * an e2e that reaches it from a page), through the PRODUCTION build on a
 * phone-width screen. Each test asserts the database state, not the redirect.
 * Strings come from `machineAdminUi`.
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
import { addSessionExercise, createGym, createMachine } from '$lib/server/machines';
import { startQuickSession } from '$lib/server/quick-workouts';
import { endSession } from '$lib/server/sessions';
import { machineAdminUi as ui } from '$lib/machine-admin-ui';

const { run, executablePath } = browserSuite();

run('fixing the gym list (production build)', () => {
	let harness: Awaited<ReturnType<typeof setupTestDb>>;
	let stopServer = async () => {};
	let origin: string;
	let cookie: string;
	let browser: Browser;
	let userId: string;
	let gymId: string;
	const models: Record<string, typeof s.equipmentModels.$inferSelect> = {};

	beforeAll(async () => {
		harness = await freshTestDb();
		userId = (await seedTestUser(harness.db)).id;
		for (const [key, code, name, loadingType, stack] of [
			['curl', 'LC-1', 'Leg Curl', 'machine-stack', 200],
			['ext', 'LE-1', 'Leg Extension', 'machine-stack', 300],
			['press', 'LP-1', 'Leg Press', 'machine-plate', null]
		] as const) {
			[models[key]] = await harness.db
				.insert(s.equipmentModels)
				.values({
					manufacturer: 'Life Fitness',
					code,
					name,
					loadingType,
					standardStackLb: stack,
					confidence: 'manufacturer_page'
				})
				.returning();
		}
		gymId = (await createGym(harness.db, userId, { name: 'Admin gym' })).id;
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

	const machine = (label: string | undefined, modelId?: string, type = 'machine-stack') =>
		createMachine(harness.db, userId, {
			gymId,
			localLabel: label,
			equipmentType: type,
			equipmentModelId: modelId
		});
	const machineRow = async (id: string) =>
		(await harness.db.select().from(s.gymEquipment).where(eq(s.gymEquipment.id, id)))[0];

	/** A finished workout with one set of 100 x 10 on the machine. */
	async function history(machineId: string, exerciseName: string) {
		const started = await startQuickSession(harness.db, userId, gymId);
		if (!started.ok) throw new Error(started.message);
		const occ = await addSessionExercise(harness.db, userId, started.sessionId, {
			exerciseName,
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
			.where(eq(s.sets.sessionExerciseId, occ.id));
		await endSession(harness.db, userId, started.sessionId);
	}

	const edit = (page: Page, id: string) =>
		page.goto(`${origin}/gyms/${gymId}/machines/${id}/edit`, { waitUntil: 'networkidle' });

	async function remove(page: Page) {
		await page.getByText(ui.removeMachine).click();
		await page.getByRole('button', { name: ui.removeConfirm, exact: true }).click();
		await page.waitForURL('**/gyms?**');
	}

	it('Remove: a machine with no history is deleted', async () => {
		const m = await machine('Added by mistake');
		const page = await signedInPage();
		await edit(page, m.id);
		await page.getByText(ui.removeMachine).click();
		expect(await page.getByTestId('removal-text').innerText()).toBe(ui.machineDeleteText);
		await page.getByRole('button', { name: ui.removeConfirm, exact: true }).click();
		await page.waitForURL('**/gyms?**');
		expect(await page.getByTestId('removed').innerText()).toBe(ui.removed('deleted'));
		expect(await machineRow(m.id)).toBeUndefined();
		expect(await violations(page)).toEqual([]);
		await page.close();
	});

	it('Remove: a machine with history is archived, then restored from the Archived section', async () => {
		const m = await machine('Curl with history', models.curl.id);
		await history(m.id, 'Curl A');
		const page = await signedInPage();
		await edit(page, m.id);
		await page.getByText(ui.removeMachine).click();
		expect(await page.getByTestId('removal-text').innerText()).toBe(ui.machineArchiveText);
		await page.getByRole('button', { name: ui.removeConfirm, exact: true }).click();
		await page.waitForURL('**/gyms?**');
		expect((await machineRow(m.id)).archivedAt).not.toBeNull();
		const archived = page.getByTestId('archived-machines');
		await archived.locator('summary').click();
		await archived.getByRole('button', { name: ui.restore }).click();
		await expect.poll(async () => (await machineRow(m.id)).archivedAt).toBeNull();
		await page.close();
	});

	it('Change model: same type in place with the stack offered on a tap; another type offers Replace', async () => {
		const m = await machine(undefined, models.curl.id);
		const page = await signedInPage();
		await edit(page, m.id);
		await page.getByText(ui.changeModel, { exact: true }).click();
		await page.getByRole('searchbox', { name: ui.searchPlaceholder }).fill('Leg Extension');
		await page.getByRole('button', { name: ui.search }).click();
		await page.getByRole('button', { name: /Leg Extension/ }).click();
		await page.getByRole('button', { name: ui.stackOffer(300) }).waitFor();
		expect(await machineRow(m.id)).toMatchObject({
			id: m.id,
			equipmentModelId: models.ext.id,
			localLabel: 'Life Fitness Leg Extension (LE-1)',
			stackLb: 200
		});
		await page.getByRole('button', { name: ui.stackOffer(300) }).click();
		await expect.poll(async () => (await machineRow(m.id)).stackLb).toBe(300);

		await edit(page, m.id);
		await page.getByText(ui.changeModel, { exact: true }).click();
		await page.getByRole('searchbox', { name: ui.searchPlaceholder }).fill('Leg Press');
		await page.getByRole('button', { name: ui.search }).click();
		await page.getByRole('button', { name: /Leg Press/ }).click();
		await page.getByTestId('replace').waitFor();
		expect((await machineRow(m.id)).equipmentModelId).toBe(models.ext.id);
		await page.getByRole('button', { name: ui.replaceButton }).click();
		await page.waitForURL((u) => u.pathname.endsWith('/edit') && !u.pathname.includes(m.id));
		const newId = page.url().split('/machines/')[1].split('/')[0];
		expect(await machineRow(newId)).toMatchObject({
			equipmentType: 'machine-plate',
			equipmentModelId: models.press.id
		});
		// No history on the old one: replaced means deleted.
		expect(await machineRow(m.id)).toBeUndefined();
		expect(await violations(page)).toEqual([]);
		await page.close();
	});

	it('Same machine as… merges two rows with a preview, and Undo merge puts them back', async () => {
		const keep = await machine('Curl by the window', models.curl.id);
		const drop = await machine('Photo 2:18 PM');
		await history(drop.id, 'Curl B');
		const page = await signedInPage();
		await edit(page, keep.id);
		await page.getByText(ui.sameMachineAs).click();
		await page.getByRole('link', { name: 'Photo 2:18 PM' }).click();
		await page.getByTestId('merge-preview').waitFor();
		expect(await page.getByTestId('merge-preview').innerText()).toContain(
			'Moves 1 set from 1 workout'
		);
		expect(await page.getByRole('radio', { name: 'Curl by the window' }).isChecked()).toBe(true);
		await page.getByRole('button', { name: ui.mergeButton }).click();
		await page.getByRole('button', { name: ui.undoMerge }).waitFor();
		const merged = await machineRow(drop.id);
		expect(merged).toMatchObject({ mergedIntoId: keep.id });
		const [set] = await harness.db
			.select()
			.from(s.sets)
			.where(eq(s.sets.userId, userId))
			.orderBy(s.sets.loggedAt);
		const moved = await harness.db.select().from(s.sets).where(eq(s.sets.gymEquipmentId, keep.id));
		expect(moved.length).toBeGreaterThan(0);
		expect(set).toBeTruthy();

		await page.getByRole('button', { name: ui.undoMerge }).click();
		await expect.poll(async () => (await machineRow(drop.id)).mergedIntoId).toBeNull();
		expect((await machineRow(drop.id)).archivedAt).toBeNull();
		expect(
			await harness.db.select().from(s.sets).where(eq(s.sets.gymEquipmentId, keep.id))
		).toEqual([]);
		await page.close();
	});

	it('Remove gym: an unused gym is deleted from the Gyms page; a gym with history is archived and restored', async () => {
		const empty = await createGym(harness.db, userId, { name: 'Holiday gym' });
		const page = await signedInPage();
		await page.goto(`${origin}/gyms`, { waitUntil: 'networkidle' });
		const section = page.locator('section', {
			has: page.getByRole('heading', { name: 'Holiday gym' })
		});
		await section.getByText(ui.removeGym).click();
		expect(await section.getByText(ui.gymDeleteText).count()).toBe(1);
		await section.getByRole('button', { name: ui.removeConfirm, exact: true }).click();
		await expect
			.poll(async () => harness.db.select().from(s.gyms).where(eq(s.gyms.id, empty.id)))
			.toEqual([]);

		await page.goto(`${origin}/gyms`, { waitUntil: 'networkidle' });
		const main = page.locator('section', { has: page.getByRole('heading', { name: 'Admin gym' }) });
		await main.getByText(ui.removeGym).click();
		expect(await main.getByText(ui.gymArchiveText).count()).toBe(1);
		await main.getByRole('button', { name: ui.removeConfirm, exact: true }).click();
		await expect
			.poll(
				async () =>
					(await harness.db.select().from(s.gyms).where(eq(s.gyms.id, gymId)))[0].archivedAt
			)
			.not.toBeNull();
		const archived = page.getByTestId('archived-gyms');
		await archived.locator('summary').click();
		await archived.getByRole('button', { name: ui.restore }).click();
		await expect
			.poll(
				async () =>
					(await harness.db.select().from(s.gyms).where(eq(s.gyms.id, gymId)))[0].archivedAt
			)
			.toBeNull();
		await page.close();
	});
});
