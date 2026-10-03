/** Harmless pixels + a fake scanner HTTP service. No harmful content or provider calls. */
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { eq, and } from 'drizzle-orm';
import {
	BUILD_ENTRY,
	freshTestDb,
	seedTestUser,
	signInAs,
	startTestServer
} from '$lib/server/test-auth-helpers';
import * as s from '$lib/server/db/schema';
import { LOCAL_MODEL } from '$lib/server/llm/safety';
import { smallPng } from '$lib/server/photos/test-fixtures';
import { workoutUi } from '$lib/workout-ui';
const executablePath = process.env.PW_EXECUTABLE_PATH || chromium.executablePath();
if ((!existsSync(BUILD_ENTRY) || !existsSync(executablePath)) && process.env.CI)
	throw new Error('Build and Chromium required');
const run = existsSync(BUILD_ENTRY) && existsSync(executablePath) ? describe : describe.skip;
run('photo safety through phone upload controls', () => {
	let harness: Awaited<ReturnType<typeof freshTestDb>>;
	let stop = async () => {};
	let browser: Browser;
	let service: Server;
	let origin: string;
	let cookie: string;
	let owner: string;
	let gym: string;
	let verdict: 'allow' | 'block' | 'error' | 'malformed' | 'timeout' = 'allow';
	let png: Buffer;
	beforeAll(async () => {
		harness = await freshTestDb();
		owner = (await seedTestUser(harness.db)).id;
		[{ id: gym }] = await harness.db
			.insert(s.gyms)
			.values({ name: 'Safety Gym', userId: owner })
			.returning();
		service = createServer(async (req, res) => {
			for await (const _chunk of req) {
				/* discard generated fixture bytes */
			}
			if (verdict === 'timeout') return;
			res.setHeader('content-type', 'application/json');
			if (verdict === 'error') {
				res.writeHead(503).end('{}');
				return;
			}
			res.end(
				verdict === 'malformed'
					? '{}'
					: JSON.stringify({ model: LOCAL_MODEL, nsfw: verdict === 'block' ? 0.9 : 0.01 })
			);
		});
		await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', resolve));
		const port = (service.address() as { port: number }).port;
		const app = await startTestServer({
			PHOTO_SAFETY_MODE: 'local',
			PHOTO_SAFETY_LOCAL_URL: `http://127.0.0.1:${port}/scan`,
			PHOTO_SAFETY_TIMEOUT_MS: '200'
		});
		stop = app.stop;
		origin = app.origin;
		cookie = await signInAs(origin);
		browser = await chromium.launch({ executablePath });
		png = await smallPng();
	});
	afterAll(async () => {
		await browser?.close();
		await stop();
		if (service) {
			service.closeAllConnections();
			await new Promise<void>((resolve) => service.close(() => resolve()));
		}
		await harness?.end();
	});
	async function pageForUser(): Promise<Page> {
		const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
		const at = cookie.indexOf('=');
		await page.context().addCookies([
			{
				name: cookie.slice(0, at),
				value: decodeURIComponent(cookie.slice(at + 1)),
				domain: '127.0.0.1',
				path: '/'
			}
		]);
		return page;
	}
	const photoRows = () =>
		harness.db.select().from(s.equipmentPhotos).where(eq(s.equipmentPhotos.userId, owner));
	const modelCalls = () =>
		harness.db
			.select()
			.from(s.llmCalls)
			.where(and(eq(s.llmCalls.userId, owner), eq(s.llmCalls.purpose, 'equipment_from_photo')));
	const fixture = { name: 'safe-generated.png', mimeType: 'image/png', buffer: Buffer.alloc(0) };
	it('gym upload stores an allowed image, but refuses unsafe/error/malformed/timeout before storage or vision', async () => {
		const page = await pageForUser();
		await page.goto(`${origin}/gyms/${gym}/equipment/photo`);
		await page.getByLabel('Photo', { exact: true }).setInputFiles({ ...fixture, buffer: png });
		await page.getByRole('button', { name: 'Upload photo', exact: true }).click();
		await page.waitForURL('**/photos/*/review**');
		expect(await photoRows()).toHaveLength(1);
		const reads = (await modelCalls()).length;
		for (const failed of ['block', 'error', 'malformed', 'timeout'] as const) {
			verdict = failed;
			await page.goto(`${origin}/gyms/${gym}/equipment/photo`);
			await page.getByLabel('Photo', { exact: true }).setInputFiles({ ...fixture, buffer: png });
			await page.getByRole('button', { name: 'Upload photo', exact: true }).click();
			const text =
				failed === 'block'
					? 'This photo did not pass the safety check.'
					: 'Photo safety checking is unavailable.';
			await expect.poll(() => page.getByText(text, { exact: false }).count()).toBe(1);
			expect(await photoRows()).toHaveLength(1);
			expect(await modelCalls()).toHaveLength(reads);
		}
		await page.close();
	});
	it('workout upload refuses a block without losing the existing workout or stopping set entry', async () => {
		verdict = 'allow';
		const page = await pageForUser();
		await page.goto(origin + '/workout/start');
		await page.getByRole('radio', { name: 'Safety Gym', exact: true }).check();
		await page.getByRole('button', { name: workoutUi.gymStepSubmit, exact: true }).click();
		await page.waitForURL('**/sessions/*');
		const id = page.url().split('/').pop()!;
		const photoControl = page
			.locator('label', { hasText: workoutUi.photoNextMachine })
			.locator('input[type="file"]');
		await photoControl.setInputFiles({ ...fixture, buffer: png });
		await expect
			.poll(() =>
				page.getByRole('heading', { name: workoutUi.placeholderExerciseName, exact: true }).count()
			)
			.toBe(1);
		await expect.poll(() => page.getByText(workoutUi.photoReadFailed).count()).toBe(1);
		const before = (await photoRows()).length;
		const reads = (await modelCalls()).length;
		verdict = 'block';
		await photoControl.setInputFiles({ ...fixture, buffer: png });
		await expect
			.poll(() => page.getByRole('contentinfo').getByRole('alert').innerText())
			.toContain('did not pass the safety check');
		expect(await photoRows()).toHaveLength(before);
		expect(await modelCalls()).toHaveLength(reads);
		expect(
			await harness.db.select().from(s.sessionExercises).where(eq(s.sessionExercises.sessionId, id))
		).toHaveLength(1);
		await page.getByRole('spinbutton', { name: 'Weight', exact: true }).first().fill('65');
		await page.getByRole('spinbutton', { name: 'Reps', exact: true }).first().fill('9');
		await page.getByRole('button', { name: 'Save set 1', exact: true }).click();
		await expect.poll(() => page.getByText('✓ Saved', { exact: true }).count()).toBe(1);
		const sets = await harness.db.select().from(s.sets).where(eq(s.sets.sessionId, id));
		expect(
			sets.filter((r) => r.executedLoad !== null).map((r) => [r.executedLoad, r.executedReps])
		).toEqual([[65, 9]]);
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
			true
		);
		await page.close();
	});
});
