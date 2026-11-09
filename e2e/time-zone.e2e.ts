import { browserSuite, authenticatedPage, violations } from './browser';
/**
 * The user's own days (owner decision, 2026-11-09), on the PRODUCTION build in
 * a real browser. How this is used on a phone: nobody types a zone. The phone's
 * browser reports `Intl.DateTimeFormat().resolvedOptions().timeZone` once,
 * from the root layout, and History then lists a 7:30 pm Detroit workout on
 * the day it happened instead of the next UTC day.
 *
 * The browser context runs in America/Detroit (Playwright `timezoneId`); the
 * server and the database stay on whatever they are. Asserts the stored row,
 * not only the page: the post went through the real handler chain, including
 * the same-origin form rule in csrfBoundary.
 *
 * Prerequisites and skip rules are the same as csp.e2e.ts.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { eq } from 'drizzle-orm';
import { setupTestDb } from '$lib/server/test-db';
import {
	freshTestDb,
	seedTestUser,
	signInAs,
	startTestServer
} from '$lib/server/test-auth-helpers';
import * as s from '$lib/server/db/schema';

const { run, executablePath } = browserSuite();

run('time zone from the browser (production build)', () => {
	let harness: Awaited<ReturnType<typeof setupTestDb>>;
	let stopServer = async () => {};
	let origin: string;
	let cookie: string;
	let browser: Browser;
	let userId: string;
	let sessionId: string;

	beforeAll(async () => {
		harness = await freshTestDb();
		userId = (await seedTestUser(harness.db)).id;
		const [program] = await harness.db
			.insert(s.programs)
			.values({ userId, name: 'Zone test' })
			.returning();
		const [day] = await harness.db
			.insert(s.days)
			.values({ programId: program.id, name: 'Evening push', position: 1 })
			.returning();
		// 00:30 UTC on Mon Nov 9 is 19:30 EST on Sun Nov 8 in Detroit.
		const [session] = await harness.db
			.insert(s.sessions)
			.values({
				userId,
				programId: program.id,
				dayId: day.id,
				startedAt: new Date('2026-11-09T00:30:00Z'),
				endedAt: new Date('2026-11-09T01:30:00Z')
			})
			.returning();
		sessionId = session.id;

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

	const storedZone = async () =>
		(
			await harness.db
				.select({ tz: s.authUsers.timeZone })
				.from(s.authUsers)
				.where(eq(s.authUsers.id, userId))
		)[0].tz;

	const dateLine = (page: import('playwright').Page) =>
		page.locator(`a[href="/sessions/${sessionId}"] div.mt-1`).innerText();

	it('stores the phone zone once and History shows the local day', async () => {
		expect(await storedZone()).toBeNull();
		const page = await authenticatedPage(browser, cookie, {
			viewport: { width: 390, height: 844 },
			timezoneId: 'America/Detroit',
			locale: 'en-US'
		});
		try {
			const posts: number[] = [];
			page.on('response', (r) => {
				if (new URL(r.url()).pathname === '/account/time-zone') posts.push(r.status());
			});
			await page.goto(`${origin}/history?month=2026-11`, { waitUntil: 'networkidle' });

			// Positive first: the zone is stored, and the page moved to the local day.
			await expect.poll(storedZone).toBe('America/Detroit');
			expect(posts).toEqual([204]);
			await expect.poll(() => dateLine(page)).toMatch(/^Sun, Nov 8\b/);

			// A fresh load renders the local day on the server, and posts nothing.
			await page.reload({ waitUntil: 'networkidle' });
			expect(await dateLine(page)).toMatch(/^Sun, Nov 8\b/);
			expect(posts).toEqual([204]);
			expect(await violations(page)).toEqual([]);
		} finally {
			await page.close();
		}
	});

	it('a UTC browser moves the stored zone back, and History shows the UTC day', async () => {
		const page = await authenticatedPage(browser, cookie, {
			viewport: { width: 390, height: 844 },
			timezoneId: 'UTC',
			locale: 'en-US'
		});
		try {
			await page.goto(`${origin}/history?month=2026-11`, { waitUntil: 'networkidle' });
			await expect.poll(storedZone).toBe('UTC');
			await expect.poll(() => dateLine(page)).toMatch(/^Mon, Nov 9\b/);
		} finally {
			await page.close();
		}
	});
});
