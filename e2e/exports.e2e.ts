import { afterAll, beforeAll, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { eq } from 'drizzle-orm';
import { browserSuite, authenticatedPage, violations } from './browser';
import {
	freshTestDb,
	seedTestUser,
	signInAs,
	startTestServer,
	TEST_PASSWORD
} from '$lib/server/test-auth-helpers';
import { seedExportFixture } from '$lib/server/exports/test-fixtures';
import * as s from '$lib/server/db/schema';

const { run, executablePath } = browserSuite();
run('account downloads (production build)', () => {
	let harness: Awaited<ReturnType<typeof freshTestDb>>;
	let browser: Browser;
	let downloadsDirectory: string;
	let stop = async () => {};
	let origin: string, alice: string, bob: string, cookieA: string, cookieB: string;
	beforeAll(async () => {
		harness = await freshTestDb();
		alice = (await seedTestUser(harness.db, 'export-a@test.local', 'ALICE')).id;
		bob = (await seedTestUser(harness.db, 'export-b@test.local', 'BOB')).id;
		await seedExportFixture(harness.db, alice, 'ALICE', 100);
		await seedExportFixture(harness.db, bob, 'BOB', 200);
		const server = await startTestServer();
		origin = server.origin;
		stop = server.stop;
		cookieA = await signInAs(origin, { email: 'export-a@test.local' });
		cookieB = await signInAs(origin, { email: 'export-b@test.local' });
		// Snap Chromium has a private /tmp; a checkout-local download directory works there and in CI.
		downloadsDirectory = await mkdtemp(join(process.cwd(), '.export-downloads-'));
		browser = await chromium.launch({ executablePath, downloadsPath: downloadsDirectory });
	});
	afterAll(async () => {
		await browser?.close();
		await stop();
		await harness?.end();
		if (downloadsDirectory) await rm(downloadsDirectory, { recursive: true, force: true });
	});
	const post = (fields: Record<string, string> = {}, cookie = cookieA, source = origin) =>
		fetch(origin + '/account/export/download', {
			method: 'POST',
			headers: { cookie, origin: source },
			redirect: 'manual',
			body: new URLSearchParams({
				format: 'json',
				password: TEST_PASSWORD,
				timeZone: 'UTC',
				...fields
			})
		});
	it('downloads actual JSON, ZIP and Strong files on a phone-width page without changing training data', async () => {
		const before = await harness.db.select().from(s.sets);
		const page = await authenticatedPage(browser, cookieA, {
			viewport: { width: 390, height: 844 }
		});
		await page.goto(origin + '/account');
		await page.getByRole('link', { name: 'Export your data', exact: true }).click();
		await page.waitForURL('**/account/export');
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
			true
		);
		await page.getByLabel('Current password', { exact: true }).fill(TEST_PASSWORD);
		await page.getByLabel('Time zone for Strong dates').fill('America/New_York');
		const files: Record<string, Buffer> = {};
		for (const [format, label, extension] of [
			['json', 'Download JSON', '.json'],
			['csv', 'Download CSV tables', '.zip'],
			['strong', 'Download Strong-style CSV', '.csv']
		]) {
			const waiting = page.waitForEvent('download');
			await page.getByRole('button', { name: label, exact: true }).click();
			const download = await waiting;
			expect(download.suggestedFilename()).toMatch(new RegExp(extension.replace('.', '\\.') + '$'));
			expect(await download.failure()).toBeNull();
			files[format] = await readFile((await download.path())!);
		}
		const native = JSON.parse(files.json.toString());
		expect(native.data.profile[0].id).toBe(alice);
		expect(native.data.sets).toHaveLength(6);
		expect(files.json.toString()).not.toContain('BOB');
		expect(files.json.toString()).not.toContain('private-object-ALICE');
		const zip = unzipSync(files.csv);
		expect(strFromU8(zip['workout_sets.csv'])).toContain('ALICE historical name');
		expect(strFromU8(zip['notebook_sets.csv'])).toContain('user_authorized_estimate');
		expect(files.strong.toString()).toContain('"45.359237","5"');
		expect(files.strong.toString()).toContain('2026-06-09 21:30:00');
		expect(await violations(page)).toEqual([]);
		expect(await harness.db.select().from(s.sets)).toEqual(before);
		await page.close();
		const response = await post({}, cookieB);
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toContain('no-store');
		expect(response.headers.get('content-disposition')).toContain(
			'attachment; filename="doclifts-account-'
		);
		expect(response.headers.get('content-type')).toContain('application/json');
		const body = await response.text();
		expect(body).toContain('BOB');
		expect(body).not.toContain('ALICE');
	});
	it('requires current credentials and same-origin bounded form input, rejects account selection and has no GET download', async () => {
		expect((await post({ password: 'wrong-password' })).status).toBe(400);
		expect((await post({}, cookieA, 'https://evil.example')).status).toBe(403);
		for (const fields of [
			{ format: 'unknown' },
			{ timeZone: 'not-a-timezone' },
			{ userId: bob },
			{ password: 'x'.repeat(9000) }
		]) {
			expect([400, 413]).toContain((await post(fields)).status);
		}
		const anonymous = await post({}, '');
		expect(anonymous.status).toBeGreaterThanOrEqual(300);
		expect(anonymous.headers.get('content-disposition')).toBeNull();
		const get = await fetch(origin + '/account/export/download', {
			headers: { cookie: cookieA },
			redirect: 'manual'
		});
		expect(get.status).toBe(405);
	});
	it('refuses revoked sessions and accounts fenced for deletion even with the correct password', async () => {
		await harness.db.delete(s.authSessions).where(eq(s.authSessions.userId, alice));
		const revoked = await post();
		expect(revoked.status).toBeGreaterThanOrEqual(300);
		expect(revoked.headers.get('content-disposition')).toBeNull();
		await harness.db
			.update(s.authUsers)
			.set({ deletionRequestedAt: new Date() })
			.where(eq(s.authUsers.id, bob));
		const deleting = await post({}, cookieB);
		expect(deleting.status).toBeGreaterThanOrEqual(300);
		expect(deleting.headers.get('content-disposition')).toBeNull();
	});
});
