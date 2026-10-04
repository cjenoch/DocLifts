import { browserSuite, authenticatedPage, watchCsp, auditCsp as audit } from './browser';
import { oauthFixture } from './mcp-fixture';
/**
 * End-to-end pass against a PRODUCTION build served by adapter-node.
 *
 * Why this exists: the 2026-09-28 Content-Security-Policy change shipped
 * with every completion bar on /reports drawn at the same width. Unit and
 * component suites never see the CSP header, so they stayed green. This
 * test loads every page in a real Chromium with the server's real headers
 * and fails on any `securitypolicyviolation` event, plus a few render
 * assertions on the page that broke.
 *
 * Prerequisites: `pnpm build` (build/index.js), a Chromium Playwright can
 * launch (bundled, or `PW_EXECUTABLE_PATH`), and the same test database as
 * the server suite (`TEST_DATABASE_URL`). Locally the suite skips itself
 * when the build or the browser is missing. In CI (`CI` env var set) both
 * are required and a missing prerequisite fails the run.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { setupTestDb, resetTestDb } from '$lib/server/test-db';
import {
	freshTestDb,
	seedTestUser,
	signInAs,
	startTestServer
} from '$lib/server/test-auth-helpers';
import * as s from '$lib/server/db/schema';
import { smallPng } from '$lib/server/photos/test-fixtures';
import { postPhoto, reviewedPhotoId } from './photo-upload';

const { run, executablePath } = browserSuite();

run('production build: CSP and page render', () => {
	let harness: Awaited<ReturnType<typeof setupTestDb>>;
	let stopServer = async () => {};
	let serverLog = '';
	let origin: string;
	let cookie: string;
	let browser: Browser;
	let programId: string;
	let sessionId: string;
	let modelId: string;
	let gymId: string;
	let photoId: string;
	let machineId: string;
	let consentPath: string;

	beforeAll(async () => {
		harness = await freshTestDb();
		const db = harness.db;

		// The crawl is AUTHENTICATED. Since T2 every page except /login is
		// guarded, so an unauthenticated crawl would 303 to the login screen
		// and pass by measuring nothing. The user is created through the
		// operator path (createUser), never Better Auth's sign-up endpoint,
		// which stays disabled.
		const user = await seedTestUser(db);

		// Minimal fixture that exercises every page: one program, one day, one
		// exercise, an ENDED session with 2 sets of which exactly 1 is
		// executed — so /reports has a 50% completion bar to measure.
		// Every row the crawl reads is owned by the signed-in user. Without an
		// owner these are invisible to the scoped queries T3 introduced, and
		// /programs/[id] correctly 404s — the page would stop being crawled.
		const [program] = await db
			.insert(s.programs)
			.values({ name: 'E2E Program', userId: user.id })
			.returning();
		programId = program.id;
		const [day] = await db
			.insert(s.days)
			.values({ programId, name: 'E2E Day', position: 1 })
			.returning();
		const [exercise] = await db
			.insert(s.exercises)
			.values({ name: 'E2E Press', equipmentType: 'barbell', userId: user.id })
			.returning();
		const [dx] = await db
			.insert(s.dayExercises)
			.values({
				dayId: day.id,
				exerciseId: exercise.id,
				position: 1,
				tier: 'secondary',
				progressionPolicy: 'standard'
			})
			.returning();
		await db.insert(s.prescribedSets).values([
			{
				dayExerciseId: dx.id,
				position: 1,
				setRole: 'working',
				targetMetric: 'reps',
				targetRepsMin: 8,
				targetRepsMax: 10,
				targetRir: 1,
				initialLoad: 95
			},
			{
				dayExerciseId: dx.id,
				position: 2,
				setRole: 'working',
				targetMetric: 'reps',
				targetRepsMin: 8,
				targetRepsMax: 10,
				targetRir: 1,
				initialLoad: 95
			}
		]);
		const [session] = await db
			.insert(s.sessions)
			.values({
				dayId: day.id,
				programId,
				userId: user.id,
				startedAt: new Date(Date.now() - 3_600_000),
				endedAt: new Date(Date.now() - 1_800_000)
			})
			.returning();
		sessionId = session.id;
		await db.insert(s.sets).values([
			{
				userId: user.id,
				sessionId,
				exerciseId: exercise.id,
				position: 1,
				setRole: 'working',
				targetMetric: 'reps',
				prescribedLoad: 95,
				prescribedRepsMin: 8,
				prescribedRepsMax: 10,
				prescribedRir: 1,
				executedLoad: 95,
				executedReps: 10,
				executedRir: 1
			},
			{
				// The NOT NULL flip caught this: the first set was stamped, this one
				// was not, and the e2e fixture was the only insert path in the tree
				// that svelte-check could not see.
				userId: user.id,
				sessionId,
				exerciseId: exercise.id,
				position: 2,
				setRole: 'working',
				targetMetric: 'reps',
				prescribedLoad: 95,
				prescribedRepsMin: 8,
				prescribedRepsMax: 10,
				prescribedRir: 1
			}
		]);

		// One global catalog row, so /equipment lists something and
		// /equipment/{id} resolves. Global (owner_user_id NULL) on purpose:
		// every signed-in user may read it.
		const [model] = await db
			.insert(s.equipmentModels)
			.values({
				manufacturer: 'Hammer Strength',
				productLine: 'Plate Loaded',
				code: 'IL-ROW',
				name: 'Iso-Lateral Row',
				loadingType: 'machine-plate',
				laterality: 'independent',
				bodyRegion: 'back',
				startingResistance: 12,
				startingResistanceBasis: 'per_arm',
				confidence: 'manufacturer_page',
				sourceUrl: 'https://example.invalid/catalog',
				catalogSnapshot: '2026-09-30'
			})
			.returning();
		modelId = model.id;
		// A gym with one machine, so /gyms/{gymId}/machines/{id}/edit resolves.
		const [gym] = await db.insert(s.gyms).values({ name: 'CSP Gym', userId: user.id }).returning();
		gymId = gym.id;
		const [machine] = await db
			.insert(s.gymEquipment)
			.values({
				gymId,
				localLabel: 'CSP row',
				equipmentType: 'machine-plate',
				equipmentModelId: model.id
			})
			.returning();
		machineId = machine.id;

		const started = await startTestServer();
		origin = started.origin;
		stopServer = started.stop;
		serverLog = started.log();

		cookie = await signInAs(origin);
		const oauth = await oauthFixture(origin, cookie);
		if (!oauth.consent) throw new Error('No consent redirect');
		consentPath = new URL(oauth.consent, origin).pathname + new URL(oauth.consent, origin).search;

		// 0.4.0: a photo uploaded to that gym through the served build's own
		// form action, so /gyms/{gymId}/equipment/photo and /photos/{id}/review
		// are crawled with a real stored image behind the review page's <img>.
		photoId = reviewedPhotoId(await postPhoto(origin, cookie, gymId, await smallPng()));

		browser = await chromium.launch({ executablePath });
	});

	afterAll(async () => {
		await browser?.close();
		await stopServer();
		await harness?.end();
	});

	async function visit(path: string, width?: number, loggedOut = false) {
		const options = width ? { viewport: { width, height: 844 } } : {};
		const page = loggedOut
			? await browser.newPage(options)
			: await authenticatedPage(browser, cookie, options);
		if (loggedOut) await watchCsp(page);
		const response = await page.goto(origin + path, { waitUntil: 'networkidle' });
		return { page, status: response?.status(), ...(await audit(page)) };
	}

	const visitLoggedOut = (path: string, width?: number) => visit(path, width, true);

	async function expectAnnouncerHidden(page: Awaited<ReturnType<Browser['newPage']>>) {
		const box = await page.evaluate(() => {
			const a = document.getElementById('svelte-announcer');
			if (!a) return null;
			const r = a.getBoundingClientRect();
			return { w: r.width, h: r.height, position: getComputedStyle(a).position };
		});
		if (box) {
			expect(box.position).toBe('absolute');
			expect(box.w).toBeLessThanOrEqual(1);
			expect(box.h).toBeLessThanOrEqual(1);
		}
	}

	// The crawl floor. Every route the app serves must be reached by this file,
	// and `reached` below fails the suite by name if a pattern is ever added to
	// this table without being visited. Patterns resolve against the fixture's
	// programId/sessionId; a pattern with no value resolves to itself.
	const ROUTE_PATTERNS = [
		'/',
		'/history',
		'/reports',
		'/gyms',
		'/gyms/{gymId}/equipment/photo',
		'/photos/{id}/review',
		'/gyms/{gymId}/machines/{id}/edit',
		'/equipment',
		'/equipment/{id}',
		'/equipment/{id}/edit',
		'/exercises',
		'/imported-history',
		'/programs/new',
		'/programs/{id}',
		'/programs/{id}/edit',
		'/sessions/{id}',
		'/workout/start',
		'/account',
		'/account/password',
		'/account/connections',
		'/account/connections/consent',
		'/login',
		'/privacy'
	] as const;
	type RoutePattern = (typeof ROUTE_PATTERNS)[number];
	const reached = new Set<string>();

	function resolvePattern(pattern: RoutePattern): string {
		if (pattern === '/account/connections/consent') return consentPath;
		if (pattern === '/programs/{id}') return `/programs/${programId}`;
		if (pattern === '/programs/{id}/edit') return `/programs/${programId}/edit`;
		if (pattern === '/sessions/{id}') return `/sessions/${sessionId}`;
		if (pattern === '/equipment/{id}') return `/equipment/${modelId}`;
		if (pattern === '/equipment/{id}/edit') return `/equipment/${modelId}/edit`;
		if (pattern === '/gyms/{gymId}/equipment/photo') return `/gyms/${gymId}/equipment/photo`;
		if (pattern === '/photos/{id}/review') return `/photos/${photoId}/review`;
		if (pattern === '/gyms/{gymId}/machines/{id}/edit')
			return `/gyms/${gymId}/machines/${machineId}/edit`;
		return pattern;
	}

	for (const pattern of ROUTE_PATTERNS) {
		it(pattern + ' renders cleanly on phone and desktop', async () => {
			const path = resolvePattern(pattern);
			const { page, status } =
				pattern === '/login' || pattern === '/privacy'
					? await visitLoggedOut(path, 390)
					: await visit(path, 390);
			try {
				expect(status, path + ' -> ' + serverLog).toBe(200);
				// A redirect to a different 200 page must not count as route coverage.
				expect(new URL(page.url()).pathname).toBe(new URL(path, origin).pathname);
				const layout = await page.evaluate(() => {
					const tabs = [...document.querySelectorAll('nav[aria-label="Main navigation"] a')];
					return {
						scrollWidth: document.documentElement.scrollWidth,
						tabs: tabs.map((a) => {
							const r = a.getBoundingClientRect();
							return { top: Math.round(r.top), left: r.left, right: r.right };
						})
					};
				});
				expect(layout.scrollWidth, path + ' scrolls sideways').toBeLessThanOrEqual(390);
				for (const tab of layout.tabs) {
					expect(tab.top, path + ': tabs on one row').toBe(layout.tabs[0].top);
					expect(tab.left, path).toBeGreaterThanOrEqual(0);
					expect(tab.right, path).toBeLessThanOrEqual(390);
				}
				expect(await audit(page), path + ' phone CSP').toEqual({
					violations: [],
					appStyledElements: []
				});
				await page.setViewportSize({ width: 1280, height: 720 });
				await page.evaluate(
					() =>
						new Promise<void>((resolve) =>
							requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
						)
				);
				expect(await audit(page), path + ' desktop CSP').toEqual({
					violations: [],
					appStyledElements: []
				});
				reached.add(pattern);
			} finally {
				await page.close();
			}
		});
	}

	it('every route pattern was actually reached', () => {
		const missing = ROUTE_PATTERNS.filter((pattern) => !reached.has(pattern));
		expect(missing, 'never reached: ' + missing.join(', ')).toEqual([]);
	});

	it('the shared audit detects blocked script and app style attributes', async () => {
		const { page } = await visit('/');
		try {
			expect(await audit(page)).toEqual({ violations: [], appStyledElements: [] });
			await page.evaluate(() => {
				const app = document.createElement('div');
				app.id = 'csp-audit-canary';
				app.setAttribute('style', 'width: 777px');
				document.body.append(app);
				const script = document.createElement('script');
				script.textContent = 'document.documentElement.dataset.cspCanary = "ran"';
				document.body.append(script);
			});
			await expect
				.poll(async () =>
					(await audit(page)).violations.some((value) => value.startsWith('script-src'))
				)
				.toBe(true);
			expect((await audit(page)).appStyledElements).toContain('csp-audit-canary');
			expect(await page.locator('html').getAttribute('data-csp-canary')).toBeNull();
		} finally {
			await page.close();
		}
	});

	it('client-side navigation stays clean and the route announcer stays hidden', async () => {
		const { page } = await visit('/');
		await page.click('nav a[href="/gyms"]');
		await page.waitForURL('**/gyms');
		await page.click('nav a[href="/reports"]');
		await page.waitForURL('**/reports');
		const { violations, appStyledElements } = await audit(page);
		expect(violations).toEqual([]);
		expect(appStyledElements).toEqual([]);
		await expectAnnouncerHidden(page);
		await page.close();
	});

	// Spec §2 item 2: a reveal toggle on every password field, under the
	// existing CSP. The component test proves the toggle in isolation; this
	// proves it on the SERVED build, where the CSP header is real and a
	// blocked handler would leave a button that silently does nothing.
	for (const [path, fields] of [
		['/login', ['Password']],
		['/account/password', ['Current password', 'New password', 'New password again']]
	] as const) {
		it(`every password field on ${path} reveals and re-masks, with no CSP violation`, async () => {
			const { page } = path === '/login' ? await visitLoggedOut(path) : await visit(path);
			const masked = await page.locator('input[type="password"]').count();
			expect(masked, `${path}: password fields found`).toBe(fields.length);

			for (const label of fields) {
				const input = page.getByLabel(label, { exact: true });
				expect(await input.getAttribute('type')).toBe('password');
				await page
					.getByRole('button', { name: `Show ${label.toLowerCase()}`, exact: true })
					.click();
				expect(await input.getAttribute('type'), `${path}: ${label} after Show`).toBe('text');
				await page
					.getByRole('button', { name: `Hide ${label.toLowerCase()}`, exact: true })
					.click();
				expect(await input.getAttribute('type'), `${path}: ${label} after Hide`).toBe('password');
			}

			const { violations, appStyledElements } = await audit(page);
			expect(violations, path).toEqual([]);
			expect(appStyledElements, path).toEqual([]);
			await page.close();
		});
	}

	it('/reports completion bar reflects the real ratio, not a CSP-blocked width', async () => {
		const { page } = await visit('/reports');
		const bar = page.locator('progress').first();
		await expect.poll(() => bar.count()).toBeGreaterThan(0);
		expect(await bar.getAttribute('value')).toBe('1');
		expect(await bar.getAttribute('max')).toBe('2');
		// The fixture session shows as 50% in the text next to the bar.
		await expect.poll(() => page.locator('text=50%').count()).toBeGreaterThan(0);
		await page.close();
	});

	// A separate top-level suite: the guard's user-facing behaviour, proven in
	// a real browser rather than by calling a helper.
	//
	// Without authentication the crawl above would 303 every page and pass
	// while measuring nothing at all. This is the assertion that the guard is
	// actually protecting the app, and that logging out really ends the
	// session rather than only redirecting once.
	describe('auth guard', () => {
		it('redirects an anonymous visitor to /login', async () => {
			const page = await browser.newPage();
			const res = await page.goto(origin + '/history', { waitUntil: 'domcontentloaded' });
			expect(res?.status()).toBe(200); // the followed redirect lands on /login
			expect(page.url()).toContain('/login');
			await page.close();
		});

		it('serves a protected page to a signed-in visitor', async () => {
			const page = await authenticatedPage(browser, cookie);
			await page.goto(origin + '/history', { waitUntil: 'domcontentloaded' });
			expect(page.url(), 'a signed-in visitor must not be bounced to /login').not.toContain(
				'/login',
				'/privacy'
			);
			await page.close();
		});

		it('POST /logout ends the session, so the next request 303s again', async () => {
			const page = await authenticatedPage(browser, cookie);
			await page.goto(origin + '/history', { waitUntil: 'domcontentloaded' });
			expect(page.url()).not.toContain('/login');

			// POST exactly as the header control does. Playwright's request
			// context shares the page's cookie jar, so this is a real
			// authenticated request rather than an in-page fetch that CSP or
			// the CSRF origin check would reject before the action runs.
			//
			// Two headers are load-bearing, both found the hard way:
			//   `origin` — SvelteKit's CSRF check compares it to the request's
			//              own origin; without it the POST is a 403.
			//   `accept` — without `text/html` SvelteKit answers a form POST
			//              with a JSON envelope at HTTP 200, not a real 303.
			const res = await page.request.post(origin + '/logout', {
				headers: { accept: 'text/html', origin },
				form: {},
				maxRedirects: 0
			});
			expect(res.status()).toBe(303);
			expect(res.headers()['location']).toContain('/login');

			// The session is gone, not merely redirected.
			const after = await page.request.get(origin + '/history', { maxRedirects: 0 });
			expect(after.status(), 'the guard must redirect after sign-out').toBe(303);
			await page.close();
		});

		it('GET /logout is refused and leaves the session intact', async () => {
			// A prefetch, a crawler, or an <img> tag must never end a session.
			// This is the whole reason logout is POST-only, so it gets its own
			// page and a FRESH sign-in: the previous test already destroyed its
			// session, and reusing it would assert against a 303 for the wrong
			// reason and pass by accident.
			// A FRESH sign-in: the previous test destroyed its session, so
			// reusing that cookie would bounce to /login for the wrong reason
			// and this test would pass without testing anything.
			const fresh = await signInAs(origin);
			const page = await authenticatedPage(browser, fresh);
			await page.goto(origin + '/history', { waitUntil: 'domcontentloaded' });
			expect(page.url()).not.toContain('/login');

			const res = await page.request.get(origin + '/logout', { maxRedirects: 0 });
			expect(res.status()).toBe(405);
			expect(res.headers()['allow']).toBe('POST');

			// The claim under test: the session SURVIVED the GET. Checked
			// directly, not inferred from which page came back.
			const after = await page.request.get(origin + '/history', { maxRedirects: 0 });
			expect(after.status(), 'a GET /logout must not have ended the session').toBe(200);
			await page.close();
		});
	});
});
