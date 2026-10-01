/**
 * What the served build does with its configuration at boot.
 *
 * Two promises, both about the gap between the env file and the running
 * process, which is where the 0.2.2 deploy went wrong (`LOGIN_MAX_FAILURES=0`
 * in the file, a ceiling of 10 in the container, every check green):
 *
 *   1. the values in force are logged once at startup, under their env names;
 *   2. a malformed value stops the server BEFORE it listens, instead of being
 *      quietly replaced by a default.
 *
 * These are served-build tests on purpose. Route modules load lazily, so a
 * throw in login-throttle.ts alone would surface on the first sign-in, not at
 * boot; it is `hooks.server.ts` importing the throttle, plus its `init` hook,
 * that moves both to startup. Only a real process start can show that.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb } from '$lib/server/test-db';
import { startTestServer } from '$lib/server/test-auth-helpers';

let harness: Awaited<ReturnType<typeof setupTestDb>>;

// Applies the migrations: a server against an empty database never answers.
beforeAll(async () => {
	harness = await setupTestDb();
}, 60_000);

afterAll(async () => {
	await harness?.end();
});

/** The `login_config` lines in a server log, parsed. */
function configLines(log: string): Array<Record<string, unknown>> {
	return log
		.split('\n')
		.filter((l) => l.includes('"event":"login_config"'))
		.map((l) => JSON.parse(l.slice(l.indexOf('{'))) as Record<string, unknown>);
}

describe('the effective throttle configuration is logged once at startup', () => {
	it('logs the defaults when nothing is set, including the 30s delay cap', async () => {
		const { stop, log } = await startTestServer();
		try {
			const lines = configLines(log());
			expect(lines, 'exactly one login_config line at startup').toHaveLength(1);
			expect(lines[0]).toMatchObject({
				LOGIN_MAX_FAILURES: 10,
				LOGIN_DELAY_MAX_MS: 30_000,
				ceiling: 'enabled'
			});
		} finally {
			await stop();
		}
	});

	it('logs what the env actually set, so 0 reads as a disabled ceiling', async () => {
		const { stop, log } = await startTestServer({
			LOGIN_MAX_FAILURES: '0',
			LOGIN_DELAY_MAX_MS: '45000'
		});
		try {
			const [line] = configLines(log());
			expect(line).toMatchObject({
				LOGIN_MAX_FAILURES: 0,
				LOGIN_DELAY_MAX_MS: 45_000,
				ceiling: 'disabled'
			});
		} finally {
			await stop();
		}
	});
});

describe('a malformed value stops the server at boot', () => {
	it('refuses to start on a non-numeric value, and names it', async () => {
		// startTestServer rejects with the child's last 40 lines when it exits
		// early, so the reason must be IN that rejection — not just "exited".
		await expect(startTestServer({ LOGIN_DELAY_MAX_MS: 'lots' })).rejects.toThrow(
			/server exited early[\s\S]*LOGIN_DELAY_MAX_MS="lots"/
		);
	});

	it('refuses to start with PASSWORD_MIN_LENGTH below the floor of 8, and names it', async () => {
		// createAuth runs when hooks.server.ts imports auth.ts, so this is a
		// boot failure, not a first-request one.
		await expect(startTestServer({ PASSWORD_MIN_LENGTH: '7' })).rejects.toThrow(
			/server exited early[\s\S]*PASSWORD_MIN_LENGTH="7"/
		);
	});

	it('refuses to start on a negative value, and names it', async () => {
		await expect(startTestServer({ LOGIN_MAX_FAILURES: '-1' })).rejects.toThrow(
			/server exited early[\s\S]*LOGIN_MAX_FAILURES="-1"/
		);
	});
});
