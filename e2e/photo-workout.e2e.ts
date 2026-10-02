/**
 * 0.6.0 (spec 0.5.0 Part C): a photo in the workout, through the PRODUCTION
 * build in a real browser, on a phone-width screen. The served build has no
 * model configured, which is the spec's "model off" acceptance case: every
 * read fails, and a whole workout is still logged against photos. A read that
 * did find a match is simulated by writing the candidate to the photo row, as
 * `analyzePhoto` would. Strings come from `workoutUi`, never literals.
 *
 * Prerequisites and skip rules are the same as csp.e2e.ts.
 */
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { and, eq, isNotNull } from 'drizzle-orm';
import { setupTestDb } from '$lib/server/test-db';
import {
	BUILD_ENTRY,
	freshTestDb,
	seedTestUser,
	signInAs,
	startTestServer
} from '$lib/server/test-auth-helpers';
import * as s from '$lib/server/db/schema';
import { FIXTURE_CANDIDATE, smallPng } from '$lib/server/photos/test-fixtures';
import { workoutUi } from '$lib/workout-ui';

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

const GYM = 'Photo gym';

run('photo in the workout (production build, no model configured)', () => {
	let harness: Awaited<ReturnType<typeof setupTestDb>>;
	let stopServer = async () => {};
	let origin: string;
	let cookie: string;
	let browser: Browser;
	let userId: string;
	let modelId: string;
	let png: Buffer;

	beforeAll(async () => {
		harness = await freshTestDb();
		userId = (await seedTestUser(harness.db)).id;
		const [model] = await harness.db
			.insert(s.equipmentModels)
			.values({
				manufacturer: 'Hammer Strength',
				productLine: 'Plate Loaded',
				code: 'IL-ROW',
				name: 'Iso-Lateral Row',
				loadingType: 'machine-plate',
				confidence: 'manufacturer_page'
			})
			.returning();
		modelId = model.id;
		png = await smallPng();
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

	async function startWorkout(page: Page) {
		await page.goto(origin + '/workout/start', { waitUntil: 'networkidle' });
		const existing = page.getByRole('radio', { name: GYM });
		if (!(await existing.count())) await page.getByLabel(workoutUi.gymStepNewName).fill(GYM);
		await page.getByRole('button', { name: workoutUi.gymStepSubmit, exact: true }).click();
		await page.waitForURL('**/sessions/*');
		return page.url().split('/').pop()!;
	}

	async function photoNextMachine(page: Page) {
		const button = page.locator('label', { hasText: workoutUi.photoNextMachine });
		expect(await button.isVisible()).toBe(true);
		expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
		// The file input: no capture attribute (0.4.2), so the phone offers a choice.
		const input = button.locator('input[type="file"]');
		expect(await input.getAttribute('capture')).toBeNull();
		await input.setInputFiles({ name: 'IMG_0001.PNG', mimeType: 'image/png', buffer: png });
		await expect
			.poll(() =>
				page.getByRole('heading', { name: workoutUi.placeholderExerciseName, exact: true }).count()
			)
			.toBe(1);
	}

	const photoRows = () =>
		harness.db.select().from(s.equipmentPhotos).where(eq(s.equipmentPhotos.userId, userId));

	it('model off: a photo opens a block at once, the read fails quietly, sets are logged, and finishing lists what to name', async () => {
		const page = await signedInPage();
		const sessionId = await startWorkout(page);
		// The workout's own bar carries the photo button; the tabs step aside.
		expect(await page.getByRole('navigation', { name: 'Main navigation' }).count()).toBe(0);

		const started = Date.now();
		await photoNextMachine(page);
		// The read ran and failed (no model): one quiet line, nothing lost.
		await expect.poll(() => page.getByText(workoutUi.photoReadFailed).count()).toBe(1);
		// The page did fire the read on its own: complete() records every call,
		// a refused "not configured" one included.
		const reads = await harness.db
			.select()
			.from(s.llmCalls)
			.where(and(eq(s.llmCalls.userId, userId), eq(s.llmCalls.purpose, 'equipment_from_photo')));
		expect(reads).toHaveLength(1);
		expect(await page.getByRole('button', { name: workoutUi.photoReadAgain }).count()).toBe(1);
		expect(await page.getByRole('link', { name: workoutUi.photoNameIt }).count()).toBe(1);
		expect(await page.getByTestId('machines-to-name').innerText()).toBe(
			workoutUi.machinesToName(1)
		);

		await page.getByRole('spinbutton', { name: 'Weight', exact: true }).first().fill('70');
		await page.getByRole('spinbutton', { name: 'Reps', exact: true }).first().fill('12');
		await page.getByRole('button', { name: 'Save set 1' }).click();
		await expect.poll(() => page.getByText('✓ Saved').count()).toBe(1);
		expect(Date.now() - started, 'photo to first saved set, locally').toBeLessThan(15_000);

		// State: the set is on the photo's placeholder machine, and the photo
		// is tied to the block.
		const [photo] = await photoRows();
		expect(photo.status).toBe('uploaded');
		expect(photo.sessionExerciseId).toBeTruthy();
		const saved = await harness.db
			.select()
			.from(s.sets)
			.where(
				and(eq(s.sets.sessionExerciseId, photo.sessionExerciseId!), isNotNull(s.sets.executedLoad))
			);
		expect(saved.map((r) => [r.executedLoad, r.executedReps])).toEqual([[70, 12]]);

		// Finishing with a machine to name is allowed; the finished page lists it.
		page.once('dialog', (d) => d.accept());
		await page.getByRole('button', { name: 'Finish workout' }).click();
		await page.waitForURL(`${origin}/sessions/${sessionId}`);
		expect(await page.getByTestId('machines-to-name').innerText()).toBe(
			workoutUi.machinesToName(1)
		);
		await page.goto(origin + '/', { waitUntil: 'networkidle' });
		expect(await page.getByTestId('machines-to-name').innerText()).toContain(
			workoutUi.machinesToName(1)
		);
		expect(await violations(page)).toEqual([]);
		await page.close();
	});

	it('named later from the review page: the finished workout’s block takes the model and keeps its set', async () => {
		const [photo] = await photoRows();
		// The read that found the placard, as analyzePhoto would store it.
		await harness.db
			.update(s.equipmentPhotos)
			.set({ status: 'analyzed', candidate: FIXTURE_CANDIDATE })
			.where(eq(s.equipmentPhotos.id, photo.id));
		const page = await signedInPage();
		await page.goto(`${origin}/photos/${photo.id}/review`, { waitUntil: 'networkidle' });
		expect(await page.getByTestId('block-note').isVisible()).toBe(true);
		await page.locator('form[action="?/link"] button').first().click();
		await page.waitForURL('**/sessions/*');
		await expect.poll(() => page.getByRole('heading', { name: 'Iso-Lateral Row' }).count()).toBe(1);
		expect(await page.getByTestId('machines-to-name').count()).toBe(0);

		const [block] = await harness.db
			.select()
			.from(s.sessionExercises)
			.where(eq(s.sessionExercises.id, photo.sessionExerciseId!));
		expect(block.exerciseName).toBe('Iso-Lateral Row');
		const kept = await harness.db
			.select()
			.from(s.sets)
			.where(and(eq(s.sets.sessionExerciseId, block.id), isNotNull(s.sets.executedLoad)));
		expect(kept.map((r) => [r.executedLoad, r.executedReps])).toEqual([[70, 12]]);
		const [confirmed] = await harness.db
			.select()
			.from(s.equipmentPhotos)
			.where(eq(s.equipmentPhotos.id, photo.id));
		expect(confirmed).toMatchObject({ status: 'confirmed', matchedModelId: modelId });
		await page.close();
	});

	it('a read that found the machine: one tap on "Use this" names the block, merging into the gym’s machine; Undo puts it back', async () => {
		const page = await signedInPage();
		await startWorkout(page);
		await photoNextMachine(page);
		await expect.poll(() => page.getByText(workoutUi.photoReadFailed).count()).toBe(1);
		const [latest] = (await photoRows()).sort((a, b) => +b.createdAt - +a.createdAt);
		await harness.db
			.update(s.equipmentPhotos)
			.set({ status: 'analyzed', candidate: FIXTURE_CANDIDATE })
			.where(eq(s.equipmentPhotos.id, latest.id));
		await page.reload({ waitUntil: 'networkidle' });

		const card = page.locator('form[action="?/identify"]');
		expect(await card.getByText('Hammer Strength Iso-Lateral Row (IL-ROW)').count()).toBe(1);
		// "Later" changes nothing but hides the card.
		await card.getByRole('button', { name: workoutUi.photoLater }).click();
		expect(await card.count()).toBe(0);
		await page.reload({ waitUntil: 'networkidle' });
		await card.getByRole('button', { name: workoutUi.photoUseThis }).click();
		await expect.poll(() => page.getByRole('heading', { name: 'Iso-Lateral Row' }).count()).toBe(1);

		// The gym's IL-ROW from the first workout is reused: one machine per model.
		const machines = await harness.db
			.select()
			.from(s.gymEquipment)
			.where(eq(s.gymEquipment.equipmentModelId, modelId));
		expect(machines).toHaveLength(1);
		const [named] = await harness.db
			.select()
			.from(s.equipmentPhotos)
			.where(eq(s.equipmentPhotos.id, latest.id));
		expect(named).toMatchObject({ status: 'confirmed', gymEquipmentId: machines[0].id });

		// 0.6.2: the named block's set rows follow the new machine. They show last
		// time's numbers (70 x 12, logged on this IL-ROW in the first workout) and
		// a set saves; the rows used to keep the placeholder's identity, so the
		// field stayed blank and the save was refused until a reload.
		const weight = page.getByRole('spinbutton', { name: 'Weight', exact: true }).first();
		await expect.poll(() => weight.inputValue()).toBe('70');
		await page.getByRole('spinbutton', { name: 'Reps', exact: true }).first().fill('11');
		await page.getByRole('button', { name: 'Save set 1' }).click();
		await expect.poll(() => page.getByText('✓ Saved').count()).toBe(1);
		const savedAfterNaming = await harness.db
			.select()
			.from(s.sets)
			.where(
				and(eq(s.sets.sessionExerciseId, latest.sessionExerciseId!), isNotNull(s.sets.executedLoad))
			);
		expect(savedAfterNaming.map((r) => [r.executedLoad, r.executedReps, r.gymEquipmentId])).toEqual(
			[[70, 11, machines[0].id]]
		);

		// Undo (0.6.1): back to the placeholder, the card offered again, the
		// gym's machine kept.
		expect(await page.getByTestId('photo-named').innerText()).toContain(
			workoutUi.photoNamedFrom('Hammer Strength Iso-Lateral Row (IL-ROW)')
		);
		await page
			.getByTestId('photo-named')
			.getByRole('button', { name: workoutUi.photoUndo })
			.click();
		await expect
			.poll(() =>
				page.getByRole('heading', { name: workoutUi.placeholderExerciseName, exact: true }).count()
			)
			.toBe(1);
		expect(await card.getByRole('button', { name: workoutUi.photoUseThis }).count()).toBe(1);
		expect(
			await card.getByRole('link', { name: workoutUi.photoOtherMachine }).getAttribute('href')
		).toBe(`/photos/${latest.id}/review`);
		const [undone] = await harness.db
			.select()
			.from(s.equipmentPhotos)
			.where(eq(s.equipmentPhotos.id, latest.id));
		expect(undone).toMatchObject({ status: 'analyzed', gymEquipmentId: null });
		expect(
			await harness.db.select().from(s.gymEquipment).where(eq(s.gymEquipment.id, machines[0].id))
		).toHaveLength(1);
		expect(await violations(page)).toEqual([]);
		await page.close();
	});
});
