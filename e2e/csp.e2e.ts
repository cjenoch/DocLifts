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
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { setupTestDb, resetTestDb } from '$lib/server/test-db';
import * as s from '$lib/server/db/schema';

const BUILD_ENTRY = 'build/index.js';
const TEST_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://localhost/doclifts_test';

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

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.listen(0, '127.0.0.1', () => {
			const address = srv.address();
			const port = typeof address === 'object' && address ? address.port : 0;
			srv.close(() => (port ? resolve(port) : reject(new Error('no port'))));
		});
	});
}

async function waitForServer(origin: string, child: ChildProcess): Promise<void> {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode})`);
		try {
			const res = await fetch(origin + '/');
			if (res.status < 500) return;
		} catch {
			/* not up yet */
		}
		await new Promise((r) => setTimeout(r, 200));
	}
	throw new Error('server did not come up within 30s');
}

declare global {
	interface Window {
		__cspViolations: string[];
	}
}

run('production build: CSP and page render', () => {
	let harness: Awaited<ReturnType<typeof setupTestDb>>;
	let server: ChildProcess;
	let serverLog = '';
	let origin: string;
	let browser: Browser;
	let programId: string;
	let sessionId: string;

	beforeAll(async () => {
		harness = await setupTestDb();
		await resetTestDb(harness.client);
		const db = harness.db;

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

		const port = await freePort();
		origin = `http://127.0.0.1:${port}`;
		server = spawn(process.execPath, [BUILD_ENTRY], {
			env: {
				...process.env,
				HOST: '127.0.0.1',
				PORT: String(port),
				ORIGIN: origin,
				DATABASE_URL: TEST_URL
			},
			stdio: ['ignore', 'pipe', 'pipe']
		});
		server.stdout?.on('data', (d) => (serverLog += d));
		server.stderr?.on('data', (d) => (serverLog += d));
		await waitForServer(origin, server);

		browser = await chromium.launch({ executablePath });
	});

	afterAll(async () => {
		await browser?.close();
		server?.kill();
		await harness?.end();
	});

	async function visit(path: string) {
		const page = await browser.newPage();
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
});
