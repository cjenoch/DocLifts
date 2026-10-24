import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { eq } from 'drizzle-orm';
import { browserSuite, authenticatedPage, violations } from './browser';
import {
	freshTestDb,
	seedTestUser,
	signInAs,
	startTestServer,
	TEST_PASSWORD
} from '$lib/server/test-auth-helpers';
import * as s from '$lib/server/db/schema';
import { startTestLedger } from '$lib/server/privacy/test-ledger';
import { readLedger } from '$lib/server/privacy/ledger';

const { run, executablePath } = browserSuite();
run('account removal from its visible phone controls', () => {
	let h: Awaited<ReturnType<typeof freshTestDb>>;
	let browser: Browser;
	let origin: string;
	let stop = async () => {};
	let stopJournal = async () => {};
	let alice: string, bob: string, cookieA: string, cookieB: string, dir: string;
	beforeAll(async () => {
		h = await freshTestDb();
		dir = await mkdtemp(join(tmpdir(), 'doclifts-deletion-'));
		alice = (await seedTestUser(h.db, 'delete-a@test.local', 'Delete A')).id;
		bob = (await seedTestUser(h.db, 'delete-b@test.local', 'Delete B')).id;
		const journal = await startTestLedger(dir);
		stopJournal = journal.stop;
		const server = await startTestServer({
			PRIVACY_DELETION_ENABLED: '1',
			DELETION_LEDGER_SOCKET: journal.socketPath
		});
		origin = server.origin;
		stop = server.stop;
		cookieA = await signInAs(origin, { email: 'delete-a@test.local' });
		cookieB = await signInAs(origin, { email: 'delete-b@test.local' });
		browser = await chromium.launch({ executablePath });
	});
	afterAll(async () => {
		await browser?.close();
		await stop();
		await stopJournal();
		await h?.end();
		if (dir) await rm(dir, { recursive: true, force: true });
	});
	it('requires explicit confirmation and fresh password; fences the session owner and shows honest pending status', async () => {
		const post = (fields: Record<string, string>, csrfOrigin = origin) =>
			fetch(origin + '/account?/deleteAccount', {
				method: 'POST',
				headers: { cookie: cookieA, origin: csrfOrigin, accept: 'text/html' },
				body: new URLSearchParams(fields),
				redirect: 'manual'
			});
		expect(
			(
				await post(
					{ password: TEST_PASSWORD, confirmation: 'DELETE', understand: 'yes' },
					'https://foreign.invalid'
				)
			).status
		).toBe(403);
		expect(
			(await post({ password: TEST_PASSWORD, confirmation: '', understand: 'yes' })).status
		).toBe(400);
		const page = await authenticatedPage(browser, cookieA, {
			viewport: { width: 390, height: 844 }
		});
		await page.goto(origin + '/account');
		await page.getByLabel('Current password', { exact: true }).fill('wrong-password');
		await page.getByLabel('Type DELETE to confirm').fill('DELETE');
		await page.getByRole('checkbox', { name: /permanently removed/ }).check();
		await page.getByRole('button', { name: 'Delete my account permanently' }).click();
		await page.getByRole('alert').waitFor();
		expect(
			(await h.db.select().from(s.authUsers).where(eq(s.authUsers.id, alice)))[0]
				.deletionRequestedAt
		).toBeNull();
		await page.getByLabel('Current password', { exact: true }).fill(TEST_PASSWORD);
		await page.getByLabel('Type DELETE to confirm').fill('DELETE');
		await page.getByRole('checkbox', { name: /permanently removed/ }).check();
		// A posted foreign owner cannot choose whose account is removed.
		await page.locator('form[action="?/deleteAccount"]').evaluate((form, id) => {
			const input = document.createElement('input');
			input.name = 'userId';
			input.value = id;
			form.append(input);
		}, bob);
		await page.getByRole('button', { name: 'Delete my account permanently' }).click();
		await page.waitForURL('**/privacy');
		expect(await page.getByRole('heading', { name: 'Account deletion pending' }).count()).toBe(1);
		expect(
			await h.db.select().from(s.authSessions).where(eq(s.authSessions.userId, alice))
		).toEqual([]);
		expect(
			(await h.db.select().from(s.authUsers).where(eq(s.authUsers.id, bob)))[0].deletionRequestedAt
		).toBeNull();
		expect(
			(await fetch(origin + '/account', { headers: { cookie: cookieA }, redirect: 'manual' }))
				.status
		).toBe(303);
		expect(
			(await fetch(origin + '/account', { headers: { cookie: cookieB }, redirect: 'manual' }))
				.status
		).toBe(200);
		expect(await readLedger(join(dir, 'ledger.jsonl'))).toHaveLength(1);
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
			true
		);
		expect(await violations(page)).toEqual([]);
		await page.close();
	});
	it('removes a confirmed saved image through its visible review form', async () => {
		const [gym] = await h.db
			.insert(s.gyms)
			.values({ userId: bob, name: 'Fictional gym' })
			.returning();
		const id = crypto.randomUUID();
		await h.db.insert(s.equipmentPhotos).values({
			id,
			userId: bob,
			gymId: gym.id,
			storageKey: `users/${bob}/equipment-photos/${id}.jpg`,
			contentType: 'image/jpeg',
			bytes: 1,
			width: 1,
			height: 1,
			sha256: '0'.repeat(64),
			status: 'confirmed'
		});
		const page = await authenticatedPage(browser, cookieB, {
			viewport: { width: 390, height: 844 }
		});
		await page.goto(origin + `/photos/${id}/review`);
		await page.getByRole('checkbox', { name: 'Remove this image permanently' }).check();
		await page.getByRole('button', { name: 'Remove saved photo' }).click();
		await page.waitForURL('**/account?photoRemoved=1');
		expect(await h.db.select().from(s.equipmentPhotos).where(eq(s.equipmentPhotos.id, id))).toEqual(
			[]
		);
		expect(
			(await h.db.select().from(s.privacyDeletions).where(eq(s.privacyDeletions.kind, 'photo')))[0]
				.completedAt
		).not.toBeNull();
		expect(await violations(page)).toEqual([]);
		await page.close();
	});
});
