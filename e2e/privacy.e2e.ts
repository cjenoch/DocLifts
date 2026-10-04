import { afterAll, beforeAll, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { eq } from 'drizzle-orm';
import { browserSuite, authenticatedPage, violations } from './browser';
import {
	freshTestDb,
	seedTestUser,
	signInAs,
	startTestServer
} from '$lib/server/test-auth-helpers';
import * as s from '$lib/server/db/schema';
import { PHOTO_NOTICE_VERSION } from '$lib/photo-privacy';
import { smallPng } from '$lib/server/photos/test-fixtures';
import { postPhoto } from './photo-upload';
import { workoutUi } from '$lib/workout-ui';

const { run, executablePath } = browserSuite();
run('photo privacy at first use (production build)', () => {
	let harness: Awaited<ReturnType<typeof freshTestDb>>;
	let stop = async () => {};
	let browser: Browser;
	let origin: string;
	let alice: string;
	let bob: string;
	let gym: string;
	let cookieA: string;
	let cookieB: string;
	beforeAll(async () => {
		harness = await freshTestDb();
		alice = (await seedTestUser(harness.db, 'privacy-a@test.local', 'Privacy A', false)).id;
		bob = (await seedTestUser(harness.db, 'privacy-b@test.local', 'Privacy B', false)).id;
		[{ id: gym }] = await harness.db
			.insert(s.gyms)
			.values({ userId: alice, name: 'Privacy Gym' })
			.returning();
		const server = await startTestServer();
		origin = server.origin;
		stop = server.stop;
		cookieA = await signInAs(origin, { email: 'privacy-a@test.local' });
		cookieB = await signInAs(origin, { email: 'privacy-b@test.local' });
		browser = await chromium.launch({ executablePath });
	});
	afterAll(async () => {
		await browser?.close();
		await stop();
		await harness?.end();
	});
	const acknowledgments = () => harness.db.select().from(s.photoNoticeAcknowledgements);
	const post = (path: string, fields: Record<string, string>, cookie = cookieA) =>
		fetch(origin + path, {
			method: 'POST',
			headers: { cookie, origin, accept: 'text/html' },
			body: new URLSearchParams(fields),
			redirect: 'manual'
		});

	it('notice is public; photo acknowledgment is explicit, versioned, account-bound and survives another device', async () => {
		const anon = await browser.newPage({ viewport: { width: 390, height: 844 } });
		await anon.goto(origin + '/login');
		await anon.getByRole('link', { name: 'Privacy and your data' }).click();
		await anon.waitForURL('**/privacy');
		expect(
			await anon.getByRole('heading', { name: 'Privacy and your data', exact: true }).count()
		).toBe(1);
		expect(await anon.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
			true
		);
		await anon.close();
		const page = await authenticatedPage(browser, cookieA, {
			viewport: { width: 390, height: 844 }
		});
		const path = '/gyms/' + gym + '/equipment/photo';
		await page.goto(origin + path, { waitUntil: 'networkidle' });
		expect(await page.locator('input[type=file]').count()).toBe(0);
		expect(await page.getByRole('checkbox').isChecked()).toBe(false);
		await page.getByRole('button', { name: 'Continue to photos' }).click();
		expect(await acknowledgments()).toEqual([]);
		for (const fields of [
			{ photoNoticeVersion: PHOTO_NOTICE_VERSION },
			{ photoNoticeVersion: 'old', acknowledge: 'yes' }
		]) {
			expect((await post(path + '?/acknowledgePhotoNotice', fields)).status).toBe(400);
		}
		const refused = await postPhoto(origin, cookieA, gym, await smallPng(), {
			fields: { photoNoticeVersion: PHOTO_NOTICE_VERSION, acknowledge: 'yes' }
		});
		expect(refused.status).toBe(400);
		expect(await refused.text()).toContain('Please read and acknowledge');
		expect(await harness.db.select().from(s.equipmentPhotos)).toEqual([]);
		expect(await harness.db.select().from(s.llmCalls)).toEqual([]);
		await page.locator('form[action="?/acknowledgePhotoNotice"]').evaluate((form, id) => {
			const field = document.createElement('input');
			field.type = 'hidden';
			field.name = 'userId';
			field.value = id;
			form.append(field);
		}, bob);
		await page.getByRole('checkbox').check();
		await page.route('**/*?/acknowledgePhotoNotice', (route) =>
			route.abort('internetdisconnected')
		);
		await page.getByRole('button', { name: 'Continue to photos' }).click();
		await expect.poll(() => page.getByRole('alert').innerText()).toContain('Please try again');
		expect(await page.getByRole('checkbox').isChecked()).toBe(true);
		await page.unroute('**/*?/acknowledgePhotoNotice');
		await page.getByRole('button', { name: 'Continue to photos' }).click();
		await expect.poll(() => page.locator('input[type=file]').count()).toBe(1);
		expect(await acknowledgments()).toMatchObject([
			{ userId: alice, version: PHOTO_NOTICE_VERSION }
		]);
		const otherDevice = await authenticatedPage(browser, cookieA);
		await otherDevice.goto(origin + path);
		expect(await otherDevice.locator('input[type=file]').count()).toBe(1);
		expect(await violations(page)).toEqual([]);
		await otherDevice.close();
		await page.close();
	});

	it('manual workout starts without acknowledgment; workout photo gate and no-JavaScript acknowledgment both work', async () => {
		const page = await authenticatedPage(browser, cookieB, {
			javaScriptEnabled: false,
			viewport: { width: 390, height: 844 }
		});
		await page.goto(origin + '/workout/start');
		await page.getByLabel(workoutUi.gymStepNewName).fill('B private gym');
		await page.getByRole('button', { name: workoutUi.gymStepSubmit, exact: true }).click();
		await page.waitForURL('**/sessions/*');
		const path = new URL(page.url()).pathname;
		expect(
			await harness.db.select().from(s.sessions).where(eq(s.sessions.userId, bob))
		).toHaveLength(1);
		expect(await page.locator('input[type=file]').count()).toBe(0);
		const form = new FormData();
		form.append('photo', new Blob([await smallPng()], { type: 'image/png' }), 'machine.png');
		const rejected = await fetch(origin + path + '?/photo', {
			method: 'POST',
			headers: { cookie: cookieB, origin, accept: 'text/html' },
			body: form,
			redirect: 'manual'
		});
		expect(rejected.status).toBe(400);
		expect(await rejected.text()).toContain('Please read and acknowledge');
		expect(await harness.db.select().from(s.equipmentPhotos)).toEqual([]);
		expect(await harness.db.select().from(s.llmCalls)).toEqual([]);
		await page.locator('summary#photo-next-input').click();
		await page.getByRole('checkbox').check();
		await page.getByRole('button', { name: 'Continue to photos' }).click();
		await page.waitForURL(origin + path);
		expect(await page.locator('input[type=file]').count()).toBe(1);
		expect((await acknowledgments()).find((row) => row.userId === bob)?.version).toBe(
			PHOTO_NOTICE_VERSION
		);
		await page.close();
	});
});
