/**
 * scripts/migrate-prod.sh, run for real, with a fake `docker` on PATH.
 *
 * WHAT IS BEING PROTECTED HERE
 * ----------------------------
 * 1. THE MIGRATION PROCESS GETS ONE VARIABLE (2026-10-23). It used to be given
 *    the whole production env file with `--env-file`, plus an explicit
 *    BETTER_AUTH_SECRET, so the S3 keys, the OpenRouter key and the auth secret
 *    sat in a container that reads none of them. The first test asserts the
 *    argv of the migration `docker run`: `-e DATABASE_URL`, one variable, no
 *    `--env-file`, and none of those secrets even named. Re-adding the
 *    passthrough makes it fail.
 *
 * 2. THE DUMP IS VERIFIED BEFORE IT IS NAMED. The pre-migrate dump is now
 *    written to a hidden temp (0600, umask 077) and promoted only after
 *    `pg_restore --list` has parsed it, so the retained `predeploy-*.dump` set
 *    never contains a half-written file. The tests assert the verification
 *    referred to a temp path, and that only the promoted file survives.
 *
 * 3. A REFUSED RUN KEEPS EVERY EARLIER DUMP. `set -e` plus the prune that runs
 *    only after a successful migration: a failed dump, a failed verification
 *    and a failed migration each leave the retention set alone.
 *
 * 4. THE DATABASE URL IS BUILT FROM THE VARIABLE, NOT A REDACTED-LOOKING
 *    LITERAL. `export DATABASE_URL="postgresql://${DB_USER}:***@..."` reaches
 *    the container as a literal password of `***` and only fails at connect
 *    time, inside a migration. The last test pins the source text so neither a
 *    hand edit nor a copy out of redacted tool output can reintroduce it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
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

const SCRIPT = resolve('scripts/migrate-prod.sh');
const COMPOSE = resolve('docker-compose.yml');
const DAY_MS = 24 * 60 * 60 * 1000;

/** A fake `docker` that logs its arguments and fails only when told to. */
const DOCKER_SHIM = `#!/usr/bin/env bash
set -euo pipefail
args="$*"
printf '%s\\n' "$args" >>"\${FAKE_LOG:?}"
if [[ "$args" == *pg_dump* ]]; then
	printf 'FAKE-CUSTOM-FORMAT-DUMP\\n'
	exit "\${FAKE_DUMP_STATUS:-0}"
fi
if [[ "$args" == *pg_restore* ]]; then exit "\${FAKE_RESTORE_STATUS:-0}"; fi
if [[ "$args" == *db:migrate* ]]; then exit "\${FAKE_MIGRATE_STATUS:-0}"; fi
exit 0
`;

/** Values every test asserts must NOT reach the migration container. */
const ENV_FIXTURE = [
	'POSTGRES_PASSWORD=fixture-postgres-password',
	'BETTER_AUTH_SECRET=fixture-auth-secret',
	'S3_SECRET_ACCESS_KEY=fixture-s3-secret',
	'OPENROUTER_API_KEY=fixture-llm-key',
	'PUBLIC_ORIGIN=https://doclifts.invalid',
	'DOCLIFTS_TRUSTED_EDGE=cloudflare',
	'CLIENT_IP_HEADER=cf-connecting-ip'
].join('\n');

const SECRETS = [
	'fixture-postgres-password',
	'fixture-auth-secret',
	'fixture-s3-secret',
	'fixture-llm-key'
];

let root: string;
let bin: string;
let envFile: string;

function run(extra: Record<string, string> = {}, seedCount = 0) {
	const backupDir = join(root, 'backups', `run-${Math.random().toString(36).slice(2, 8)}`);
	mkdirSync(backupDir, { recursive: true });
	seedDumps(backupDir, seedCount);
	return {
		backupDir,
		result: spawnSync('bash', [SCRIPT], {
			encoding: 'utf8',
			env: {
				...process.env,
				PATH: `${bin}:${process.env.PATH ?? ''}`,
				DOCLIFTS_PROD_ENV: envFile,
				DOCLIFTS_BACKUP_DIR: backupDir,
				DOCLIFTS_KEEP_DUMPS: '1',
				FAKE_LOG: join(backupDir, 'docker-argv.log'),
				...extra
			}
		})
	};
}

const log = (dir: string): string[] =>
	readdirSync(dir)
		.filter((e) => e === 'docker-argv.log')
		.flatMap((e) => readFileSync(join(dir, e), 'utf8').trim().split('\n'))
		.filter(Boolean);

const dumps = (dir: string): string[] =>
	readdirSync(dir).filter((e) => /^predeploy-.*\.dump$/.test(e));
const temps = (dir: string): string[] =>
	readdirSync(dir).filter((e) => e.startsWith('.predeploy-') && e.includes('.tmp'));

/** Pre-existing dumps, the oldest due for pruning, so "did not prune" is visible. */
function seedDumps(dir: string, count: number): void {
	for (let i = 0; i < count; i++) {
		const path = join(dir, `predeploy-2026-01-0${i + 1}T000000Z.dump`);
		writeFileSync(path, 'earlier verified dump', { mode: 0o600 });
		const when = new Date(Date.now() - (count - i) * DAY_MS);
		utimesSync(path, when, when);
	}
}

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), 'migrate-prod-'));
	bin = join(root, 'bin');
	mkdirSync(bin);
	writeFileSync(join(bin, 'docker'), DOCKER_SHIM, { mode: 0o755 });
	envFile = join(root, 'prod.env');
	writeFileSync(envFile, ENV_FIXTURE + '\n', { mode: 0o600 });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('scripts/migrate-prod.sh', () => {
	it('hands the migration container DATABASE_URL and nothing else', () => {
		const { backupDir, result } = run();
		expect(result.status, result.stderr).toBe(0);

		const migrate = log(backupDir).find((line) => line.includes('db:migrate')) ?? '';
		expect(migrate, 'no migration command was issued').not.toBe('');
		expect(migrate).toContain('-e DATABASE_URL');
		// One variable, named. `--env-file` is the shape this replaced: it handed
		// the container every key in production's env file.
		expect(migrate).not.toContain('--env-file');
		expect(migrate.match(/-e /g)).toHaveLength(1);
		for (const forbidden of [
			'BETTER_AUTH_SECRET',
			'S3_',
			'OPENROUTER',
			'LLM_',
			'POSTGRES_PASSWORD',
			'PUBLIC_ORIGIN',
			...SECRETS
		]) {
			expect(migrate, `${forbidden} must not reach the migration process`).not.toContain(forbidden);
		}
	});

	it('verifies the dump under its temporary name, then promotes it', () => {
		const { backupDir, result } = run();
		expect(result.status, result.stderr).toBe(0);

		const verify = log(backupDir).find((line) => line.includes('pg_restore')) ?? '';
		expect(verify, 'the dump was never verified').not.toBe('');
		// Verified where it was written, not at the name the retention set uses:
		// the argv must name a hidden temp, never a bare `*.dump`.
		expect(verify).toContain('.predeploy-');
		expect(verify).toContain('.dump.tmp.');
		expect(verify, 'verification must never read the promoted name').not.toMatch(/\.dump(\s|$)/);

		const promoted = dumps(backupDir);
		expect(promoted).toHaveLength(1);
		expect(statSync(join(backupDir, promoted[0])).mode & 0o777).toBe(0o600);
		expect(statSync(backupDir).mode & 0o777).toBe(0o700);
		expect(temps(backupDir)).toEqual([]);
	});

	it('prunes beyond the retention count only after a successful migration', () => {
		const { backupDir, result } = run({}, 2);
		expect(result.status, result.stderr).toBe(0);
		// KEEP_DUMPS=1 and three dumps on disk: the two older ones are gone.
		expect(dumps(backupDir)).toHaveLength(1);
	});

	it('a failed dump refuses to migrate and keeps the earlier dumps', () => {
		const { backupDir, result } = run({ FAKE_DUMP_STATUS: '1' }, 2);

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain('pre-migrate dump FAILED');
		expect(
			log(backupDir).find((line) => line.includes('db:migrate')),
			'no migration may be attempted without a verified dump'
		).toBeUndefined();
		expect(dumps(backupDir)).toHaveLength(2);
		expect(temps(backupDir)).toEqual([]);
	});

	it('a dump that fails verification is never promoted, and nothing is pruned', () => {
		const { backupDir, result } = run({ FAKE_RESTORE_STATUS: '1' }, 2);

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain('failed verification');
		expect(dumps(backupDir)).toHaveLength(2);
		expect(temps(backupDir)).toEqual([]);
	});

	it('a failed migration exits non-zero, retains the dump and does not prune', () => {
		const { backupDir, result } = run({ FAKE_MIGRATE_STATUS: '1' }, 2);

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain('migration FAILED');
		// The new dump is kept, together with the two the prune would have trimmed
		// had the migration succeeded: a failed run never shortens retention.
		expect(dumps(backupDir)).toHaveLength(3);
		expect(temps(backupDir)).toEqual([]);
	});

	it('builds the database URL from the variable, never a redacted-looking literal', () => {
		// `***` here reaches Postgres as the literal password. It fails only when
		// the migration connects, which is the worst possible time.
		const script = readFileSync(SCRIPT, 'utf8');
		expect(script).toContain(':${POSTGRES_PASSWORD}@');
		expect(script).not.toContain(':***@');

		// Same line in the compose file, same trap, since Compose interpolates it.
		const compose = readFileSync(COMPOSE, 'utf8');
		expect(compose).toContain('postgresql://doclifts:${POSTGRES_PASSWORD:?');
		expect(compose).not.toContain(':***@');
	});
});
