import { browserSuite, authenticatedPage, violations } from './browser';
/**
 * The 0.3.0 equipment pages, driven from the rendered page in a real browser
 * against the PRODUCTION build (CLAUDE.md: "every action has an e2e that
 * reaches it from a page"). The real 543-row catalog is imported first, so the
 * pages are exercised at the size they ship with.
 *
 * Prerequisites and skip rules are the same as csp.e2e.ts.
 */
import { readFileSync } from 'node:fs';
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
import { importCatalog } from '$lib/server/catalog-import';
import * as s from '$lib/server/db/schema';

const { run, executablePath } = browserSuite();

run('equipment pages (production build)', () => {
	let harness: Awaited<ReturnType<typeof setupTestDb>>;
	let stopServer = async () => {};
	let origin: string;
	let cookie: string;
	let browser: Browser;
	let userId: string;
	let gymId: string;

	beforeAll(async () => {
		harness = await freshTestDb();
		const db = harness.db;
		const user = await seedTestUser(db);
		userId = user.id;
		const csv = readFileSync('data/catalog/equipment_models_seed_2026-09-30.csv', 'utf8');
		expect((await importCatalog(db, csv, { dryRun: false })).failed).toBe(false);
		[{ id: gymId }] = await db
			.insert(s.gyms)
			.values({ name: 'E2E Gym', userId: user.id })
			.returning();
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

	const signedInPage = () => authenticatedPage(browser, cookie);

	it('search by code, open the model, and add it to a gym from the page', async () => {
		const page = await signedInPage();
		await page.goto(origin + '/equipment', { waitUntil: 'networkidle' });
		await expect.poll(() => page.getByRole('status').textContent()).toContain('543 models');
		await page.getByLabel('Search name or model code').fill('IL-ROW');
		await page.getByRole('button', { name: 'Apply' }).click();
		await page.waitForURL('**/equipment?**q=IL-ROW**');
		await expect.poll(() => page.getByRole('status').textContent()).toContain('1 model');
		await page.getByRole('link', { name: 'Iso-Lateral Row' }).click();
		await page.waitForURL('**/equipment/*');

		await page.getByLabel('Gym').selectOption(gymId);
		await page.getByLabel('Local label').fill('Row by the window');
		await page.getByLabel('Stack (lb, optional)').fill('200');
		await page.getByRole('button', { name: 'Add to gym' }).click();
		await expect.poll(() => page.getByRole('status').textContent()).toBe('Added to your gym');
		await expect
			.poll(() => page.getByText('E2E Gym · Row by the window · 200 lb stack').count())
			.toBe(1);

		// The state, not the response: the row exists, in this user's gym.
		const rows = await harness.db
			.select()
			.from(s.gymEquipment)
			.where(
				and(eq(s.gymEquipment.gymId, gymId), eq(s.gymEquipment.localLabel, 'Row by the window'))
			);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ stackLb: 200, equipmentType: 'machine-plate' });
		expect(await violations(page)).toEqual([]);
		void userId;
		await page.close();
	});

	it('the /gyms model picker narrows to the gym, expands to all, and searches', async () => {
		const db = harness.db;
		const [gym] = await db.insert(s.gyms).values({ name: 'Picker Gym', userId }).returning();
		const hammer = await db
			.select()
			.from(s.equipmentModels)
			.where(eq(s.equipmentModels.manufacturer, 'Hammer Strength'));
		const bench = hammer.find((m) => m.code === 'IL-HBP')!;
		const row = hammer.find((m) => m.code === 'IL-ROW')!;
		await db.insert(s.gymEquipment).values({
			gymId: gym.id,
			localLabel: 'Bench',
			equipmentType: bench.loadingType,
			equipmentModelId: bench.id
		});

		const page = await signedInPage();
		await page.goto(`${origin}/gyms?gym=${gym.id}`, { waitUntil: 'networkidle' });
		const modelOptions = () => page.getByLabel('Known model (optional)').locator('option').count();
		// "Unknown / enter below" plus every Hammer Strength model, nothing else.
		expect(await modelOptions()).toBe(hammer.length + 1);

		await page.getByRole('link', { name: 'Show all manufacturers' }).click();
		await page.waitForURL('**all=1**');
		expect(await modelOptions()).toBe(543 + 1);

		await page.getByLabel('Search models by name or code').fill('IL-ROW');
		await page.getByRole('button', { name: 'Show models' }).click();
		await page.waitForURL('**q=IL-ROW**');
		expect(await modelOptions()).toBe(2);

		// And the narrowed list feeds the real action.
		await page.getByLabel('Local machine label').fill('Picked row');
		await page.getByLabel('Equipment type').selectOption('machine-plate');
		await page.getByLabel('Known model (optional)').selectOption(row.id);
		await page.getByRole('button', { name: 'Add machine' }).click();
		await expect.poll(() => page.getByRole('status').textContent()).toBe('Machine created');
		const made = await db
			.select()
			.from(s.gymEquipment)
			.where(and(eq(s.gymEquipment.gymId, gym.id), eq(s.gymEquipment.localLabel, 'Picked row')));
		expect(made).toHaveLength(1);
		expect(made[0].equipmentModelId).toBe(row.id);
		expect(await violations(page)).toEqual([]);
		await page.close();
	});
	// 0.3.2: the label is optional when there is a model to name the machine after.
	it('a blank label is named after the model, on both add-machine forms', async () => {
		const db = harness.db;
		const [gym] = await db.insert(s.gyms).values({ name: 'Label Gym', userId }).returning();
		const [row] = await db
			.select()
			.from(s.equipmentModels)
			.where(
				and(
					eq(s.equipmentModels.manufacturer, 'Hammer Strength'),
					eq(s.equipmentModels.code, 'IL-ROW')
				)
			);
		const labels = async () =>
			(await db.select().from(s.gymEquipment).where(eq(s.gymEquipment.gymId, gym.id)))
				.map((m) => m.localLabel)
				.sort();
		const page = await signedInPage();

		// /gyms with no model and no label: refused, with the reason on the page.
		await page.goto(`${origin}/gyms?gym=${gym.id}&all=1`, { waitUntil: 'networkidle' });
		await page.getByLabel('Equipment type').selectOption('cable');
		await page.getByRole('button', { name: 'Add machine' }).click();
		await expect
			.poll(() => page.getByRole('status').textContent())
			.toBe('Give the machine a label, or choose its model so the label can be taken from it');
		expect(await labels()).toEqual([]);

		// /gyms with a model and no label: named after the model.
		await page.goto(`${origin}/gyms?gym=${gym.id}&q=IL-ROW`, { waitUntil: 'networkidle' });
		await page.getByLabel('Equipment type').selectOption('machine-plate');
		await page.getByLabel('Known model (optional)').selectOption(row.id);
		await page.getByRole('button', { name: 'Add machine' }).click();
		await expect.poll(() => page.getByRole('status').textContent()).toBe('Machine created');
		await expect
			.poll(() =>
				page.getByText('Hammer Strength Iso-Lateral Row (IL-ROW) · machine-plate').count()
			)
			.toBe(1);
		expect(await labels()).toEqual(['Hammer Strength Iso-Lateral Row (IL-ROW)']);

		// /equipment/[id] "add to a gym" with no label: the placeholder is what is stored.
		await page.goto(`${origin}/equipment/${row.id}`, { waitUntil: 'networkidle' });
		expect(await page.getByLabel('Local label (optional)').getAttribute('placeholder')).toBe(
			'Hammer Strength Iso-Lateral Row (IL-ROW)'
		);
		await page.getByLabel('Gym').selectOption(gym.id);
		await page.getByRole('button', { name: 'Add to gym' }).click();
		await expect.poll(() => page.getByRole('status').textContent()).toBe('Added to your gym');
		await expect
			.poll(() => page.getByText('Label Gym · Hammer Strength Iso-Lateral Row (IL-ROW)').count())
			.toBe(2); // the one added from /gyms above, and this one
		expect(await labels()).toEqual([
			'Hammer Strength Iso-Lateral Row (IL-ROW)',
			'Hammer Strength Iso-Lateral Row (IL-ROW)'
		]);
		expect(await violations(page)).toEqual([]);
		await page.close();
	});

	// 0.3.2: "Drop an edit option in." Edit a machine from the /gyms list.
	it('edit a machine from the /gyms list: new label shown, blank falls back to the model', async () => {
		const db = harness.db;
		const [gym] = await db.insert(s.gyms).values({ name: 'Edit Gym', userId }).returning();
		const [model] = await db
			.select()
			.from(s.equipmentModels)
			.where(
				and(
					eq(s.equipmentModels.manufacturer, 'Nautilus'),
					eq(s.equipmentModels.name, 'Leverage Row')
				)
			);
		const [machine] = await db
			.insert(s.gymEquipment)
			.values({
				gymId: gym.id,
				localLabel: 'Make this optional maybe? Next to deadlift platform',
				equipmentType: 'machine-plate',
				equipmentModelId: model.id
			})
			.returning();
		const reread = async () =>
			(await db.select().from(s.gymEquipment).where(eq(s.gymEquipment.id, machine.id)))[0];

		const page = await signedInPage();
		await page.goto(`${origin}/gyms?gym=${gym.id}`, { waitUntil: 'networkidle' });
		await page
			.getByRole('link', { name: 'Edit Make this optional maybe? Next to deadlift platform' })
			.click();
		await page.waitForURL(`**/gyms/${gym.id}/machines/${machine.id}/edit`);
		await page.getByLabel('Local label (optional)').fill('Next to deadlift platform');
		await page.getByLabel('Increment (lb, optional)').fill('5');
		await page.getByRole('button', { name: 'Save' }).click();
		await page.waitForURL(`**/gyms?gym=${gym.id}`);
		await expect
			.poll(() => page.getByText('Next to deadlift platform · machine-plate').count())
			.toBe(1);
		expect(await page.getByText('Make this optional maybe?').count()).toBe(0);
		expect(await reread()).toMatchObject({
			localLabel: 'Next to deadlift platform',
			incrementLb: 5
		});

		// Cleared label: the model's default label.
		await page.getByRole('link', { name: 'Edit Next to deadlift platform' }).click();
		await page.waitForURL('**/edit');
		await page.getByLabel('Local label (optional)').fill('');
		await page.getByRole('button', { name: 'Save' }).click();
		await page.waitForURL(`**/gyms?gym=${gym.id}`);
		await expect
			.poll(() => page.getByText('Nautilus Leverage Row · machine-plate').count())
			.toBe(1);
		expect((await reread()).localLabel).toBe('Nautilus Leverage Row');
		expect(await violations(page)).toEqual([]);
		await page.close();
	});

	// 0.3.2: the model's standard stack is shown and pre-filled into "add to a gym".
	it("the model page shows the standard stack and pre-fills it, and the user's value wins", async () => {
		const db = harness.db;
		const [gym] = await db.insert(s.gyms).values({ name: 'Stack Gym', userId }).returning();
		const [model] = await db
			.select()
			.from(s.equipmentModels)
			.where(
				and(
					eq(s.equipmentModels.manufacturer, 'Hammer Strength'),
					eq(s.equipmentModels.code, 'MTSBC')
				)
			);
		expect(model.standardStackLb).toBe(150);
		const page = await signedInPage();
		await page.goto(`${origin}/equipment/${model.id}`, { waitUntil: 'networkidle' });
		expect(await page.getByTestId('model-stack').textContent()).toContain('150 lb');
		const stack = page.getByLabel('Stack (lb, optional)');
		expect(await stack.inputValue()).toBe('150');
		await page.getByLabel('Gym').selectOption(gym.id);
		await page.getByLabel('Local label (optional)').fill('Curl as shipped');
		await page.getByRole('button', { name: 'Add to gym' }).click();
		await expect.poll(() => page.getByRole('status').textContent()).toBe('Added to your gym');
		// The page reloads after the POST: pick the gym again.
		await page.getByLabel('Gym').selectOption(gym.id);
		expect(await page.getByLabel('Stack (lb, optional)').inputValue()).toBe('150');
		await page.getByLabel('Local label (optional)').fill('Curl, heavy stack');
		await page.getByLabel('Stack (lb, optional)').fill('200');
		await page.getByRole('button', { name: 'Add to gym' }).click();
		await expect
			.poll(() => page.getByText('Stack Gym · Curl, heavy stack · 200 lb stack').count())
			.toBe(1);
		const made = await db.select().from(s.gymEquipment).where(eq(s.gymEquipment.gymId, gym.id));
		expect(Object.fromEntries(made.map((m) => [m.localLabel, m.stackLb]))).toEqual({
			'Curl as shipped': 150,
			'Curl, heavy stack': 200
		});
		expect(await violations(page)).toEqual([]);
		await page.close();
	});

	it('copy a catalog row into my own, then edit my copy, from the pages', async () => {
		const db = harness.db;
		const [global] = await db
			.select()
			.from(s.equipmentModels)
			.where(
				and(
					eq(s.equipmentModels.manufacturer, 'Hammer Strength'),
					eq(s.equipmentModels.code, 'IL-HBP')
				)
			);
		const page = await signedInPage();
		await page.goto(`${origin}/equipment/${global.id}`, { waitUntil: 'networkidle' });
		// 0.3.2: the catalog's notes are on the page, and travel with the copy.
		expect(global.notes).toBe('reseller spec');
		expect(await page.getByTestId('model-notes').textContent()).toBe('reseller spec');
		await page.getByRole('link', { name: 'Numbers wrong? Create your own copy' }).click();
		await page.waitForURL('**/edit');
		await page.getByLabel('Starting resistance (lb)').fill('15');
		await page.getByLabel('Basis').selectOption('total');
		await page.getByRole('button', { name: 'Create my own copy' }).click();
		await page.waitForURL(
			(url) => !url.pathname.endsWith('/edit') && !url.pathname.endsWith(global.id)
		);
		await expect.poll(() => page.getByText('15 lb total').count()).toBe(1);

		const copyId = page.url().split('/').pop()!;
		const [copy] = await db
			.select()
			.from(s.equipmentModels)
			.where(eq(s.equipmentModels.id, copyId));
		expect(copy).toMatchObject({
			ownerUserId: userId,
			confidence: 'user',
			startingResistance: 15,
			notes: 'reseller spec'
		});
		expect(await page.getByTestId('model-notes').textContent()).toBe('reseller spec');

		await page.getByRole('link', { name: 'Edit starting resistance and laterality' }).click();
		await page.waitForURL('**/edit');
		await page.getByLabel('Starting resistance (lb)').fill('16');
		await page.getByRole('button', { name: 'Save' }).click();
		await page.waitForURL(`**/equipment/${copyId}`);
		await expect.poll(() => page.getByText('16 lb total').count()).toBe(1);
		const [edited] = await db
			.select()
			.from(s.equipmentModels)
			.where(eq(s.equipmentModels.id, copyId));
		expect(edited.startingResistance).toBe(16);
		// The catalog row never moved.
		const [after] = await db
			.select()
			.from(s.equipmentModels)
			.where(eq(s.equipmentModels.id, global.id));
		expect(after).toEqual(global);
		expect(await violations(page)).toEqual([]);
		await page.close();
	});
	// 0.3.2: a model a snapshot no longer contains is retired: hidden from the
	// catalog and the picker, its page still renders with a note, and a machine
	// linked to it keeps working. Last in the file: it re-imports the full
	// catalog at the end, so nothing before it sees a retired row.
	it('a retired model is hidden from browse and picker, but its page and linked machine render', async () => {
		const db = harness.db;
		const csv = readFileSync('data/catalog/equipment_models_seed_2026-09-30.csv', 'utf8');
		const [model] = await db
			.select()
			.from(s.equipmentModels)
			.where(
				and(
					eq(s.equipmentModels.manufacturer, 'Hammer Strength'),
					eq(s.equipmentModels.code, 'IL-DY')
				)
			);
		const [gym] = await db.insert(s.gyms).values({ name: 'Retire Gym', userId }).returning();
		await db.insert(s.gymEquipment).values({
			gymId: gym.id,
			localLabel: 'DY row by the door',
			equipmentType: model.loadingType,
			equipmentModelId: model.id
		});
		const lines = csv.trimEnd().split(/\r?\n/);
		const without = lines.filter((l) => !l.includes(',IL-DY,')).join('\n');
		const run = await importCatalog(db, without, { dryRun: false });
		expect(run.retired.map((r) => r.id)).toEqual([model.id]);

		const page = await signedInPage();
		await page.goto(`${origin}/equipment?q=IL-DY`, { waitUntil: 'networkidle' });
		await expect.poll(() => page.getByRole('status').textContent()).toContain('0 models');
		await page.goto(`${origin}/gyms?gym=${gym.id}&all=1`, { waitUntil: 'networkidle' });
		expect(
			await page.getByLabel('Known model (optional)').locator(`option[value="${model.id}"]`).count()
		).toBe(0);
		// The linked machine is still listed, with its model link.
		await expect.poll(() => page.getByText('DY row by the door · machine-plate').count()).toBe(1);
		const response = await page.goto(`${origin}/equipment/${model.id}`, {
			waitUntil: 'networkidle'
		});
		expect(response?.status()).toBe(200);
		expect(await page.getByTestId('model-retired').textContent()).toContain(
			'No longer in the catalog'
		);
		expect(await page.getByText('Retire Gym · DY row by the door').count()).toBe(1);
		expect(await page.getByRole('button', { name: 'Add to gym' }).count()).toBe(0);
		expect(await violations(page)).toEqual([]);
		await page.close();

		// The full snapshot brings it back.
		const back = await importCatalog(db, csv, { dryRun: false });
		expect(back.failed).toBe(false);
		const [restored] = await db
			.select()
			.from(s.equipmentModels)
			.where(eq(s.equipmentModels.id, model.id));
		expect(restored.retiredAt).toBeNull();
	});
});
