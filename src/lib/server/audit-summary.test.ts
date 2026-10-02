import { describe, expect, it } from 'vitest';
import { summarize } from '../../../scripts/audit-summary.mjs';

/** The shape `pnpm audit --prod --json` produces (pnpm 11), trimmed. */
const advisory = (
	id: number,
	module_name: string,
	severity: string,
	paths: string[],
	extra: Record<string, unknown> = {}
) => [
	String(id),
	{
		module_name,
		severity,
		vulnerable_versions: '<1.2.3',
		patched_versions: '>=1.2.3',
		url: `https://github.com/advisories/GHSA-${id}`,
		github_advisory_id: `GHSA-${id}`,
		findings: [{ version: '1.0.0', paths }],
		...extra
	}
];

describe('audit summary (report only)', () => {
	it('lists every finding, most severe first, with package, path and advisory link', () => {
		const out = summarize({
			advisories: Object.fromEntries([
				advisory(1, 'cookie', 'low', ['.>@sveltejs/kit>cookie']),
				advisory(2, 'devalue', 'high', ['.>@sveltejs/kit>devalue', '.>svelte>devalue']),
				advisory(3, 'pkg-c', 'critical', ['.>a>pkg-c'])
			]),
			metadata: {}
		});
		const rows = out.split('\n').filter((l) => /^\| (critical|high|moderate|low) /.test(l));
		expect(rows.map((r) => r.split('|')[2].trim())).toEqual(['pkg-c', 'devalue', 'cookie']);
		expect(out).toContain('`.>@sveltejs/kit>devalue`<br>`.>svelte>devalue`');
		expect(out).toContain('[GHSA-2](https://github.com/advisories/GHSA-2)');
		expect(out).toContain('3 finding(s): 1 critical, 1 high, 1 low.');
	});

	it('the last line says whether a gate at high would fail, and which packages would trigger it', () => {
		const failing = summarize({
			advisories: Object.fromEntries([
				advisory(1, 'devalue', 'high', ['.>x']),
				advisory(2, 'devalue', 'high', ['.>y']),
				advisory(3, 'pkg-c', 'critical', ['.>z']),
				advisory(4, 'cookie', 'moderate', ['.>w'])
			])
		});
		expect(failing.trim().split('\n').at(-1)).toBe('**Would fail at high: yes** (devalue, pkg-c)');
		const passing = summarize({
			advisories: Object.fromEntries([advisory(1, 'cookie', 'moderate', ['.>w'])])
		});
		expect(passing.trim().split('\n').at(-1)).toBe('**Would fail at high: no**');
	});

	it('no findings: says so, and would not fail', () => {
		const out = summarize({ advisories: {}, metadata: {} });
		expect(out).toContain('No known vulnerabilities');
		expect(out.trim().split('\n').at(-1)).toBe('**Would fail at high: no**');
	});

	it('keeps a table cell intact when a field contains a pipe, and caps long path lists', () => {
		const out = summarize({
			advisories: Object.fromEntries([
				advisory(1, 'a|b', 'high', ['.>1', '.>2', '.>3', '.>4', '.>5'])
			])
		});
		expect(out).toContain('a\\|b');
		expect(out).toContain('+2 more');
	});
});
