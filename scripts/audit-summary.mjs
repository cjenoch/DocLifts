#!/usr/bin/env node
/**
 * Turns `pnpm audit --prod --json` into a Markdown report for the GitHub job
 * summary. REPORT ONLY: it never fails a job, whatever it finds (owner
 * decision, 2026-10-02). Used by the CI job and the weekly
 * `dependency-audit.yml` workflow.
 *
 *   pnpm audit --prod --json > audit.json || true
 *   node scripts/audit-summary.mjs audit.json >> "$GITHUB_STEP_SUMMARY"
 *
 * Every finding gets one row: severity, package, vulnerable and patched
 * versions, the dependency path(s) it is reached by, and the advisory link.
 * The last line says whether a gate at "high" would fail, and which packages
 * would trigger it.
 */
import { readFileSync } from 'node:fs';

export const SEVERITY_ORDER = ['critical', 'high', 'moderate', 'low', 'info'];
/** The level a future blocking gate would fail at; this script only reports it. */
export const FAIL_AT = 'high';
const MAX_PATHS = 3;

const cell = (s) =>
	String(s ?? '')
		.replace(/\|/g, '\\|')
		.replace(/\n/g, ' ');

/** @param {any} audit the parsed `pnpm audit --json` object */
export function summarize(audit) {
	const advisories = Object.values(audit?.advisories ?? {});
	const rank = (sev) => {
		const i = SEVERITY_ORDER.indexOf(sev);
		return i === -1 ? SEVERITY_ORDER.length : i;
	};
	advisories.sort(
		(a, b) =>
			rank(a.severity) - rank(b.severity) ||
			String(a.module_name).localeCompare(String(b.module_name))
	);
	const counts = Object.fromEntries(SEVERITY_ORDER.map((s) => [s, 0]));
	for (const a of advisories) counts[a.severity] = (counts[a.severity] ?? 0) + 1;

	const lines = ['## Production dependency audit (report only)', ''];
	if (!advisories.length) {
		lines.push('No known vulnerabilities in production dependencies.', '');
	} else {
		lines.push(
			`${advisories.length} finding(s): ` +
				SEVERITY_ORDER.filter((s) => counts[s])
					.map((s) => `${counts[s]} ${s}`)
					.join(', ') +
				'.',
			'',
			'| Severity | Package | Vulnerable | Patched | Path | Advisory |',
			'| --- | --- | --- | --- | --- | --- |'
		);
		for (const a of advisories) {
			const paths = [...new Set((a.findings ?? []).flatMap((f) => f.paths ?? []))];
			const shown = paths
				.slice(0, MAX_PATHS)
				.map((p) => `\`${cell(p)}\``)
				.join('<br>');
			const more = paths.length > MAX_PATHS ? `<br>+${paths.length - MAX_PATHS} more` : '';
			lines.push(
				`| ${cell(a.severity)} | ${cell(a.module_name)} | ${cell(a.vulnerable_versions)} | ${cell(a.patched_versions)} | ${shown}${more} | ${a.url ? `[${cell(a.github_advisory_id ?? 'advisory')}](${a.url})` : ''} |`
			);
		}
		lines.push('');
	}
	const failing = [
		...new Set(
			advisories.filter((a) => rank(a.severity) <= rank(FAIL_AT)).map((a) => String(a.module_name))
		)
	].sort();
	lines.push(
		`**Would fail at ${FAIL_AT}: ${failing.length ? 'yes' : 'no'}**` +
			(failing.length ? ` (${failing.join(', ')})` : '')
	);
	return lines.join('\n') + '\n';
}

if (import.meta.url === `file://${process.argv[1]}`) {
	let text = '';
	try {
		text = readFileSync(process.argv[2] ?? 0, 'utf8');
		process.stdout.write(summarize(JSON.parse(text)));
	} catch (error) {
		// Report-only: an unreadable audit is itself the report.
		process.stdout.write(
			`## Production dependency audit (report only)\n\nThe audit output could not be read (${error.message}). First 300 characters:\n\n\`\`\`\n${text.slice(0, 300)}\n\`\`\`\n`
		);
	}
	process.exit(0);
}
