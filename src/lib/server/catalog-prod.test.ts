/**
 * scripts/catalog-prod.sh, without running it: it is a production wrapper.
 *
 * The path rules live in scripts/catalog-csv-path.sh so this harness can
 * source ONLY that function in bash, against a throwaway git repository —
 * no docker, no sudo, no database. The wrapper itself is checked as text:
 * that it uses the function, mounts an outside file read-only, and prints its
 * confirmation prompt as a whole line.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const LIB = resolve('scripts/catalog-csv-path.sh');
const WRAPPER = resolve('scripts/catalog-prod.sh');
const CONTAINER_PATH = '/import/catalog.csv';

let dir: string;
let repo: string;
let outside: string;

function git(...args: string[]) {
	const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
	if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
}

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'catalog-prod-'));
	repo = join(dir, 'repo');
	outside = join(dir, 'private');
	mkdirSync(join(repo, 'data', 'catalog'), { recursive: true });
	mkdirSync(outside);
	git('init', '-q');
	git('config', 'user.email', 'test@test.local');
	git('config', 'user.name', 'test');
	writeFileSync(join(repo, 'data/catalog/committed.csv'), 'a,b\n1,2\n');
	writeFileSync(join(repo, 'data/catalog/edited.csv'), 'a,b\n1,2\n');
	git('add', '.');
	git('commit', '-qm', 'fixture');
	writeFileSync(join(repo, 'data/catalog/edited.csv'), 'a,b\n9,9\n');
	writeFileSync(join(repo, 'data/catalog/untracked.csv'), 'a,b\n1,2\n');
	writeFileSync(join(outside, 'snapshot.csv'), 'a,b\n1,2\n');
	writeFileSync(join(outside, 'empty.csv'), '');
	writeFileSync(join(outside, 'locked.csv'), 'a,b\n');
	chmodSync(join(outside, 'locked.csv'), 0o000);
	writeFileSync(join(outside, 'odd:name.csv'), 'a,b\n');
	symlinkSync(join(outside, 'snapshot.csv'), join(dir, 'link.csv'));
});

afterAll(() => {
	chmodSync(join(outside, 'locked.csv'), 0o600);
	rmSync(dir, { recursive: true, force: true });
});

/** Source ONLY the resolver, call it, and report what it set. */
function resolveCsv(arg: string, root = repo) {
	const r = spawnSync(
		'bash',
		[
			'-c',
			'source "$0"; resolve_catalog_csv "$1" "$2"; rc=$?; printf "%s\\n%s\\n%s\\n" "$rc" "$CATALOG_CSV_ARG" "$CATALOG_CSV_MOUNT"',
			LIB,
			arg,
			root
		],
		{ encoding: 'utf8', cwd: dir }
	);
	const [code, csvArg, mount] = r.stdout.split('\n');
	return { code: Number(code), arg: csvArg, mount, stderr: r.stderr.trim() };
}

describe('resolve_catalog_csv', () => {
	it('a committed repo-relative path is passed through unchanged, with no mount', () => {
		expect(resolveCsv('data/catalog/committed.csv')).toEqual({
			code: 0,
			arg: 'data/catalog/committed.csv',
			mount: '',
			stderr: ''
		});
		expect(resolveCsv('./data/catalog/committed.csv')).toMatchObject({
			code: 0,
			arg: './data/catalog/committed.csv',
			mount: ''
		});
	});

	it('the public 2026-09-30 snapshot in this repository still resolves as before', () => {
		expect(
			resolveCsv('data/catalog/equipment_models_seed_2026-09-30.csv', resolve('.'))
		).toMatchObject({
			code: 0,
			arg: 'data/catalog/equipment_models_seed_2026-09-30.csv',
			mount: ''
		});
	});

	it('an absolute path outside the repo is mounted read-only and given to the importer by its container path', () => {
		const file = join(outside, 'snapshot.csv');
		expect(resolveCsv(file)).toEqual({ code: 0, arg: CONTAINER_PATH, mount: file, stderr: '' });
		// A symlink is resolved, so docker mounts the real file.
		expect(resolveCsv(join(dir, 'link.csv'))).toMatchObject({ code: 0, mount: file });
	});

	it('an absolute path inside the repo follows the committed-file rule', () => {
		expect(resolveCsv(join(repo, 'data/catalog/committed.csv'))).toMatchObject({
			code: 0,
			arg: 'data/catalog/committed.csv',
			mount: ''
		});
		const refused = resolveCsv(join(repo, 'data/catalog/untracked.csv'));
		expect(refused).toMatchObject({ code: 1, arg: '', mount: '' });
		expect(refused.stderr).toContain('inside the repository but not committed');
	});

	it.each([
		['data/catalog/untracked.csv', 1, 'inside the repository but not committed'],
		['data/catalog/edited.csv', 1, 'has uncommitted changes'],
		['data/catalog/missing.csv', 1, 'CSV not found in this checkout'],
		['data/catalog', 1, 'not a regular file'],
		['../private/snapshot.csv', 2, "stay inside the repository (no '..')"],
		['data/../../private/snapshot.csv', 2, "no '..'"]
	])('refuses the repo-relative path %s', (arg, code, message) => {
		const r = resolveCsv(arg);
		expect(r).toMatchObject({ code, arg: '', mount: '' });
		expect(r.stderr).toContain(message);
		expect(r.stderr.split('\n')).toHaveLength(1);
	});

	it('refuses a missing, empty, directory or unmountable outside path, each with its reason', () => {
		const cases: [string, number, string][] = [
			[join(outside, 'nope.csv'), 1, 'CSV not found:'],
			[join(outside, 'empty.csv'), 1, 'CSV is empty'],
			[outside, 1, 'not a regular file'],
			[join(outside, 'odd:name.csv'), 2, "contains ':'"]
		];
		for (const [arg, code, message] of cases) {
			const r = resolveCsv(arg);
			expect(r, arg).toMatchObject({ code, arg: '', mount: '' });
			expect(r.stderr, arg).toContain(message);
		}
	});

	it.skipIf(process.getuid?.() === 0)('refuses an unreadable outside file', () => {
		const r = resolveCsv(join(outside, 'locked.csv'));
		expect(r).toMatchObject({ code: 1, arg: '', mount: '' });
		expect(r.stderr).toContain('not readable by');
	});

	it('refuses a call without a path or root', () => {
		expect(resolveCsv('')).toMatchObject({ code: 2 });
		expect(resolveCsv('data/catalog/committed.csv', join(dir, 'no-such-root'))).toMatchObject({
			code: 2
		});
	});
});

describe('scripts/catalog-prod.sh (read, never run)', () => {
	const text = readFileSync(WRAPPER, 'utf8');

	it('resolves its argument with the tested function, before the dump', () => {
		expect(text).toContain('source "${REPO_ROOT}/scripts/catalog-csv-path.sh"');
		expect(text.indexOf('resolve_catalog_csv "$1" "$REPO_ROOT"')).toBeGreaterThan(-1);
		expect(text.indexOf('resolve_catalog_csv "$1"')).toBeLessThan(text.indexOf('pg_dump'));
	});

	it('mounts an outside file read-only at the container path the importer is given', () => {
		expect(text).toContain('-v "${CATALOG_CSV_MOUNT}:${CATALOG_CSV_CONTAINER_PATH}:ro"');
		expect(text).toContain('"${MOUNT_ARGS[@]}"');
		expect(text).toContain('pnpm catalog:import "$CSV" "$@"');
		expect(readFileSync(LIB, 'utf8')).toContain(`CATALOG_CSV_CONTAINER_PATH=${CONTAINER_PATH}`);
	});

	it('keeps the dry run first and the typed IMPORT confirmation', () => {
		expect(text.indexOf('run_import --dry-run')).toBeGreaterThan(-1);
		expect(text.indexOf('run_import --dry-run')).toBeLessThan(text.indexOf('Type IMPORT'));
		expect(text).toContain('if [[ "$answer" != "IMPORT" ]]; then');
	});

	it('prints the confirmation prompt as a whole line, then reads the answer', () => {
		// 2026-10-02: `read -p` prints no newline, and a runner reading line by
		// line hung waiting for the prompt.
		const code = text
			.split('\n')
			.filter((l) => !l.trimStart().startsWith('#'))
			.join('\n');
		expect(code).not.toMatch(/read\s+(-\w+\s+)*-p\b/);
		expect(text).toMatch(/echo "Apply this import to \$\{DB_NAME\}\? Type IMPORT to continue:"\n/);
		expect(text).toMatch(/\nread -r answer/);
	});

	it('the prompt really ends in a newline when printed', () => {
		const line = text.match(/echo "(Apply this import[^"]*)"/)![1];
		const r = spawnSync('bash', ['-c', `DB_NAME=doclifts; echo "${line}"`], { encoding: 'utf8' });
		expect(r.stdout).toBe('Apply this import to doclifts? Type IMPORT to continue:\n');
	});
});
