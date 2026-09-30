/**
 * The throttle's own tests, with an injected clock.
 *
 * No real waits anywhere in this file. The whole point of `LoginThrottle`
 * taking a `Clock` is that the sliding window, the delay curve, and the
 * ceiling can be tested exactly rather than by sleeping and hoping — a test
 * that waits 15 minutes to prove a window slides is a test nobody runs.
 */
import { describe, expect, it } from 'vitest';
import {
	DEFAULT_THROTTLE_CONFIG,
	LoginThrottle,
	normalizeEmail,
	throttleConfigFromEnv,
	type ThrottleKey
} from './login-throttle';

const IP: ThrottleKey = { type: 'ip', value: '203.0.113.7' };
const OTHER_IP: ThrottleKey = { type: 'ip', value: '198.51.100.9' };
const EMAIL: ThrottleKey = { type: 'email', value: 'chris@enoch.ai' };
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
		it('is 1s, 2s, 4s, 8s, 8s for failures five through nine', () => {
			const t = new LoginThrottle(DEFAULT_THROTTLE_CONFIG, fakeClock().now);
			const expected = [1000, 2000, 4000, 8000, 8000];
			for (let failures = 5; failures <= 9; failures++) {
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
			expect(LoginThrottle.emailTag('chris@enoch.ai')).not.toContain('chris');
		});
	});

	describe('normalizeEmail', () => {
		it('trims and lowercases', () => {
			expect(normalizeEmail('  Chris@Enoch.AI ')).toBe('chris@enoch.ai');
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

	it('falls back rather than throwing on a malformed value', () => {
		// A typo in an env file must degrade to the shipped numbers. Refusing
		// every sign-in, or silently dropping protection, are both worse.
		expect(throttleConfigFromEnv({ LOGIN_MAX_FAILURES: 'lots' }).maxFailures).toBe(
			DEFAULT_THROTTLE_CONFIG.maxFailures
		);
		expect(throttleConfigFromEnv({ LOGIN_DELAY_BASE_MS: '-5' }).delayBaseMs).toBe(
			DEFAULT_THROTTLE_CONFIG.delayBaseMs
		);
		expect(throttleConfigFromEnv({ LOGIN_MAX_FAILURES: '' }).maxFailures).toBe(
			DEFAULT_THROTTLE_CONFIG.maxFailures
		);
	});
});
