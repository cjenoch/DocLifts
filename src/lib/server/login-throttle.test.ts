/**
 * The throttle's own tests, with an injected clock.
 *
 * No real waits anywhere in this file. The whole point of `LoginThrottle`
 * taking a `Clock` is that the sliding window, the delay curve, and the
 * ceiling can be tested exactly rather than by sleeping and hoping — a test
 * that waits 15 minutes to prove a window slides is a test nobody runs.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
	DEFAULT_THROTTLE_CONFIG,
	LoginThrottle,
	normalizeEmail,
	THROTTLE_ENV,
	throttleConfigFromEnv,
	throttleConfigLogLine,
	type ThrottleKey
} from './login-throttle';

const IP: ThrottleKey = { type: 'ip', value: '203.0.113.7' };
const OTHER_IP: ThrottleKey = { type: 'ip', value: '198.51.100.9' };
const EMAIL: ThrottleKey = { type: 'email', value: 'scratch-test@doclifts.invalid' };
const OTHER_EMAIL: ThrottleKey = { type: 'email', value: 'someone@else.test' };

/** A clock the test drives by hand. */
function fakeClock(start = 1_000_000) {
	let now = start;
	return {
		now: () => now,
		advanceMs: (ms: number) => {
			now += ms;
		},
		advanceSeconds: (s: number) => {
			now += s * 1000;
		}
	};
}

describe('LoginThrottle', () => {
	describe('allow', () => {
		it('allows an unknown key', () => {
			const t = new LoginThrottle(DEFAULT_THROTTLE_CONFIG, fakeClock().now);
			expect(t.check([IP, EMAIL])).toEqual({ kind: 'allow' });
		});
	});

	describe('refusal at exactly MAX_FAILURES', () => {
		it('refuses on the tenth failure, not the ninth and not the eleventh', () => {
			const clock = fakeClock();
			const t = new LoginThrottle(DEFAULT_THROTTLE_CONFIG, clock.now);
			const keys = [IP, EMAIL];

			for (let i = 0; i < 9; i++) {
				t.recordFailure(keys);
				expect(t.check(keys).kind, `after ${i + 1} failures`).toBe(i + 1 >= 5 ? 'delay' : 'allow');
			}

			// The tenth failure is the one that trips it.
			t.recordFailure(keys);
			const decision = t.check(keys);
			expect(decision.kind).toBe('refuse');
			if (decision.kind !== 'refuse') throw new Error('unreachable');
			expect(decision.count).toBe(10);
		});

		it('reports seconds until the OLDEST failure expires, not the whole window', () => {
			const clock = fakeClock();
			const t = new LoginThrottle(DEFAULT_THROTTLE_CONFIG, clock.now);
			const keys = [IP];

			// First failure lands at t0, the rest 100s later.
			t.recordFailure(keys);
			clock.advanceSeconds(100);
			for (let i = 0; i < 9; i++) t.recordFailure(keys);

			// Window is 900s. The oldest expires 800s from now, so the counter
			// drops to 9 and the next attempt is allowed — 100s of waiting, not
			// 900.
			const decision = t.check(keys);
			if (decision.kind !== 'refuse') throw new Error('expected a refusal');
			expect(decision.retryAfterSeconds).toBe(800);
		});

		it('never reports a retry-after of zero', () => {
			const clock = fakeClock();
			const t = new LoginThrottle({ ...DEFAULT_THROTTLE_CONFIG, maxFailures: 1 }, clock.now);
			t.recordFailure([IP]);
			// Advance right up to the boundary: the timestamp is still inside the
			// window by one millisecond, so ceil() would give 0.
			clock.advanceSeconds(0.999);
			const decision = t.check([IP]);
			if (decision.kind !== 'refuse') throw new Error('expected a refusal');
			expect(decision.retryAfterSeconds).toBeGreaterThanOrEqual(1);
		});
	});

	describe('the delay curve', () => {
		it('is 1s, 2s, 4s, 8s, 16s, then the 30s cap, for failures five through eleven', () => {
			const t = new LoginThrottle(DEFAULT_THROTTLE_CONFIG, fakeClock().now);
			const expected = [1000, 2000, 4000, 8000, 16000, 30000, 30000];
			for (let failures = 5; failures <= 11; failures++) {
				expect(t.delayFor(failures), `at ${failures} failures`).toBe(expected[failures - 5]);
			}
		});

		it('is zero below the threshold', () => {
			const t = new LoginThrottle(DEFAULT_THROTTLE_CONFIG, fakeClock().now);
			for (let n = 0; n < 5; n++) {
				expect(t.delayFor(n), `at ${n} failures`).toBe(0);
			}
		});

		it('caps rather than growing without bound', () => {
			const t = new LoginThrottle(DEFAULT_THROTTLE_CONFIG, fakeClock().now);
			// Failure 40 would be 1000 * 2^35 without the cap — and with only an
			// exponent cap and no multiplication guard it becomes Infinity,
			// which as an await() is a hang, not a delay.
			expect(t.delayFor(40)).toBe(DEFAULT_THROTTLE_CONFIG.delayMaxMs);
			expect(t.delayFor(1000)).toBe(DEFAULT_THROTTLE_CONFIG.delayMaxMs);
			expect(Number.isFinite(t.delayFor(100000))).toBe(true);
		});

		it('returns the delay as a decision once the threshold is crossed', () => {
			const clock = fakeClock();
			const t = new LoginThrottle(DEFAULT_THROTTLE_CONFIG, clock.now);
			for (let i = 0; i < 5; i++) t.recordFailure([IP]);
			const decision = t.check([IP]);
			expect(decision.kind).toBe('delay');
			if (decision.kind !== 'delay') throw new Error('unreachable');
			expect(decision.delayMs).toBe(1000);
		});
	});

	describe('success clears', () => {
		it('resets both keys on a successful sign-in', () => {
			const clock = fakeClock();
			const t = new LoginThrottle(DEFAULT_THROTTLE_CONFIG, clock.now);
			const keys = [IP, EMAIL];

			// Nine failures — one short of the ceiling, and well past the delay
			// threshold, so both behaviours are observable.
			for (let i = 0; i < 9; i++) t.recordFailure(keys);
			expect(t.check(keys).kind).toBe('delay');

			t.clear(keys);

			expect(t.check(keys)).toEqual({ kind: 'allow' });
		});

		it('forgets the delay as well as the refusal', () => {
			const clock = fakeClock();
			const t = new LoginThrottle(DEFAULT_THROTTLE_CONFIG, clock.now);
			for (let i = 0; i < 6; i++) t.recordFailure([IP]);
			expect(t.check([IP]).kind).toBe('delay');
			t.clear([IP]);
			expect(t.check([IP]).kind).toBe('allow');
		});
	});

	describe('the window slides', () => {
		it('forgets a failure once it is older than the window', () => {
			const clock = fakeClock();
			const t = new LoginThrottle(DEFAULT_THROTTLE_CONFIG, clock.now);
			t.recordFailure([IP]);

			clock.advanceSeconds(899);
			expect(t.check([IP]).kind).toBe('allow');

			clock.advanceSeconds(2); // now 901s past
			expect(t.check([IP]).kind).toBe('allow');
		});

		it('does not reset on a fixed boundary — a steady stream stays refused', () => {
			const clock = fakeClock();
			const t = new LoginThrottle({ ...DEFAULT_THROTTLE_CONFIG, maxFailures: 4 }, clock.now);

			// Fill past the ceiling, then keep one failure arriving every 100s
			// for well over a full window. Under a fixed-bucket limiter the
			// boundary eventually lines up and everything is let through; a
			// sliding window has no edge to find.
			for (let i = 0; i < 4; i++) t.recordFailure([IP]);
			expect(t.check([IP]).kind).toBe('refuse');

			for (let i = 0; i < 30; i++) {
				clock.advanceSeconds(100);
				t.recordFailure([IP]);
				expect(t.check([IP]).kind, `at step ${i}`).toBe('refuse');
			}
		});
	});

	describe('keys are independent, and both are checked', () => {
		it('refuses on the IP even when the email key is empty', () => {
			const t = new LoginThrottle({ ...DEFAULT_THROTTLE_CONFIG, maxFailures: 3 }, fakeClock().now);
			for (let i = 0; i < 3; i++) t.recordFailure([IP]);
			const decision = t.check([IP, EMAIL]);
			if (decision.kind !== 'refuse') throw new Error('expected a refusal');
			expect(decision.keyType).toBe('ip');
		});

		it('refuses on the email from a different IP — the case per-IP cannot catch', () => {
			const t = new LoginThrottle({ ...DEFAULT_THROTTLE_CONFIG, maxFailures: 3 }, fakeClock().now);
			// A spray: every attempt from a different address, one account.
			const spray = [1, 2, 3].map((n) => ({ type: 'ip' as const, value: `10.0.0.${n}` }));
			for (const key of spray) t.recordFailure([key, EMAIL]);

			const decision = t.check([{ type: 'ip', value: '10.0.0.99' }, EMAIL]);
			if (decision.kind !== 'refuse') throw new Error('expected a refusal');
			// The address is brand new; only the email key can have caught it.
			expect(decision.keyType).toBe('email');
		});

		it('clearing the email does not clear the IP', () => {
			const t = new LoginThrottle({ ...DEFAULT_THROTTLE_CONFIG, maxFailures: 3 }, fakeClock().now);
			for (let i = 0; i < 3; i++) t.recordFailure([IP, EMAIL]);
			t.clear([EMAIL]);
			expect(t.check([IP, EMAIL]).kind).toBe('refuse');
		});
	});

	describe('emailTag', () => {
		it('is stable, and case/whitespace insensitive', () => {
			const a = LoginThrottle.emailTag('Chris@enoch.ai');
			const b = LoginThrottle.emailTag('  chris@ENOCH.ai  ');
			expect(a).toBe(b);
			expect(a).toHaveLength(8);
			expect(a).toMatch(/^[0-9a-f]{8}$/);
		});

		it('differs between accounts', () => {
			expect(LoginThrottle.emailTag('a@x.test')).not.toBe(LoginThrottle.emailTag('b@x.test'));
		});

		it('is not the address', () => {
			expect(LoginThrottle.emailTag('scratch-test@doclifts.invalid')).not.toContain('scratch');
		});
	});

	describe('normalizeEmail', () => {
		it('trims and lowercases', () => {
			expect(normalizeEmail('  Scratch-Test@DocLifts.INVALID ')).toBe(
				'scratch-test@doclifts.invalid'
			);
		});
	});
});

describe('throttleConfigFromEnv', () => {
	it('defaults everything when unset', () => {
		expect(throttleConfigFromEnv({})).toEqual(DEFAULT_THROTTLE_CONFIG);
	});

	it('reads every documented variable', () => {
		expect(
			throttleConfigFromEnv({
				LOGIN_MAX_FAILURES: '3',
				LOGIN_FAILURE_WINDOW_SEC: '30',
				LOGIN_DELAY_AFTER_FAILURES: '2',
				LOGIN_DELAY_BASE_MS: '250',
				LOGIN_DELAY_MAX_MS: '4000'
			})
		).toEqual({
			maxFailures: 3,
			windowSeconds: 30,
			delayAfterFailures: 2,
			delayBaseMs: 250,
			delayMaxMs: 4000
		});
	});

	it('treats an empty value as unset', () => {
		// Compose renders an unset optional variable as an empty string.
		expect(throttleConfigFromEnv({ LOGIN_MAX_FAILURES: '' }).maxFailures).toBe(
			DEFAULT_THROTTLE_CONFIG.maxFailures
		);
	});

	it('rejects a malformed value instead of quietly running the default', () => {
		// 0.2.1 fell back with a warning: the env file said one thing and the
		// process did another. Now it refuses, and names every bad variable at
		// once so one restart is enough to see them all.
		expect(() =>
			throttleConfigFromEnv({ LOGIN_DELAY_MAX_MS: 'lots', LOGIN_DELAY_BASE_MS: '-5' })
		).toThrow(
			/LOGIN_DELAY_MAX_MS="lots".*LOGIN_DELAY_BASE_MS="-5"|LOGIN_DELAY_BASE_MS="-5".*LOGIN_DELAY_MAX_MS="lots"/
		);
		expect(() => throttleConfigFromEnv({ LOGIN_MAX_FAILURES: 'NaN' })).toThrow(
			/LOGIN_MAX_FAILURES/
		);
	});

	it('defaults the delay cap to 30 seconds, with no clamp on a configured value', () => {
		expect(throttleConfigFromEnv({}).delayMaxMs).toBe(30_000);
		// A configured value is taken as written, high or low. A clamp would hide
		// a misconfiguration, which is the opposite of what a tunable is for.
		expect(throttleConfigFromEnv({ LOGIN_DELAY_MAX_MS: '120000' }).delayMaxMs).toBe(120_000);
		expect(throttleConfigFromEnv({ LOGIN_DELAY_MAX_MS: '500' }).delayMaxMs).toBe(500);
	});
});

describe('throttleConfigLogLine', () => {
	it('states the effective values under their env names, and whether the ceiling is on', () => {
		const line = JSON.parse(
			throttleConfigLogLine(throttleConfigFromEnv({ LOGIN_MAX_FAILURES: '0' }))
		) as Record<string, unknown>;
		expect(line).toEqual({
			event: 'login_config',
			LOGIN_MAX_FAILURES: 0,
			LOGIN_FAILURE_WINDOW_SEC: 900,
			LOGIN_DELAY_AFTER_FAILURES: 5,
			LOGIN_DELAY_BASE_MS: 1000,
			LOGIN_DELAY_MAX_MS: 30_000,
			ceiling: 'disabled'
		});
	});
});

describe('docker-compose.yml defaults', () => {
	it('match the code defaults for every throttle variable', () => {
		// Compose repeats each default (`${LOGIN_DELAY_MAX_MS:-8000}`), so a
		// default changed only in code never reaches production: compose hands
		// the container its own copy. That copy is what production runs.
		const compose = readFileSync('docker-compose.yml', 'utf8');
		for (const field of Object.keys(THROTTLE_ENV) as (keyof typeof THROTTLE_ENV)[]) {
			const name = THROTTLE_ENV[field];
			const match = compose.match(new RegExp(`${name}: \\$\\{${name}:-([^}]*)\\}`));
			expect(match, `${name} has no passthrough line in docker-compose.yml`).not.toBeNull();
			expect(Number(match![1]), `${name}: compose default vs code default`).toBe(
				DEFAULT_THROTTLE_CONFIG[field]
			);
		}
	});
});

describe('LOGIN_MAX_FAILURES=0 disables the ceiling', () => {
	/**
	 * THE PERMANENT LOCKOUT THIS EXISTS TO PREVENT
	 * -------------------------------------------
	 * 0.2.2's release notes and runbook both tell the operator to set
	 * LOGIN_MAX_FAILURES=0 in production "so failures slow and never lock".
	 * The ceiling check read `count >= this.config.maxFailures`, which with
	 * maxFailures = 0 is `count >= 0` — TRUE FOR EVERY ATTEMPT, INCLUDING AN
	 * ACCOUNT WITH NO RECORDED FAILURES AT ALL.
	 *
	 * So the change the release asked for would have refused every sign-in on
	 * the tailnet, forever, for the owner of the only account, with no typo
	 * required and no way out. Found by reading the comparison before applying
	 * the config, not by running it.
	 *
	 * These are the tests that would have caught it.
	 */

	// POSITIONAL, not { config, clock }: the constructor takes the config as
	// its first argument. Wrapping it in an object type-checks fine (the excess
	// property is allowed) and then leaves every field `undefined`, which makes
	// this suite fail for a reason that has nothing to do with the ceiling —
	// worth stating because that is exactly how it went wrong the first time.
	const config = { ...DEFAULT_THROTTLE_CONFIG, maxFailures: 0 };
	const keys: ThrottleKey[] = [{ type: 'email', value: 'owner@doclifts.invalid' }];

	it('does not refuse an account with zero recorded failures', () => {
		const t = new LoginThrottle(config, () => 1_000_000);
		expect(t.check(keys).kind).toBe('allow');
	});

	it('with LOGIN_MAX_FAILURES=0 from the env and 100 failures, no attempt is ever refused', () => {
		// Through the PARSER, because that is how production gets the value. A
		// parser that rejected '0' as invalid and fell back to the default of 10
		// passed every test in this file before this one existed — measured by
		// mutating `parsed < 0` to `parsed <= 0`. It is the same shape as the
		// 0.2.2 deploy, where the env file said 0 and the container ran 10.
		const fromEnv = throttleConfigFromEnv({ LOGIN_MAX_FAILURES: '0' });
		expect(fromEnv.maxFailures, "LOGIN_MAX_FAILURES='0' must parse to 0, not a default").toBe(0);

		// A frozen clock keeps every failure inside the window: the worst case.
		const t = new LoginThrottle(fromEnv, () => 1_000_000);

		// EVERY attempt, not just the last: "never refused" is a claim about each
		// of them. Checked before each failure is recorded, as the action does.
		const refusedAt: number[] = [];
		for (let i = 0; i < 100; i++) {
			if (t.check(keys).kind === 'refuse') refusedAt.push(i);
			t.recordFailure(keys);
		}
		expect(refusedAt, 'attempts refused despite the ceiling being disabled').toEqual([]);

		// And it still slows: disabled ceiling, live delay curve.
		const decision = t.check(keys);
		expect(decision.kind).toBe('delay');
		expect(decision.kind === 'delay' && decision.delayMs).toBeGreaterThan(0);
	});

	it('a negative ceiling is refused at startup rather than silently meaning 0', () => {
		// The constructor takes the config positionally, not as an object.
		expect(() => new LoginThrottle({ ...DEFAULT_THROTTLE_CONFIG, maxFailures: -1 })).toThrow();
	});
});
