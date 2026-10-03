/**
 * 0.4.0 equipment from a photo, against the PRODUCTION build (CLAUDE.md:
 * "every action has an e2e that reaches it from a page"; "assert the state
 * change, not the response shape").
 *
 * The served build runs with PHOTO_STORE=memory, BODY_SIZE_LIMIT=12M and no
 * LLM key (startTestServer), so nothing here reaches S3 or a model. Analysis
 * therefore fails as "not configured" on the wire — which is itself asserted —
 * and the review-and-confirm steps are driven by writing the candidate a
 * successful analysis would have written (the analysis with a mock model is
 * proven in src/lib/server/photos/analyze.db.test.ts). Fixture photos are
 * generated; accounts are the harness's scratch accounts.
 *
 * Prerequisites and skip rules are the same as csp.e2e.ts.
 */
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { and, eq } from 'drizzle-orm';
import { setupTestDb } from '$lib/server/test-db';
import {
	BUILD_ENTRY,
	freshTestDb,
	seedTestUser,
	signInAs,
	startTestServer
} from '$lib/server/test-auth-helpers';
import * as s from '$lib/server/db/schema';
import sharp from 'sharp';
import { photoClientSettings } from '$lib/photo-client';
import { FIXTURE_CANDIDATE, phonePhoto, smallPng } from '$lib/server/photos/test-fixtures';
import { postPhoto, reviewedPhotoId } from './photo-upload';

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
		__buttonLabels: string[];
	}
}

const A_EMAIL = 'photo-scratch-a@test.local';
const B_EMAIL = 'photo-scratch-b@test.local';

run('equipment from a photo (production build)', () => {
	let harness: Awaited<ReturnType<typeof setupTestDb>>;
	let stopServer = async () => {};
	let serverLog: () => string = () => '';
	let origin: string;
	let cookieA: string;
	let cookieB: string;
	let browser: Browser;
	let userA: string;
	let gymA: string;
	let gymB: string;
	let catalogRow: typeof s.equipmentModels.$inferSelect;
	let phone: Buffer;

	beforeAll(async () => {
		harness = await freshTestDb();
		const db = harness.db;
		userA = (await seedTestUser(db, A_EMAIL, 'Photo Scratch A')).id;
		const userB = (await seedTestUser(db, B_EMAIL, 'Photo Scratch B')).id;
		[{ id: gymA }] = await db
			.insert(s.gyms)
			.values({ name: 'Photo Gym', userId: userA })
			.returning();
		[{ id: gymB }] = await db.insert(s.gyms).values({ name: 'B Gym', userId: userB }).returning();
		[catalogRow] = await db
			.insert(s.equipmentModels)
			.values({
				manufacturer: 'Hammer Strength',
				productLine: 'Plate Loaded',
				code: 'IL-ROW',
				name: 'Iso-Lateral Row',
				loadingType: 'machine-plate',
				laterality: 'independent',
				confidence: 'manufacturer_page',
				catalogSnapshot: '2026-09-30'
			})
			.returning();
		phone = await phonePhoto();
		const started = await startTestServer();
		origin = started.origin;
		stopServer = started.stop;
		serverLog = started.log;
		cookieA = await signInAs(origin, { email: A_EMAIL });
		cookieB = await signInAs(origin, { email: B_EMAIL });
		browser = await chromium.launch({ executablePath });
	});

	afterAll(async () => {
		await browser?.close();
		await stopServer();
		await harness?.end();
	});

	async function signedInPage(cookie = cookieA, { javaScriptEnabled = true } = {}): Promise<Page> {
		const page = await (await browser.newContext({ javaScriptEnabled })).newPage();
		const at = cookie.indexOf('=');
		await page.context().addCookies([
			{
				name: cookie.slice(0, at),
				value: decodeURIComponent(cookie.slice(at + 1)),
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
	/** The image really loaded through the proxy: decoded, with the stored size. */
	const imageSize = (page: Page, selector: string) =>
		page
			.locator(selector)
			.first()
			.evaluate((img: HTMLImageElement) => ({
				complete: img.complete,
				width: img.naturalWidth,
				height: img.naturalHeight
			}));

	const photoRow = async (id: string) =>
		(await harness.db.select().from(s.equipmentPhotos).where(eq(s.equipmentPhotos.id, id)))[0];
	const photosOf = (userId: string) =>
		harness.db.select().from(s.equipmentPhotos).where(eq(s.equipmentPhotos.userId, userId));
	/** What a successful analysis writes (analyze.db.test.ts proves that path with a mock model). */
	const analyzed = (id: string, candidate = FIXTURE_CANDIDATE) =>
		harness.db
			.update(s.equipmentPhotos)
			.set({ status: 'analyzed', candidate })
			.where(eq(s.equipmentPhotos.id, id));

	/** The server's `photo_upload` log line(s) for one photo id, or for a refusal. */
	const uploadLines = () =>
		serverLog()
			.split('\n')
			.filter((l) => l.startsWith('{"event":"photo_upload"'))
			.map((l) => JSON.parse(l) as Record<string, unknown>);
	const uploadLine = async (photoId: string) => {
		await expect.poll(() => uploadLines().filter((l) => l.photoId === photoId)).toHaveLength(1);
		return uploadLines().find((l) => l.photoId === photoId)!;
	};
	/** Mean red and blue of the top and bottom quarter of a stored image. */
	async function bands(jpeg: Buffer) {
		const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
		const mean = (fromRow: number, toRow: number) => {
			let r = 0;
			let b = 0;
			let n = 0;
			for (let y = fromRow; y < toRow; y++) {
				for (let x = 0; x < info.width; x++) {
					const i = (y * info.width + x) * info.channels;
					r += data[i];
					b += data[i + 2];
					n++;
				}
			}
			return { r: r / n, b: b / n };
		};
		const q = Math.floor(info.height / 4);
		return { top: mean(0, q), bottom: mean(info.height - q, info.height) };
	}

	async function uploadFromPage(page: Page, bytes: Buffer, note = ''): Promise<string> {
		await page.goto(`${origin}/gyms`, { waitUntil: 'networkidle' });
		await page.getByRole('link', { name: 'Add a machine from a photo' }).first().click();
		await page.waitForURL(`**/gyms/${gymA}/equipment/photo`);
		await page
			.getByLabel('Photo')
			.setInputFiles({ name: 'IMG_0420.JPG', mimeType: 'image/jpeg', buffer: bytes });
		if (note) await page.getByLabel('Note (optional)').fill(note);
		await page.getByRole('button', { name: 'Upload photo' }).click();
		await page.waitForURL('**/photos/*/review**');
		return new URL(page.url()).pathname.split('/')[2];
	}

	it('the photo field lets the phone offer the library and files, not only the camera', async () => {
		// `capture` makes Android open the camera with no choice at all (found by
		// the owner on 2026-10-01: a placard photo already in the roll could not
		// be picked). Without it, iOS and Android both show their own sheet:
		// take a photo, photo library, or files.
		const page = await signedInPage();
		await page.goto(`${origin}/gyms/${gymA}/equipment/photo`, { waitUntil: 'networkidle' });
		const input = page.getByLabel('Photo');
		expect(await input.getAttribute('type')).toBe('file');
		expect(await input.getAttribute('capture')).toBeNull();
		expect(await input.getAttribute('accept')).toBe('image/jpeg,image/png,image/webp');
		await page.close();
	});

	it('on a phone-width screen every nav control is fully on screen', async () => {
		// The owner's iPhone, 2026-10-01: "Gyms" cut off at the left and
		// "Sign out" at the right, because the nav was one row that never
		// wrapped. Since 0.5.5 the nav is the bottom tab bar plus the account
		// button at the top. 390 px is an iPhone 12-15 viewport.
		const page = await signedInPage();
		await page.setViewportSize({ width: 390, height: 844 });
		for (const path of ['/', '/gyms', `/gyms/${gymA}/equipment/photo`]) {
			await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
			const nav = page.getByRole('navigation', { name: 'Main navigation' });
			const controls = [
				...(await nav.getByRole('link').all()),
				page.getByRole('link', { name: 'Account', exact: true })
			];
			expect(controls.length, path).toBe(5);
			for (const control of controls) {
				const box = await control.boundingBox();
				const name = await control.innerText();
				expect(box, `${path}: ${name}`).not.toBeNull();
				expect(box!.x, `${path}: ${name} starts on screen`).toBeGreaterThanOrEqual(0);
				expect(box!.x + box!.width, `${path}: ${name} ends on screen`).toBeLessThanOrEqual(390);
				// One line each, and a thumb-sized target.
				expect(box!.height, `${path}: ${name} tap target`).toBeGreaterThanOrEqual(44);
				expect(box!.height, `${path}: ${name} on one line`).toBeLessThan(64);
			}
		}
		await page.close();
	});

	it('upload from the page (a 2.5 MB phone photo) -> review shows the image; analysis not configured is recorded', async () => {
		expect(phone.byteLength).toBeGreaterThan(512 * 1024);
		const page = await signedInPage();
		const id = await uploadFromPage(page, phone, 'code on the seat post');

		const row = await photoRow(id);
		expect(row).toMatchObject({ userId: userA, gymId: gymA, status: 'uploaded', width: 1200 });
		expect(await imageSize(page, 'img[alt="The placard you uploaded"]')).toEqual({
			complete: true,
			width: 1200,
			height: 1600
		});
		await expect
			.poll(() => page.getByRole('alert').textContent())
			.toContain('Analysis failed, try again');
		const calls = () =>
			harness.db
				.select()
				.from(s.llmCalls)
				.where(and(eq(s.llmCalls.userId, userA), eq(s.llmCalls.purpose, 'equipment_from_photo')));
		expect(await calls()).toMatchObject([{ status: 'refused', errorCode: 'not_configured' }]);

		// Re-analyze, from the page: another recorded attempt, still `uploaded`.
		await page.getByRole('button', { name: 'Re-analyze' }).click();
		await page.waitForURL('**/review?analysis=failed');
		expect(await calls()).toHaveLength(2);
		expect((await photoRow(id)).status).toBe('uploaded');
		expect(await violations(page)).toEqual([]);
		await page.close();
	});

	it('a dropped connection keeps the page and the chosen photo, says so, and the retry goes through', async () => {
		// Gym Wi-Fi: the POST never reaches the server. Before, the enhanced
		// submit swapped in the error page and the chosen photo was lost.
		const page = await signedInPage();
		await page.goto(`${origin}/gyms/${gymA}/equipment/photo`, { waitUntil: 'networkidle' });
		const before = (await photosOf(userA)).length;
		const input = page.getByLabel('Photo');
		await input.setInputFiles({ name: 'IMG_0421.JPG', mimeType: 'image/jpeg', buffer: phone });

		await page.route('**/equipment/photo?/upload', (route) => route.abort('internetdisconnected'));
		await page.getByRole('button', { name: 'Upload photo' }).click();
		await expect
			.poll(() => page.getByRole('alert').textContent())
			.toBe(photoClientSettings.labels.failed);
		expect(new URL(page.url()).pathname).toBe(`/gyms/${gymA}/equipment/photo`);
		expect(await input.evaluate((el: HTMLInputElement) => el.files?.[0]?.name)).toBe(
			'IMG_0421.JPG'
		);
		expect(await page.getByRole('button', { name: 'Upload photo' }).isEnabled()).toBe(true);
		expect(await photosOf(userA)).toHaveLength(before); // nothing stored

		// Back on the network: the same selection, one tap, reaches review.
		await page.unroute('**/equipment/photo?/upload');
		await page.getByRole('button', { name: 'Upload photo' }).click();
		await page.waitForURL('**/photos/*/review**');
		// Review has alerts of its own (the harness has no model); ours is gone.
		expect(await page.getByText(photoClientSettings.labels.failed).count()).toBe(0);
		expect(await photosOf(userA)).toHaveLength(before + 1);
		await page.close();
	});

	it('resized on the phone: a 4000x3000 photo arrives smaller and upright, measured in the log, and reaches review', async () => {
		// 0.5.0 Part A, from the rendered page in Chromium: the enhanced submit
		// swaps the photo for the browser's resize before the POST.
		expect(phone.byteLength).toBeGreaterThan(2 * 1024 * 1024);
		const page = await signedInPage();
		await page.goto(`${origin}/gyms/${gymA}/equipment/photo`, { waitUntil: 'networkidle' });
		await page
			.getByLabel('Photo')
			.setInputFiles({ name: 'IMG_0420.JPG', mimeType: 'image/jpeg', buffer: phone });
		// Every label the button shows on the way. The enhanced submit moves to
		// review without a page load, so the record survives the navigation.
		await page.getByRole('button', { name: 'Upload photo' }).evaluate((button) => {
			window.__buttonLabels = [];
			new MutationObserver(() => window.__buttonLabels.push(button.textContent ?? '')).observe(
				button,
				{ childList: true, characterData: true, subtree: true }
			);
		});
		await page.getByRole('button', { name: 'Upload photo' }).click();
		await page.waitForURL('**/photos/*/review**');
		const id = new URL(page.url()).pathname.split('/')[2];
		const { preparing, uploading } = photoClientSettings.labels;
		const shown = await page.evaluate(() => window.__buttonLabels);
		expect(shown.slice(0, 2)).toEqual([preparing, uploading]);

		const line = await uploadLine(id);
		expect(line).toMatchObject({
			outcome: 'stored',
			clientOriginalBytes: phone.byteLength,
			clientResized: true
		});
		// 0.5.3: the stage timings, in whole ms, on the served build's line.
		// (No model is configured here; modelMs is the refused call's time.)
		for (const k of ['processWaitMs', 'processMs', 'storePutMs', 'modelMs', 'totalMs']) {
			expect(Number.isInteger(line[k]) && (line[k] as number) >= 0, `${k}=${line[k]}`).toBe(true);
		}
		const received = line.receivedBytes as number;
		// What crossed the wire: well under half the original, and under the
		// spec's 1.5 MB for a 4 MB phone photo.
		expect(received).toBeLessThan(phone.byteLength / 2);
		expect(received).toBeLessThan(1.5 * 1024 * 1024);

		// The server still did its whole job on what arrived: 1600 px, upright
		// (the fixture is stored sideways with EXIF orientation 6, red on the
		// left as stored, so upright means red on TOP).
		const row = await photoRow(id);
		expect(row).toMatchObject({ status: 'uploaded', width: 1200, height: 1600 });
		expect(line.storedBytes).toBe(row.bytes);
		const image = await fetch(`${origin}/photos/${id}/image`, { headers: { cookie: cookieA } });
		const { top, bottom } = await bands(Buffer.from(await image.arrayBuffer()));
		expect(top.r).toBeGreaterThan(150);
		expect(top.b).toBeLessThan(80);
		expect(bottom.b).toBeGreaterThan(150);
		expect(bottom.r).toBeLessThan(80);
		expect(await violations(page)).toEqual([]);
		await page.close();
	});

	it('with JavaScript off, the form posts the original photo, as before 0.5.0', async () => {
		const page = await signedInPage(cookieA, { javaScriptEnabled: false });
		const id = await uploadFromPage(page, phone);
		expect(await uploadLine(id)).toMatchObject({
			outcome: 'stored',
			receivedBytes: phone.byteLength,
			clientOriginalBytes: null,
			clientResized: null
		});
		expect(await photoRow(id)).toMatchObject({ status: 'uploaded', width: 1200, height: 1600 });
		await page.close();
	});

	it('the client measurement fields are never trusted: nonsense is logged as null and changes nothing', async () => {
		const res = await postPhoto(origin, cookieB, gymB, await smallPng(), {
			fields: { clientOriginalBytes: '99999999999999', clientResized: 'yes' }
		});
		const id = reviewedPhotoId(res);
		expect(await uploadLine(id)).toMatchObject({
			outcome: 'stored',
			clientOriginalBytes: null,
			clientResized: null
		});
		expect((await photoRow(id)).status).toBe('uploaded');
	});

	it('link from the page: the gym_equipment row exists with the photo attached, and thumbnails show', async () => {
		const page = await signedInPage();
		const id = await uploadFromPage(page, await smallPng());
		await analyzed(id);
		await page.reload({ waitUntil: 'networkidle' });
		expect(await page.getByTestId('candidate').textContent()).toContain('IL-ROW');
		expect(await page.getByTestId('match-method').textContent()).toContain('Exact match');
		// Preselected, and the low-confidence field (loading type, 0.5) is marked.
		expect(await page.getByRole('radio').first().isChecked()).toBe(true);
		const marked = page.locator('[data-testid="candidate"] [data-low]');
		expect(await marked.evaluateAll((els) => els.map((e) => e.getAttribute('data-low')))).toEqual([
			'loading_type'
		]);

		await page.getByRole('button', { name: 'Link to Photo Gym' }).click();
		await expect
			.poll(() => page.getByTestId('photo-status').textContent())
			.toContain('Added to Photo Gym');
		// As rendered, not as in source: the owner saw "Friendswoodas" (0.4.5).
		expect((await page.getByTestId('photo-status').innerText()).replace(/\s+/g, ' ')).toMatch(
			/^Added to Photo Gym as \S/
		);

		const row = await photoRow(id);
		expect(row).toMatchObject({ status: 'confirmed', matchedModelId: catalogRow.id });
		const [machine] = await harness.db
			.select()
			.from(s.gymEquipment)
			.where(eq(s.gymEquipment.id, row.gymEquipmentId!));
		expect(machine).toMatchObject({
			gymId: gymA,
			equipmentModelId: catalogRow.id,
			localLabel: 'Hammer Strength Iso-Lateral Row (IL-ROW)'
		});

		// The machine list and the model page show the photo, through the proxy.
		await page.goto(`${origin}/gyms`, { waitUntil: 'networkidle' });
		expect(await imageSize(page, `img[src="/photos/${id}/image"]`)).toMatchObject({
			complete: true,
			width: 300
		});
		await page.goto(`${origin}/equipment/${catalogRow.id}`, { waitUntil: 'networkidle' });
		expect(await imageSize(page, `img[src="/photos/${id}/image"]`)).toMatchObject({
			complete: true,
			width: 300
		});
		expect(await violations(page)).toEqual([]);
		await page.close();
	});

	it('create my own from the page: an owned model with confidence user, and the machine', async () => {
		const page = await signedInPage();
		const id = await uploadFromPage(page, await smallPng());
		await analyzed(id, {
			...FIXTURE_CANDIDATE,
			manufacturer: 'Garage Iron',
			model_code: 'GI-HT1',
			name: 'Hip Thrust Station',
			notes: 'Placard faded at the bottom.'
		});
		await page.reload({ waitUntil: 'networkidle' });
		expect(await page.getByTestId('match-method').textContent()).toContain('No match');
		await page.getByRole('button', { name: 'Create my own model' }).click();
		await expect
			.poll(() => page.getByTestId('photo-status').textContent())
			.toContain('Garage Iron Hip Thrust Station (GI-HT1)');

		const row = await photoRow(id);
		expect(row.status).toBe('confirmed');
		const [model] = await harness.db
			.select()
			.from(s.equipmentModels)
			.where(eq(s.equipmentModels.id, row.createdModelId!));
		expect(model).toMatchObject({
			ownerUserId: userA,
			confidence: 'user',
			sourceUrl: null,
			code: 'GI-HT1',
			loadingType: 'machine-plate',
			notes: 'Placard faded at the bottom.'
		});
		const [machine] = await harness.db
			.select()
			.from(s.gymEquipment)
			.where(eq(s.gymEquipment.id, row.gymEquipmentId!));
		expect(machine).toMatchObject({ gymId: gymA, equipmentModelId: model.id });
		expect(await violations(page)).toEqual([]);
		await page.close();
	});

	it('discard from the page: the stored image is gone (the proxy 404s) and the row is discarded', async () => {
		const page = await signedInPage();
		const id = await uploadFromPage(page, await smallPng());
		const image = () =>
			fetch(`${origin}/photos/${id}/image`, { headers: { cookie: cookieA }, redirect: 'manual' });
		expect((await image()).status).toBe(200); // positive first
		await page.getByRole('button', { name: 'Discard this photo' }).click();
		await expect.poll(() => page.getByTestId('photo-status').textContent()).toContain('Discarded');
		expect((await photoRow(id)).status).toBe('discarded');
		expect((await image()).status).toBe(404);
		await page.close();
	});

	it('the daily cap refuses the 21st upload of the day, on the page, and stores nothing', async () => {
		const have = (await photosOf(userA)).length;
		for (let i = have; i < 20; i++) {
			await harness.db.insert(s.equipmentPhotos).values({
				userId: userA,
				gymId: gymA,
				storageKey: `seed/${crypto.randomUUID()}`,
				contentType: 'image/jpeg',
				bytes: 1,
				width: 1,
				height: 1,
				sha256: '0'.repeat(64),
				status: 'discarded'
			});
		}
		expect(await photosOf(userA)).toHaveLength(20);
		const page = await signedInPage();
		await page.goto(`${origin}/gyms/${gymA}/equipment/photo`, { waitUntil: 'networkidle' });
		await page
			.getByLabel('Photo')
			.setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: await smallPng() });
		await page.getByRole('button', { name: 'Upload photo' }).click();
		await expect
			.poll(() => page.getByRole('status').textContent())
			.toBe('You have uploaded 20 photos in the last 24 hours, the daily limit. Try again later.');
		expect(await photosOf(userA)).toHaveLength(20);
		await page.close();
		// Another user's count is their own.
		const res = await postPhoto(origin, cookieB, gymB, await smallPng());
		expect(reviewedPhotoId(res)).toMatch(/^[0-9a-f-]{36}$/);
	});

	it('cross-tenant on the wire: B gets 404 for A’s image, review and link, and no row is written', async () => {
		const [aPhoto] = (await photosOf(userA)).filter((p) => p.status === 'uploaded');
		await analyzed(aPhoto.id);
		const asA = await fetch(`${origin}/photos/${aPhoto.id}/image`, {
			headers: { cookie: cookieA }
		});
		expect(asA.status).toBe(200); // positive first
		expect(asA.headers.get('cache-control')).toMatch(/private, no-store/);
		expect(asA.headers.get('content-type')).toBe('image/jpeg');

		const asB = await fetch(`${origin}/photos/${aPhoto.id}/image`, {
			headers: { cookie: cookieB }
		});
		expect(asB.status).toBe(404);
		const reviewAsB = await fetch(`${origin}/photos/${aPhoto.id}/review`, {
			headers: { cookie: cookieB }
		});
		expect(reviewAsB.status).toBe(404);
		const uploadAsB = await postPhoto(origin, cookieB, gymA, await smallPng());
		expect(uploadAsB.status).toBe(404);

		const machinesBefore = (await harness.db.select().from(s.gymEquipment)).length;
		const link = await fetch(`${origin}/photos/${aPhoto.id}/review?/link`, {
			method: 'POST',
			headers: {
				cookie: cookieB,
				origin,
				accept: 'text/html',
				'content-type': 'application/x-www-form-urlencoded'
			},
			body: new URLSearchParams({ modelId: catalogRow.id }).toString(),
			redirect: 'manual'
		});
		expect(link.status).toBe(404);
		expect((await harness.db.select().from(s.gymEquipment)).length).toBe(machinesBefore);
		expect((await photoRow(aPhoto.id)).status).toBe('analyzed');

		// And anonymous: the guard sends the image route to /login like any page.
		const anon = await fetch(`${origin}/photos/${aPhoto.id}/image`, { redirect: 'manual' });
		expect(anon.status).toBe(303);
		expect(anon.headers.get('location')).toMatch(/^\/login/);
	});

	it('an upload over 512 KB is accepted with BODY_SIZE_LIMIT=12M, and refused without it', async () => {
		// Accepted: the 2.5 MB phone photo through the harness's server.
		const ok = await postPhoto(origin, cookieB, gymB, phone);
		expect(reviewedPhotoId(ok)).toMatch(/^[0-9a-f-]{36}$/);
		// Over PHOTO_MAX_BYTES but under the body limit: the app's own message, not a 413.
		const tooBig = await postPhoto(origin, cookieB, gymB, Buffer.alloc(11 * 1024 * 1024, 1));
		expect(tooBig.status).toBe(400);
		expect(await tooBig.text()).toContain('the limit is 10 MB');

		// The same upload against a build left on adapter-node's 512K default.
		const narrow = await startTestServer({ BODY_SIZE_LIMIT: '512K' });
		try {
			const cookie = await signInAs(narrow.origin, { email: B_EMAIL });
			const refused = await postPhoto(narrow.origin, cookie, gymB, phone);
			// adapter-node 5 refuses by content-length while building the
			// request, before the app runs; SvelteKit surfaces it as a 500 (not
			// the 413 the spec expected), with this line in the server log.
			expect(refused.status).toBe(500);
			await expect
				.poll(() => narrow.log())
				.toMatch(/Content-length of \d+ exceeds limit of 524288 bytes/);
		} finally {
			await narrow.stop();
		}
	});
});
