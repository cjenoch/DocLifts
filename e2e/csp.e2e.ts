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
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { setupTestDb, resetTestDb } from '$lib/server/test-db';
import {
	BUILD_ENTRY,
	freshTestDb,
	seedTestUser,
	signInAs,
	startTestServer
} from '$lib/server/test-auth-helpers';
import * as s from '$lib/server/db/schema';

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
	...(executablePath ? [] : ['a Chromium for Playwright (pnpm exec playwright install chromium)'])
];
if (missing.length && process.env.CI) {
	throw new Error(`e2e prerequisites missing in CI: ${missing.join('; ')}`);
}
const run = missing.length ? describe.skip : describe;
if (missing.length) {
	console.warn(`[e2e] skipped — missing ${missing.join('; ')}`);
}

declare global {
	interface Window {
		__cspViolations: string[];
	}
}

/**
 * A page carrying the session cookie from the shared sign-in helper.
 *
 * The cookie is split on the FIRST '=' only: a Better Auth session token is
 * `name.signature` percent-encoded, so the value itself contains '%3D' and a
 * naive `split('=')` truncates it into an invalid token that authenticates
 * nobody.
 */
async function authenticatedPage(browser: Browser, cookie: string, _origin: string) {
	const page = await browser.newPage();
	const eq = cookie.indexOf('=');
	await page.context().addCookies([
		{
			name: cookie.slice(0, eq),
			value: decodeURIComponent(cookie.slice(eq + 1)),
			domain: '127.0.0.1',
			path: '/'
		}
	]);
	return page;
}

run('production build: CSP and page render', () => {
	let harness: Awaited<ReturnType<typeof setupTestDb>>;
	let server: ChildProcess;
	let serverLog = '';
	let origin: string;
	let cookie: string;
	let browser: Browser;
	let programId: string;
	let sessionId: string;

	beforeAll(async () => {
		harness = await freshTestDb();
		const db = harness.db;

		// The crawl is AUTHENTICATED. Since T2 every page except /login is
		// guarded, so an unauthenticated crawl would 303 to the login screen
		// and pass by measuring nothing. The user is created through the
		// operator path (createUser), never Better Auth's sign-up endpoint,
		// which stays disabled.
		await seedTestUser(db);

		// Minimal fixture that exercises every page: one program, one day, one
		// exercise, an ENDED session with 2 sets of which exactly 1 is
		// executed — so /reports has a 50% completion bar to measure.
		const [program] = await db.insert(s.programs).values({ name: 'E2E Program' }).returning();
		programId = program.id;
		const [day] = await db
			.insert(s.days)
			.values({ programId, name: 'E2E Day', position: 1 })
			.returning();
		const [exercise] = await db
			.insert(s.exercises)
			.values({ name: 'E2E Press', equipmentType: 'barbell' })
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
				startedAt: new Date(Date.now() - 3_600_000),
				endedAt: new Date(Date.now() - 1_800_000)
			})
			.returning();
		sessionId = session.id;
		await db.insert(s.sets).values([
			{
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

		const started = await startTestServer();
		origin = started.origin;
		server = started.server;
		serverLog = started.log();

		cookie = await signInAs(origin);

		browser = await chromium.launch({ executablePath });
	});

	afterAll(async () => {
		await browser?.close();
		server?.kill();
		await harness?.end();
	});

	async function visit(path: string) {
		// The crawl is AUTHENTICATED. Since T2 every page except /login is
		// guarded, so an unauthenticated crawl would 303 to the login screen
		// and pass while measuring nothing at all.
		const page = await authenticatedPage(browser, cookie, origin);
		const consoleErrors: string[] = [];
		page.on('console', (msg) => {
			if (msg.type() === 'error') consoleErrors.push(msg.text());
		});
		// Registered before any document script runs, so violations raised
		// while parsing the HTML (inline style attributes, inline scripts)
		// are captured too.
		await page.addInitScript(() => {
			window.__cspViolations = [];
			document.addEventListener('securitypolicyviolation', (e) => {
				window.__cspViolations.push(
					`${e.violatedDirective} blocked ${e.blockedURI || 'inline'}: ${e.sample || ''}`.trim()
				);
			});
		});
		const response = await page.goto(origin + path, { waitUntil: 'networkidle' });
		return { page, status: response?.status(), ...(await audit(page)), consoleErrors };
	}

	/**
	 * Collects CSP violations and the elements carrying a `style` attribute.
	 *
	 * Known framework artifact, tolerated on purpose: SvelteKit's own
	 * `#svelte-announcer` live region is created client-side with an inline
	 * style, which raises one `style-src-attr` violation per page. The
	 * element still ends up visually hidden (kit applies the hiding through
	 * the CSS object model, which CSP does not govern), so it has no visible
	 * effect. Everything else — any other directive, or any APP element with
	 * a style attribute — is a failure.
	 */
	async function audit(page: Awaited<ReturnType<Browser['newPage']>>) {
		const raw = await page.evaluate(() => window.__cspViolations);
		const styledElements = await page.evaluate(() =>
			[...document.querySelectorAll('[style]')].map((e) => e.id || e.tagName.toLowerCase())
		);
		const appStyledElements = styledElements.filter((id) => id !== 'svelte-announcer');
		const violations = raw.filter((v) => !v.startsWith('style-src-attr '));
		return { violations, appStyledElements };
	}

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

	const routes = ['/', '/history', '/reports', '/gyms', '/imported-history'];

	for (const path of routes) {
		it(`${path} renders with no CSP violation`, async () => {
			const { page, status, violations, appStyledElements } = await visit(path);
			expect(status, serverLog).toBe(200);
			expect(violations).toEqual([]);
			expect(appStyledElements).toEqual([]);
			await page.close();
		});
	}

	it('/programs/[id] renders with no CSP violation', async () => {
		const { page, status, violations, appStyledElements } = await visit(`/programs/${programId}`);
		expect(status, serverLog).toBe(200);
		expect(violations).toEqual([]);
		expect(appStyledElements).toEqual([]);
		await page.close();
	});

	it('/sessions/[id] renders with no CSP violation', async () => {
		const { page, status, violations, appStyledElements } = await visit(`/sessions/${sessionId}`);
		expect(status, serverLog).toBe(200);
		expect(violations).toEqual([]);
		expect(appStyledElements).toEqual([]);
		await page.close();
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
			const page = await authenticatedPage(browser, cookie, origin);
			await page.goto(origin + '/history', { waitUntil: 'domcontentloaded' });
			expect(page.url(), 'a signed-in visitor must not be bounced to /login').not.toContain(
				'/login'
			);
			await page.close();
		});

		it('POST /logout ends the session, so the next request 303s again', async () => {
			const page = await authenticatedPage(browser, cookie, origin);
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
			const page = await authenticatedPage(browser, fresh, origin);
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
