/**
 * The wrapper's pre-start checks: scripts/check-env-passthrough.sh,
 * scripts/check-trusted-edge.sh, and their use in scripts/compose-prod.sh.
 *
 * The 0.2.2 deploy: `LOGIN_MAX_FAILURES=0` sat in the env file, compose had no
 * passthrough line for it, the container ran the default ceiling of 10, and
 * every check passed. These run the real scripts in bash — with a FAKE `docker`
 * on PATH that only records whether it was called, so nothing here touches a
 * real Compose stack.
 *
 * M1 (2026-10-23) added the second check: a production start must DECLARE which
 * edge overwrites the client-IP header, and the declaration must agree with
 * CLIENT_IP_HEADER. Undeclared is refused on purpose — the deployment is
 * publicly reachable, and "no declaration" was exactly the state in which the
 * app used to hash a client-supplied X-Forwarded-For value into the sign-in
 * throttle, with no visible symptom.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { THROTTLE_ENV } from './login-throttle';
import { LLM_DEFAULTS, LLM_ENV } from './llm/config';
import { PHOTO_DEFAULTS, PHOTO_ENV } from './photos/config';

const CHECK = resolve('scripts/check-env-passthrough.sh');
const CHECK_EDGE = resolve('scripts/check-trusted-edge.sh');
const COMPOSE_PROD = resolve('scripts/compose-prod.sh');

/** Every key production's env file is documented to carry today. */
const PRODUCTION_KEYS = [
	'POSTGRES_PASSWORD',
	'BETTER_AUTH_SECRET',
	'PUBLIC_ORIGIN',
	'SESSION_EXPIRES_DAYS',
	'PASSWORD_MIN_LENGTH',
	// M1 (2026-10-23): the trusted-edge declaration and the header it agrees
	// with. Both are read by docker-compose.yml, so both belong in this list.
	'DOCLIFTS_TRUSTED_EDGE',
	'CLIENT_IP_HEADER',
	...Object.values(THROTTLE_ENV),
	// 0.3.1: the owner adds at least OPENROUTER_API_KEY and LLM_MODEL.
	...Object.values(LLM_ENV),
	// 0.4.0: the S3 bucket and keys, PHOTO_STORE, the limits, BODY_SIZE_LIMIT.
	...Object.values(PHOTO_ENV),
	'BODY_SIZE_LIMIT'
];

/**
 * The documented key set as a file body, with a CONSISTENT edge pair — the
 * shape a real production env file has. `up` refuses an inconsistent pair, so
 * `KEY=x` for every key is not a usable fixture for a start, only for the
 * name-level passthrough check.
 */
function productionEnvLines(edge: 'cloudflare' | 'none' = 'cloudflare'): string {
	const lines = PRODUCTION_KEYS.filter(
		(key) => key !== 'DOCLIFTS_TRUSTED_EDGE' && key !== 'CLIENT_IP_HEADER'
	).map((key) => `${key}=x`);
	lines.push(`DOCLIFTS_TRUSTED_EDGE=${edge}`);
	if (edge === 'cloudflare') lines.push('CLIENT_IP_HEADER=cf-connecting-ip');
	return lines.join('\n') + '\n';
}

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

/** Run the production wrapper with a fake docker; shared by both check suites. */
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

describe('photo variables in docker-compose.yml (0.4.0)', () => {
	it('each has a passthrough line whose default matches the code', () => {
		const compose = readFileSync('docker-compose.yml', 'utf8');
		const expected: Record<string, string> = {
			[PHOTO_ENV.store]: PHOTO_DEFAULTS.store,
			[PHOTO_ENV.s3Endpoint]: '',
			[PHOTO_ENV.s3Region]: '',
			[PHOTO_ENV.s3Bucket]: '',
			[PHOTO_ENV.s3AccessKeyId]: '',
			[PHOTO_ENV.s3SecretAccessKey]: '',
			[PHOTO_ENV.maxBytes]: String(PHOTO_DEFAULTS.maxBytes),
			[PHOTO_ENV.dailyLimit]: String(PHOTO_DEFAULTS.dailyLimit)
		};
		expect(Object.keys(expected).sort()).toEqual(Object.values(PHOTO_ENV).sort());
		for (const [name, value] of Object.entries(expected)) {
			const match = compose.match(new RegExp(`\\n\\s+${name}: \\$\\{${name}:-([^}]*)\\}`));
			expect(match, `${name} has no passthrough line in docker-compose.yml`).not.toBeNull();
			expect(match![1], `${name}: compose default vs code default`).toBe(value);
		}
	});

	it('BODY_SIZE_LIMIT is 12M in the web service, above PHOTO_MAX_BYTES', () => {
		// adapter-node's 512K default 413s every phone photo before the app
		// sees it; the e2e harness sets the same 12M (test-auth-helpers.ts).
		const compose = readFileSync('docker-compose.yml', 'utf8');
		const match = compose.match(/\n\s+BODY_SIZE_LIMIT: \$\{BODY_SIZE_LIMIT:-([^}]*)\}/);
		expect(match?.[1]).toBe('12M');
		expect(12 * 1024 * 1024).toBeGreaterThan(PHOTO_DEFAULTS.maxBytes);
		expect(readFileSync('src/lib/server/test-auth-helpers.ts', 'utf8')).toContain(
			"BODY_SIZE_LIMIT: '12M'"
		);
	});
});

describe('compose-prod.sh runs the check before up', () => {
	it('refuses `up` with an orphan key, and never reaches docker', () => {
		const env = envFile('orphan-up.env', 'PUBLIC_ORIGIN=x\nLOGIN_SOMETHING_NEW=0\n');
		const r = run(env, 'up', '-d', '--wait', 'web');
		expect(r.status).not.toBe(0);
		expect(r.stderr).toContain('LOGIN_SOMETHING_NEW');
		expect(dockerCalled(), 'docker must not run when the check fails').toBe(false);
	});

	it('lets a clean `up` through to docker', () => {
		const env = envFile('clean-up.env', productionEnvLines());
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

describe('scripts/check-trusted-edge.sh', () => {
	const checkEdge = (body: string) => {
		const env = envFile(`edge-${Math.random().toString(36).slice(2, 8)}.env`, body);
		return spawnSync('bash', [CHECK_EDGE, env], { encoding: 'utf8' });
	};

	it.each([
		['', 1, 'does not declare DOCLIFTS_TRUSTED_EDGE'],
		['DOCLIFTS_TRUSTED_EDGE=\n', 1, 'does not declare DOCLIFTS_TRUSTED_EDGE'],
		['DOCLIFTS_TRUSTED_EDGE=cloudflare\n', 1, 'requires CLIENT_IP_HEADER=cf-connecting-ip'],
		[
			'DOCLIFTS_TRUSTED_EDGE=cloudflare\nCLIENT_IP_HEADER=x-forwarded-for\n',
			1,
			'requires CLIENT_IP_HEADER=cf-connecting-ip'
		],
		[
			'DOCLIFTS_TRUSTED_EDGE=none\nCLIENT_IP_HEADER=cf-connecting-ip\n',
			1,
			'DOCLIFTS_TRUSTED_EDGE=none refuses'
		],
		[
			'DOCLIFTS_TRUSTED_EDGE=cloudflare-tunnel\nCLIENT_IP_HEADER=cf-connecting-ip\n',
			1,
			"must be 'cloudflare' or 'none'"
		],
		['DOCLIFTS_TRUSTED_EDGE=Cloudflare\nCLIENT_IP_HEADER=CF-Connecting-IP\n', 0, ''],
		['export DOCLIFTS_TRUSTED_EDGE="none"\n', 0, '']
	])('reads %j as exit %s', (body, status, message) => {
		const r = checkEdge(body);
		expect(r.status, r.stdout + r.stderr).toBe(status);
		if (message) expect(r.stderr).toContain(message);
	});

	it('resolves the file the way a shell would: the last assignment wins', () => {
		// A stale declaration above a live pair must not be the one that counts.
		const r = checkEdge(
			'DOCLIFTS_TRUSTED_EDGE=cloudflare\nCLIENT_IP_HEADER=cf-connecting-ip\nCLIENT_IP_HEADER=\n'
		);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain('requires CLIENT_IP_HEADER=cf-connecting-ip');
	});

	it('reports bad usage rather than passing', () => {
		expect(spawnSync('bash', [CHECK_EDGE], { encoding: 'utf8' }).status).toBe(2);
		expect(spawnSync('bash', [CHECK_EDGE, '/nonexistent/.env'], { encoding: 'utf8' }).status).toBe(
			2
		);
	});
});

describe('compose-prod.sh refuses a start whose edge declaration is missing or mismatched', () => {
	it('refuses `up` with no declaration, and never reaches docker', () => {
		const env = envFile('edge-missing.env', 'PUBLIC_ORIGIN=x\n');
		const r = run(env, 'up', '-d', '--wait', 'web');
		expect(r.status).not.toBe(0);
		expect(r.stderr).toContain('DOCLIFTS_TRUSTED_EDGE');
		expect(dockerCalled(), 'docker must not run when the check fails').toBe(false);
	});

	it('refuses a cloudflare declaration whose header disagrees, naming the header', () => {
		const env = envFile(
			'edge-mismatch.env',
			'DOCLIFTS_TRUSTED_EDGE=cloudflare\nCLIENT_IP_HEADER=x-forwarded-for\n'
		);
		const r = run(env, 'up', '-d', '--wait', 'web');
		expect(r.status).not.toBe(0);
		expect(r.stderr).toContain('cf-connecting-ip');
		expect(dockerCalled()).toBe(false);
	});

	it('lets both consistent shapes through, and diagnostics stay unblocked', () => {
		const cloudflare = envFile('edge-cloudflare.env', productionEnvLines('cloudflare'));
		expect(run(cloudflare, 'up', '-d', '--wait', 'web').status).toBe(0);
		const none = envFile('edge-none.env', productionEnvLines('none'));
		expect(run(none, 'up', 'web').status).toBe(0);

		// The tailnet-only rollback and a `ps` during an incident both still run.
		const missing = envFile('edge-ps.env', 'PUBLIC_ORIGIN=x\n');
		const ps = run(missing, 'ps');
		expect(ps.status, ps.stderr).toBe(0);
		expect(dockerCalled()).toBe(true);
	});
});
