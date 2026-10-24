/**
 * scripts/backup-db.sh, run for real, with a fake `docker` on PATH.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The previous version ran `(umask 077; true)` — a subshell that created
 * nothing — so no mode was ever applied: the directory was 0755, and the dump
 * was readable by every account on the host from the moment it was written
 * until a `chmod 600` ran afterwards. Reading the script did not reveal it and
 * neither would any test that only asserted the final mode. So these tests
 * observe the modes WHILE the write is in progress, and assert what survives a
 * failure, an interrupt and a corrupt stream.
 *
 * Nothing here touches a real backup: every run gets its own directory under a
 * temp root, and `docker` is a fixture. Real `gzip`, `mktemp`, `find` and `mv`
 * run, so the atomic-promotion and integrity paths are the shipped ones.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve('scripts/backup-db.sh');
const DAY_MS = 24 * 60 * 60 * 1000;

let root: string;
let bin: string;
let gzipShimDir: string;

/** A fake `docker` whose behaviour the test selects. */
const DOCKER_SHIM = `#!/usr/bin/env bash
set -euo pipefail
case "\${FAKE_DOCKER:-ok}" in
	ok)
		printf 'FAKE-DUMP-LINE\\n'
		;;
	empty)
		;;
	fail)
		printf 'pg_dump: error: connection to server failed\\n' >&2
		exit 1
		;;
	slow)
		printf 'FAKE-DUMP-START\\n'
		: >"\${FAKE_MARKER:?}"
		sleep 1
		printf 'FAKE-DUMP-END\\n'
		;;
	*)
		exit 1
		;;
esac
`;

/**
 * A `gzip` that emits a real gzip stream with its trailer chopped off, i.e. the
 * file a full disk produces. `-t` is delegated to the real gzip so the script's
 * integrity check is the shipped one.
 */
const GZIP_SHIM = `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "-t" ]]; then exec /usr/bin/gzip "$@"; fi
src="\${TMPDIR:-/tmp}/gzip-shim-$$.in"
cat >"\$src"
/usr/bin/gzip -c "\$src" | head -c -4
rm -f "\$src"
`;

/** A directory that does not exist yet, so the script must create it. */
function freshDir(name: string): string {
	return join(root, name, 'doclifts');
}

function envFor(backupDir: string, extra: Record<string, string> = {}) {
	return {
		...process.env,
		PATH: bin + ':' + (process.env.PATH ?? ''),
		DOCLIFTS_BACKUP_DIR: backupDir,
		DOCLIFTS_DB_CONTAINER: 'doclifts-db',
		DOCLIFTS_KEEP_DAYS: '30',
		FAKE_DOCKER: 'ok',
		...extra
	};
}

function modes(dir: string): Record<string, number> {
	const out: Record<string, number> = { dir: statSync(dir).mode & 0o777 };
	for (const entry of readdirSync(dir)) {
		out[entry] = statSync(join(dir, entry)).mode & 0o777;
	}
	return out;
}

function hiddenTemps(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((e) => e.startsWith('.doclifts-') && e.includes('.tmp'));
}

/** Poll until `check` is true, or give up. Throws rather than hanging. */
async function until(check: () => boolean, label: string, ms = 10_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error(`timed out waiting for: ${label}`);
}

function exited(
	child: ChildProcess
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> {
	let stderr = '';
	child.stderr?.on('data', (chunk) => (stderr += String(chunk)));
	return new Promise((resolvePromise) => {
		child.on('exit', (code, signal) => resolvePromise({ code, signal, stderr }));
	});
}

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), 'backup-db-'));
	bin = join(root, 'bin');
	gzipShimDir = join(root, 'gzip-bin');
	mkdirSync(bin);
	mkdirSync(gzipShimDir);
	writeFileSync(join(bin, 'docker'), DOCKER_SHIM, { mode: 0o755 });
	writeFileSync(join(gzipShimDir, 'gzip'), GZIP_SHIM, { mode: 0o755 });
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

// Suite-level timeout: several tests drive a real subprocess through a dump
// that is deliberately mid-write, which takes longer than the 5 s default.
describe('scripts/backup-db.sh', { timeout: 30_000 }, () => {
	it('writes nothing world-readable, even while the dump is being written', async () => {
		const dir = freshDir('modes');
		const marker = join(root, 'modes.started');
		const child = spawn('bash', [SCRIPT], {
			env: envFor(dir, { FAKE_DOCKER: 'slow', FAKE_MARKER: marker })
		});
		const done = exited(child);
		try {
			// Mid-write: the directory the script created, and the temp file the
			// dump is streaming into, are already private.
			await until(
				() => existsSync(marker) && hiddenTemps(dir).length > 0,
				'temp file during write'
			);
			const during = modes(dir);
			expect(during.dir).toBe(0o700);
			const temp = hiddenTemps(dir)[0];
			expect(during[temp]).toBe(0o600);

			const result = await done;
			expect(result.code, result.stderr).toBe(0);

			// After promotion: exactly one dump, private, and its contents are
			// what the container produced (nothing was swapped for a partial).
			const after = modes(dir);
			expect(after.dir).toBe(0o700);
			const dumps = Object.keys(after).filter((e) =>
				/^doclifts-\d{4}-\d{2}-\d{2}\.sql\.gz$/.test(e)
			);
			expect(dumps).toHaveLength(1);
			expect(after[dumps[0]]).toBe(0o600);
			expect(hiddenTemps(dir)).toEqual([]);
			const dump = spawnSync('zcat', [join(dir, dumps[0])], { encoding: 'utf8' });
			expect(dump.stdout).toBe('FAKE-DUMP-START\nFAKE-DUMP-END\n');
		} finally {
			child.kill('SIGKILL');
		}
	});

	it('a failed dump promotes nothing and prunes nothing', async () => {
		const dir = freshDir('failed');
		mkdirSync(dir, { recursive: true });
		// A good dump from today, and one that is 40 days old (due for pruning).
		const todays = join(dir, 'doclifts-2026-01-02.sql.gz');
		writeFileSync(todays, 'existing valid dump', { mode: 0o600 });
		const old = join(dir, 'doclifts-2026-01-01.sql.gz');
		writeFileSync(old, 'old dump beyond the retention window', { mode: 0o600 });
		const old40 = new Date(Date.now() - 40 * DAY_MS);
		utimesSync(old, old40, old40);

		const result = await exited(
			spawn('bash', [SCRIPT], { env: envFor(dir, { FAKE_DOCKER: 'fail' }) })
		);

		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain('backup FAILED');
		// The failure is the point: no new file, no temp left behind, and the
		// existing backups — including the one due for pruning — untouched.
		expect(modes(dir)).toMatchObject({
			'doclifts-2026-01-02.sql.gz': 0o600,
			'doclifts-2026-01-01.sql.gz': 0o600
		});
		expect(hiddenTemps(dir)).toEqual([]);
		expect(readFileSync(todays, 'utf8')).toBe('existing valid dump');
	});

	it('an interrupted run removes its temp and promotes nothing', async () => {
		const dir = freshDir('interrupted');
		const marker = join(root, 'interrupted.started');
		const child = spawn('bash', [SCRIPT], {
			env: envFor(dir, { FAKE_DOCKER: 'slow', FAKE_MARKER: marker })
		});
		const done = exited(child);

		await until(() => existsSync(marker) && hiddenTemps(dir).length > 0, 'temp file during write');
		child.kill('SIGTERM');
		const result = await done;

		// 128 + SIGTERM, not 0: a run that was killed did not take a backup.
		expect(result.code).toBe(143);
		expect(result.signal).toBeNull();
		expect(hiddenTemps(dir)).toEqual([]);
		expect(Object.keys(modes(dir))).toEqual(['dir']);
	});

	it('refuses a dump whose gzip stream is incomplete, keeping the same-day backup', async () => {
		const dir = freshDir('truncated');
		mkdirSync(dir, { recursive: true });
		// Same-day name, so a promotion would replace it.
		const today = new Date().toISOString().slice(0, 10);
		const existing = join(dir, `doclifts-${today}.sql.gz`);
		writeFileSync(existing, 'the good one from this morning', { mode: 0o600 });

		const result = await exited(
			spawn('bash', [SCRIPT], {
				env: {
					...envFor(dir),
					PATH: `${gzipShimDir}:${bin}:${process.env.PATH ?? ''}`
				}
			})
		);

		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain('gzip stream is incomplete');
		expect(readFileSync(existing, 'utf8')).toBe('the good one from this morning');
		expect(hiddenTemps(dir)).toEqual([]);
	});

	it('gives concurrent runs distinct temp files', async () => {
		const dir = freshDir('concurrent');
		const markerA = join(root, 'a.started');
		const markerB = join(root, 'b.started');
		const a = spawn('bash', [SCRIPT], {
			env: envFor(dir, { FAKE_DOCKER: 'slow', FAKE_MARKER: markerA })
		});
		const b = spawn('bash', [SCRIPT], {
			env: envFor(dir, { FAKE_DOCKER: 'slow', FAKE_MARKER: markerB })
		});
		const [doneA, doneB] = [exited(a), exited(b)];

		let mostSeen = 0;
		await until(() => {
			mostSeen = Math.max(mostSeen, hiddenTemps(dir).length);
			return existsSync(markerA) && existsSync(markerB) && mostSeen >= 2;
		}, 'two concurrent temp files');

		// Both succeed: neither run deleted or truncated the other's temp.
		const [resultA, resultB] = await Promise.all([doneA, doneB]);
		expect(resultA.code, resultA.stderr).toBe(0);
		expect(resultB.code, resultB.stderr).toBe(0);
		expect(hiddenTemps(dir)).toEqual([]);
	});

	it('refuses a directory it cannot write, naming the owner problem', async () => {
		const dir = freshDir('unwritable');
		mkdirSync(dir, { recursive: true });
		chmodSync(dir, 0o500);

		const result = await exited(
			spawn('bash', [SCRIPT], { env: envFor(dir, { FAKE_DOCKER: 'ok' }) })
		);

		// root can write regardless of the mode, so only assert the message where
		// the OS actually enforces it.
		if (process.getuid?.() !== 0) {
			expect(result.code).not.toBe(0);
			expect(result.stderr).toContain('not writable by');
			expect(readdirSync(dir)).toEqual([]);
		}
		expect(result.code === 0 || result.stderr.length > 0).toBe(true);
	});
});
