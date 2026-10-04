import { afterEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { docsOnly } from '../../../scripts/ci-scope';

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository() {
	const cwd = mkdtempSync(join(tmpdir(), 'doclifts-ci-'));
	roots.push(cwd);
	const git = (...args: string[]) =>
		execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
	git('init', '-q', '-b', 'main');
	git('config', 'user.email', 'ci-fixture@doclifts.invalid');
	git('config', 'user.name', 'CI fixture');
	const put = (file: string, text = 'fixture\n') => {
		mkdirSync(join(cwd, file, '..'), { recursive: true });
		writeFileSync(join(cwd, file), text);
	};
	const commit = () => {
		git('add', '-A');
		git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
		return git('rev-parse', 'HEAD');
	};
	put('README.md');
	put('src/app.ts');
	const base = commit();
	return { cwd, git, put, commit, base };
}

it('selects lint for the complete Markdown branch, with additions, edits and deletions', () => {
	const r = repository();
	r.git('switch', '-qc', 'docs');
	r.put('README.md', 'Changed\n');
	r.put('docs/a name\nwith newline.md');
	const first = r.commit();
	expect(docsOnly('push', { before: r.base, after: first }, r.cwd)).toBe(true);
	rmSync(join(r.cwd, 'README.md'));
	const head = r.commit();
	expect(docsOnly('push', { before: first, after: head }, r.cwd)).toBe(true);
	// Changes landing on main after the branch split are not part of the PR.
	r.git('switch', '-q', 'main');
	r.put('src/app.ts', 'other branch\n');
	const advancedBase = r.commit();
	expect(
		docsOnly(
			'pull_request',
			{ pull_request: { base: { sha: advancedBase }, head: { sha: head } } },
			r.cwd
		)
	).toBe(true);
});

it('requires the full gate for mixed history, code renames, symlinks and uncertain comparisons', () => {
	const r = repository();
	r.put('src/app.ts', 'changed code\n');
	r.commit();
	r.put('README.md', 'last commit is only docs\n');
	let head = r.commit();
	const pr = () => ({ pull_request: { base: { sha: r.base }, head: { sha: head } } });
	expect(docsOnly('pull_request', pr(), r.cwd)).toBe(false);
	r.git('reset', '--hard', r.base);
	renameSync(join(r.cwd, 'src/app.ts'), join(r.cwd, 'renamed.md'));
	head = r.commit();
	expect(docsOnly('pull_request', pr(), r.cwd)).toBe(false);
	r.git('reset', '--hard', r.base);
	symlinkSync('src/app.ts', join(r.cwd, 'link.md'));
	head = r.commit();
	expect(docsOnly('pull_request', pr(), r.cwd)).toBe(false);
	r.git('reset', '--hard', r.base);
	r.put('src/content.md');
	head = r.commit();
	expect(docsOnly('pull_request', pr(), r.cwd)).toBe(false);
	r.git('reset', '--hard', r.base);
	r.put('README.md', 'docs\n');
	head = r.commit();
	expect(docsOnly('workflow_dispatch', pr(), r.cwd)).toBe(false);
	expect(docsOnly('push', { before: r.base, after: r.base }, r.cwd)).toBe(false);
	expect(docsOnly('push', { before: '0'.repeat(40), after: head }, r.cwd)).toBe(false);
	expect(docsOnly('push', { before: 'f'.repeat(40), after: head }, r.cwd)).toBe(false);
	expect(docsOnly('push', { before: '--help', after: head }, r.cwd)).toBe(false);
});
