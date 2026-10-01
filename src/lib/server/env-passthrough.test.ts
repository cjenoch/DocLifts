/**
 * scripts/check-env-passthrough.sh and its use in scripts/compose-prod.sh.
 *
 * The 0.2.2 deploy: `LOGIN_MAX_FAILURES=0` sat in the env file, compose had no
 * passthrough line for it, the container ran the default ceiling of 10, and
 * every check passed. These run the real scripts in bash — with a FAKE `docker`
 * on PATH that only records whether it was called, so nothing here touches a
 * real Compose stack.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { THROTTLE_ENV } from './login-throttle';
import { LLM_DEFAULTS, LLM_ENV } from './llm/config';

const CHECK = resolve('scripts/check-env-passthrough.sh');
const COMPOSE_PROD = resolve('scripts/compose-prod.sh');

/** Every key production's env file is documented to carry today. */
const PRODUCTION_KEYS = [
	'POSTGRES_PASSWORD',
	'BETTER_AUTH_SECRET',
	'PUBLIC_ORIGIN',
	'SESSION_EXPIRES_DAYS',
	'PASSWORD_MIN_LENGTH',
	...Object.values(THROTTLE_ENV),
	// 0.3.1: the owner adds at least OPENROUTER_API_KEY and LLM_MODEL.
	...Object.values(LLM_ENV)
];

let dir: string;
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'env-passthrough-'));
	// A fake docker that records its arguments and succeeds.
	writeFileSync(join(dir, 'docker'), `#!/usr/bin/env bash\necho "$@" > "${dir}/docker-called"\n`);
	chmodSync(join(dir, 'docker'), 0o755);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const envFile = (name: string, body: string): string => {
	const path = join(dir, name);
	writeFileSync(path, body);
	return path;
};

const check = (env: string) => spawnSync('bash', [CHECK, env], { encoding: 'utf8' });

describe('check-env-passthrough.sh', () => {
	it('passes the full production key set against the real docker-compose.yml', () => {
		const env = envFile('prod.env', PRODUCTION_KEYS.map((k) => `${k}=x`).join('\n') + '\n');
		const r = check(env);
		expect(r.status, r.stderr).toBe(0);
	});

	it('refuses a key compose never reads, and names it', () => {
		// The 0.2.2 shape: a new tunable in the env file, no line in compose.
		const env = envFile('orphan.env', 'PUBLIC_ORIGIN=x\nLOGIN_SOMETHING_NEW=0\n');
		const r = check(env);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain('LOGIN_SOMETHING_NEW');
		expect(r.stderr).not.toMatch(/^\s+PUBLIC_ORIGIN\b/m);
	});

	it('reads export lines and ignores comments and blanks', () => {
		const env = envFile(
			'shapes.env',
			'# a comment\n\n# NOT_A_KEY=1\nexport PUBLIC_ORIGIN="https://doclifts.invalid"\n  LOGIN_MAX_FAILURES=0\n'
		);
		const r = check(env);
		expect(r.status, r.stderr).toBe(0);
		expect(r.stdout).toContain('all 2 key(s)');
	});
});

describe('LLM variables in docker-compose.yml', () => {
	it('each has a passthrough line whose default matches the code', () => {
		// The same trap as LOGIN_*: compose hands the container its own copy of
		// each default, so a default changed only in code never reaches
		// production. Empty is "unset" in llm/config.ts.
		const compose = readFileSync('docker-compose.yml', 'utf8');
		const expected: Record<string, string> = {
			[LLM_ENV.provider]: LLM_DEFAULTS.provider,
			[LLM_ENV.model]: '',
			[LLM_ENV.visionModel]: '',
			[LLM_ENV.apiKey]: '',
			[LLM_ENV.timeoutMs]: String(LLM_DEFAULTS.timeoutMs),
			[LLM_ENV.maxCallsPerUserPerHour]: String(LLM_DEFAULTS.maxCallsPerUserPerHour),
			[LLM_ENV.storePrompts]: LLM_DEFAULTS.storePrompts ? '1' : '0'
		};
		expect(Object.keys(expected).sort()).toEqual(Object.values(LLM_ENV).sort());
		for (const [name, value] of Object.entries(expected)) {
			const match = compose.match(new RegExp(`\\n\\s+${name}: \\$\\{${name}:-([^}]*)\\}`));
			expect(match, `${name} has no passthrough line in docker-compose.yml`).not.toBeNull();
			expect(match![1], `${name}: compose default vs code default`).toBe(value);
		}
	});
});

describe('compose-prod.sh runs the check before up', () => {
	const run = (env: string, ...args: string[]) => {
		rmSync(join(dir, 'docker-called'), { force: true });
		return spawnSync('bash', [COMPOSE_PROD, ...args], {
			encoding: 'utf8',
			env: {
				...process.env,
				PATH: `${dir}:${process.env.PATH}`,
				DOCLIFTS_PROD_ENV: env,
				DOCLIFTS_BUILD_SHA: 'testsha'
			}
		});
	};
	const dockerCalled = () => existsSync(join(dir, 'docker-called'));

	it('refuses `up` with an orphan key, and never reaches docker', () => {
		const env = envFile('orphan-up.env', 'PUBLIC_ORIGIN=x\nLOGIN_SOMETHING_NEW=0\n');
		const r = run(env, 'up', '-d', '--wait', 'web');
		expect(r.status).not.toBe(0);
		expect(r.stderr).toContain('LOGIN_SOMETHING_NEW');
		expect(dockerCalled(), 'docker must not run when the check fails').toBe(false);
	});

	it('lets a clean `up` through to docker', () => {
		const env = envFile('clean-up.env', PRODUCTION_KEYS.map((k) => `${k}=x`).join('\n') + '\n');
		const r = run(env, 'up', '-d', '--wait', 'web');
		expect(r.status, r.stderr).toBe(0);
		expect(readFileSync(join(dir, 'docker-called'), 'utf8')).toMatch(/^compose -p doclifts /);
	});

	it('does not block diagnostics: `ps` runs even with an orphan key', () => {
		const env = envFile('orphan-ps.env', 'LOGIN_SOMETHING_NEW=0\n');
		const r = run(env, 'ps');
		expect(r.status, r.stderr).toBe(0);
		expect(dockerCalled()).toBe(true);
	});
});
