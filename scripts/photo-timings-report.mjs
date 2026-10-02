// The weekly photo timing report (0.5.3): reads the web container's log on
// stdin, keeps the `{"event":"photo_upload",...}` lines, and prints per stage
// the count, median, p90 and max in ms.
//
// Run through scripts/photo-timings-report.sh, which fetches the log. Plain
// Node, no dependencies, so the host's node runs it as is.
//
// PRIVACY: only the timing fields and `outcome` are read from a line, and
// only counts and milliseconds are printed. Photo ids, byte sizes and anything
// else on the line never leave this module.

import { pathToFileURL } from 'node:url';

/** The stages, in the order the request runs them. */
export const STAGES = /** @type {const} */ (['processMs', 'storePutMs', 'modelMs', 'totalMs']);

const MARKER = '{"event":"photo_upload"';

/**
 * @typedef {{ count: number, median: number | null, p90: number | null, max: number | null }} StageStats
 * @typedef {{
 *   lines: number,
 *   stored: number,
 *   refused: number,
 *   untimed: number,
 *   unreadable: number,
 *   stages: Record<(typeof STAGES)[number], StageStats>
 * }} TimingSummary
 */

/** @param {unknown} v */
const isMs = (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/**
 * Median (the mean of the middle two for an even count, rounded) and p90
 * (nearest rank) of a list of whole milliseconds.
 *
 * @param {number[]} values
 * @returns {StageStats}
 */
export function stats(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const n = sorted.length;
	if (n === 0) return { count: 0, median: null, p90: null, max: null };
	const mid = Math.floor(n / 2);
	const median = n % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
	return { count: n, median, p90: sorted[Math.ceil(0.9 * n) - 1], max: sorted[n - 1] };
}

/**
 * Summarize a log. Any prefix before the JSON (`web-1  | `, a timestamp) is
 * ignored. Timings are summarized over STORED uploads only: a refused upload
 * stops early and would drag every median down. A line from before 0.5.3 has
 * no `totalMs` and counts as `untimed`; a stage the request never reached is
 * `null` on the line and is simply not counted for that stage.
 *
 * @param {string} log
 * @returns {TimingSummary}
 */
export function summarize(log) {
	/** @type {Record<string, number[]>} */
	const values = Object.fromEntries(STAGES.map((s) => [s, []]));
	let lines = 0;
	let stored = 0;
	let refused = 0;
	let untimed = 0;
	let unreadable = 0;
	for (const raw of log.split('\n')) {
		const at = raw.indexOf(MARKER);
		if (at < 0) continue;
		lines++;
		/** @type {Record<string, unknown>} */
		let line;
		try {
			line = JSON.parse(raw.slice(at).trim());
		} catch {
			unreadable++;
			continue;
		}
		if (line.outcome === 'refused') refused++;
		if (line.outcome === 'stored') stored++;
		if (!('totalMs' in line)) {
			untimed++;
			continue;
		}
		if (line.outcome !== 'stored') continue;
		for (const s of STAGES) if (isMs(line[s])) values[s].push(/** @type {number} */ (line[s]));
	}
	const stages = /** @type {TimingSummary['stages']} */ (
		Object.fromEntries(STAGES.map((s) => [s, stats(values[s])]))
	);
	return { lines, stored, refused, untimed, unreadable, stages };
}

/**
 * The printed report: counts and milliseconds only.
 *
 * @param {TimingSummary} summary
 * @param {string} [period] e.g. "last 7 days"
 */
export function formatReport(summary, period = 'the log') {
	/** @param {number | null} v */
	const cell = (v) => String(v ?? '-').padStart(8);
	const out = [
		`photo_upload lines, ${period}: ${summary.lines} (${summary.stored} stored, ${summary.refused} refused)`,
		`lines without timings (before 0.5.3): ${summary.untimed}`
	];
	if (summary.unreadable) out.push(`lines that were not valid JSON: ${summary.unreadable}`);
	out.push(
		'',
		'stored uploads, ms:',
		`${'stage'.padEnd(12)}${'count'.padStart(8)}${'median'.padStart(8)}${'p90'.padStart(8)}${'max'.padStart(8)}`
	);
	for (const s of STAGES) {
		const st = summary.stages[s];
		out.push(`${s.padEnd(12)}${cell(st.count)}${cell(st.median)}${cell(st.p90)}${cell(st.max)}`);
	}
	return out.join('\n');
}

/** @param {NodeJS.ReadableStream} stream */
async function readAll(stream) {
	let text = '';
	for await (const chunk of stream) text += chunk;
	return text;
}

// Run as a script: the log on stdin, the number of days as the only argument.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const days = process.argv[2];
	const period = days ? `last ${days} day${days === '1' ? '' : 's'}` : 'the log';
	process.stdout.write(formatReport(summarize(await readAll(process.stdin)), period) + '\n');
}
