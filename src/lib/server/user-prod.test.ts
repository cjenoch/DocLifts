/**
 * scripts/user-prod.sh, run for real with a fake `docker` on PATH.
 *
 * WHAT IS BEING PROTECTED HERE (2026-10-24)
 * ----------------------------------------
 * The wrapper used to hand the helper container the WHOLE production env file
 * with `--env-file`, so the S3 keys, the OpenRouter key, the Resend key, the
 * other unrelated credentials entered a container that does not need them.
 * It now forwards an explicit allowlist; the auth secret remains required.
 *
 * The allowlist is the non-trivial part. The CLI builds its own auth instance
 * from process.env outside SvelteKit (scripts/user-cli-context.ts ->
 * auth-core.ts), so it must receive the SAME non-secret configuration the
 * server runs with — PUBLIC_ORIGIN, DOCLIFTS_OPEN_SIGNUP,
 * DOCLIFTS_RATE_LIMIT_STORAGE, SESSION_EXPIRES_DAYS, PASSWORD_MIN_LENGTH. The
 * "pass the two secrets" shortcut would silently fall back to the code
 * defaults and let the CLI enforce a different policy than production, which
 * is the drift users.ts and auth-core.ts exist to prevent. These tests assert
 * both halves: the allowed names are forwarded, the forbidden ones are not.
 *
 * No value is ever asserted, and none is printed: the wrapper passes `-e NAME`
 * bare so the value travels through the environment, never through argv.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const WRAPPER = resolve('scripts/user-prod.sh');

/** A fake `docker` that logs argv and succeeds at everything. */
const DOCKER_SHIM = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >>"\${FAKE_LOG:?}"
exit 0
`;

/** Keys the CLI actually reads — the allowlist the wrapper must forward. */
const ALLOWED = [
	'DATABASE_URL',
	'BETTER_AUTH_SECRET',
	'PUBLIC_ORIGIN',
	'DOCLIFTS_OPEN_SIGNUP',
	'DOCLIFTS_RATE_LIMIT_STORAGE',
	'SESSION_EXPIRES_DAYS',
	'PASSWORD_MIN_LENGTH'
];

/** Credentials the helper must never receive again. */
const FORBIDDEN_NAMES = ['S3_', 'OPENROUTER', 'RESEND', 'LLM_'];
const FORBIDDEN_VALUES = ['fixture-s3-secret', 'fixture-llm-key', 'fixture-resend-key'];

const FULL_ENV = [
	'POSTGRES_PASSWORD=fixture-postgres-password',
	'BETTER_AUTH_SECRET=fixture-auth-secret',
	'PUBLIC_ORIGIN=https://doclifts.invalid',
	'DOCLIFTS_OPEN_SIGNUP=0',
	'DOCLIFTS_RATE_LIMIT_STORAGE=database',
	'SESSION_EXPIRES_DAYS=30',
	'PASSWORD_MIN_LENGTH=12',
	'S3_ACCESS_KEY_ID=fixture-s3-key-id',
	'S3_SECRET_ACCESS_KEY=fixture-s3-secret',
	'OPENROUTER_API_KEY=fixture-llm-key',
	'RESEND_API_KEY=fixture-resend-key'
].join('\n');

/** Only the two required secrets: every optional config key is absent. */
const MINIMAL_ENV = [
	'POSTGRES_PASSWORD=fixture-postgres-password',
	'BETTER_AUTH_SECRET=fixture-auth-secret'
].join('\n');

let root: string;
let bin: string;

function run(envFile: string, extra: Record<string, string> = {}) {
	const dir = mkdtempSync(join(root, 'run-'));
	// The wrapper sources the env FILE into its shell and, for `set -a`, a
	// missing key stays missing only if the shell did not already export it.
	// Vitest itself exports BETTER_AUTH_SECRET (vite.config.ts), so a clean
	// operator shell is modelled by dropping these two inherited values — the
	// env file must be the only source.
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PATH: `${bin}:${process.env.PATH ?? ''}`,
		DOCLIFTS_PROD_ENV: envFile,
		FAKE_LOG: join(dir, 'docker-argv.log'),
		...extra
	};
	delete env.BETTER_AUTH_SECRET;
	delete env.POSTGRES_PASSWORD;
	for (const key of ALLOWED) delete env[key];
	return {
		dir,
		result: spawnSync(
			'bash',
			[WRAPPER, 'create', '--email', 'operator@doclifts.invalid', '--password-stdin'],
			{ encoding: 'utf8', input: 'correct-horse-battery\n', env }
		)
	};
}

const argv = (dir: string): string[] =>
	readdirSync(dir)
		.flatMap((e) =>
			e === 'docker-argv.log' ? readFileSync(join(dir, e), 'utf8').trim().split('\n') : []
		)
		.filter(Boolean);

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), 'user-prod-'));
	bin = join(root, 'bin');
	mkdirSync(bin);
	writeFileSync(join(bin, 'docker'), DOCKER_SHIM, { mode: 0o755 });
	writeFileSync(join(root, 'full.env'), FULL_ENV + '\n', { mode: 0o600 });
	writeFileSync(join(root, 'minimal.env'), MINIMAL_ENV + '\n', { mode: 0o600 });
	writeFileSync(join(root, 'no-secret.env'), 'POSTGRES_PASSWORD=fixture-postgres-password\n', {
		mode: 0o600
	});
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('scripts/user-prod.sh', () => {
	it('hands the helper the allowlist and not the whole production env file', () => {
		const { dir, result } = run(join(root, 'full.env'));
		expect(result.status, result.stderr).toBe(0);

		const call = argv(dir).find((line) => line.includes('user:create')) ?? '';
		expect(call, 'no user:create command was issued').not.toBe('');
		expect(call).not.toContain('--env-file');
		for (const key of ALLOWED) {
			expect(call, `${key} must reach the helper`).toContain(`-e ${key}`);
		}
		// One `-e` per allowed key and nothing more: no stray passthrough.
		expect(call.match(/-e /g)).toHaveLength(ALLOWED.length);

		for (const forbidden of FORBIDDEN_NAMES) {
			expect(call, `${forbidden} must not reach the helper`).not.toContain(forbidden);
		}
		for (const value of [...FORBIDDEN_VALUES, 'fixture-postgres-password', 'fixture-auth-secret']) {
			expect(call, 'no value may appear in argv').not.toContain(value);
		}
	});

	it('leaves absent optional settings to the CLI defaults', () => {
		// With no PUBLIC_ORIGIN etc. the CLI keeps its own defaults, so the
		// wrapper must not inject an empty value that would override them.
		const { dir, result } = run(join(root, 'minimal.env'));
		expect(result.status, result.stderr).toBe(0);

		const call = argv(dir).find((line) => line.includes('user:create')) ?? '';
		expect(call).toContain('-e DATABASE_URL');
		expect(call).toContain('-e BETTER_AUTH_SECRET');
		for (const key of [
			'PUBLIC_ORIGIN',
			'DOCLIFTS_OPEN_SIGNUP',
			'DOCLIFTS_RATE_LIMIT_STORAGE',
			'SESSION_EXPIRES_DAYS',
			'PASSWORD_MIN_LENGTH'
		]) {
			expect(call).not.toContain(`-e ${key}`);
		}
		expect(call.match(/-e /g)).toHaveLength(2);
	});

	it('refuses to run without the required secret, before any docker call', () => {
		const { dir, result } = run(join(root, 'no-secret.env'));

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain('BETTER_AUTH_SECRET not set');
		expect(argv(dir).some((line) => line.includes('user:create'))).toBe(false);
	});
});
