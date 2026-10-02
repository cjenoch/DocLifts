/**
 * scripts/photo-timings-report.{mjs,sh} (0.5.3), on fixture log lines. The
 * wrapper reads production's log through compose-prod.sh, so it is never run
 * against production here: PHOTO_TIMINGS_LOG points it at a fixture file.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { formatReport, stats, summarize } from '../../../scripts/photo-timings-report.mjs';

const SCRIPT = resolve('scripts/photo-timings-report.sh');
const PHOTO_ID = '3f0c5a52-9a0e-4c1e-8f43-0a7f6b1d2e11';
const USER_ID = '00000000-0000-4000-8000-0000000000aa';

const line = (fields: Record<string, unknown>) =>
	JSON.stringify({
		event: 'photo_upload',
		clientOriginalBytes: 2513122,
		clientResized: true,
		receivedBytes: 663080,
		outcome: 'stored',
		storedBytes: 350700,
		photoId: PHOTO_ID,
		...fields
	});
const timed = (processMs: number, storePutMs: number, modelMs: number, totalMs: number) =>
	line({ processMs, storePutMs, modelMs, totalMs });

// As `docker compose logs` prints them: with and without the service prefix,
// mixed with other app events and noise.
const FIXTURE = [
	'==> building as aa3a51f',
	`web-1  | ${line({})}`, // before 0.5.3: no timings
	line({ outcome: 'refused', storedBytes: null, photoId: null }), // before 0.5.3, refused
	`web-1  | ${timed(100, 40, 2000, 2200)}`,
	timed(300, 60, 2600, 3000),
	timed(200, 50, 2400, 2700),
	`web-1  | {"event":"login_attempt","email":"scratch-test@doclifts.invalid","userId":"${USER_ID}"}`,
	timed(400, 80, 61000, 61500), // a model timeout still counts: the user waited
	// A refused upload after 0.5.3: never reached the put or the model.
	line({
		outcome: 'refused',
		storedBytes: null,
		photoId: null,
		processMs: 5,
		storePutMs: null,
		modelMs: null,
		totalMs: 9
	}),
	// Stored, but the analysis limit refused the call before the model.
	line({ processMs: 250, storePutMs: 70, modelMs: null, totalMs: 400 }),
	'{"event":"photo_upload", not json',
	''
].join('\n');

describe('stats', () => {
	it('median, p90 (nearest rank) and max', () => {
		expect(stats([])).toEqual({ count: 0, median: null, p90: null, max: null });
		expect(stats([7])).toEqual({ count: 1, median: 7, p90: 7, max: 7 });
		expect(stats([4, 1, 3, 2])).toEqual({ count: 4, median: 3, p90: 4, max: 4 }); // (2+3)/2 rounded
		const hundred = Array.from({ length: 100 }, (_, i) => 100 - i); // 100..1
		expect(stats(hundred)).toEqual({ count: 100, median: 51, p90: 90, max: 100 });
	});
});

describe('summarize', () => {
	it('counts lines, keeps stored uploads for the timings, and counts the untimed', () => {
		const sum = summarize(FIXTURE);
		expect(sum).toMatchObject({ lines: 9, stored: 6, refused: 2, untimed: 2, unreadable: 1 });
		expect(sum.stages.processMs).toEqual({ count: 5, median: 250, p90: 400, max: 400 });
		expect(sum.stages.storePutMs).toEqual({ count: 5, median: 60, p90: 80, max: 80 });
		// The limit-refused analysis has no model time; the timeout does.
		expect(sum.stages.modelMs).toEqual({ count: 4, median: 2500, p90: 61000, max: 61000 });
		expect(sum.stages.totalMs).toEqual({ count: 5, median: 2700, p90: 61500, max: 61500 });
	});

	it('a log with no photo_upload line is all zeros', () => {
		const sum = summarize('==> building as x\nweb-1  | listening on 3000\n');
		expect(sum).toMatchObject({ lines: 0, stored: 0, untimed: 0 });
		expect(sum.stages.totalMs.count).toBe(0);
	});
});

describe('the report', () => {
	let dir: string;
	let logFile: string;
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), 'photo-timings-'));
		logFile = join(dir, 'web.log');
		writeFileSync(logFile, FIXTURE);
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it('prints counts and milliseconds only, never an id, a size or an email', () => {
		const text = formatReport(summarize(FIXTURE), 'last 7 days');
		expect(text).toContain('photo_upload lines, last 7 days: 9 (6 stored, 2 refused)');
		expect(text).toContain('lines without timings (before 0.5.3): 2');
		expect(text).toMatch(/^modelMs\s+4\s+2500\s+61000\s+61000$/m);
		for (const secret of [PHOTO_ID, USER_ID, 'scratch-test', '350700', '663080', '2513122']) {
			expect(text).not.toContain(secret);
		}
	});

	it('the shell wrapper reads a saved log and prints the same report', () => {
		const run = spawnSync('sh', [SCRIPT, '7'], {
			encoding: 'utf8',
			env: { ...process.env, PHOTO_TIMINGS_LOG: logFile }
		});
		expect(run.stderr).toBe('');
		expect(run.status).toBe(0);
		expect(run.stdout).toBe(formatReport(summarize(FIXTURE), 'last 7 days') + '\n');
		expect(run.stdout).not.toContain(PHOTO_ID);
	});

	it('refuses a number of days that is not a whole number of at least 1', () => {
		for (const bad of ['0', '-1', '7d', 'x']) {
			const run = spawnSync('sh', [SCRIPT, bad], {
				encoding: 'utf8',
				env: { ...process.env, PHOTO_TIMINGS_LOG: logFile }
			});
			expect(run.status, bad).toBe(2);
		}
	});

	it('reads production only through compose-prod.sh logs, with the days as hours', () => {
		const text = readFileSync(SCRIPT, 'utf8');
		expect(text).toContain(
			'"$here/compose-prod.sh" logs --no-log-prefix --since "$((days * 24))h" web'
		);
		expect(text).not.toMatch(/compose-prod\.sh"? (up|run|exec|down|create)/);
	});
});
