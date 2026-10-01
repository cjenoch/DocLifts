/**
 * Failure-only sign-in throttle.
 *
 * WHY THIS EXISTS INSTEAD OF Better Auth's BUILT-IN LIMITER
 * --------------------------------------------------------
 * `onRequestRateLimit` consumes its bucket BEFORE the credentials are checked,
 * so a SUCCESSFUL sign-in costs the user one of their attempts. Measured on
 * 0.2.0: four correct-password sign-ins 1.3s apart made the fourth return a
 * 429 envelope and sign nobody in. Sign out and straight back in is two
 * requests; a double-tap on a slow phone is two more. A person with a correct
 * password was locked out by their own successful logins.
 *
 * That counter is still left on, far above any human rate, as a volume
 * backstop. See the `customRules` entry in auth-core.ts.
 *
 * WHAT THIS IS
 * ------------
 * A pure, synchronous, injectable-clock state machine. It does not know about
 * HTTP, SvelteKit, Better Auth, or the database, which is what makes it
 * testable with a fake clock instead of real waits.
 *
 * Two keys, both checked: the client IP and the normalized email. Either can
 * refuse. The IP alone cannot stop a spray across many addresses from one
 * host; the email alone cannot stop one address being attacked from many
 * hosts. Together they cover both, and the email key survives the proxy hop
 * only because the address is part of the key, not the log.
 *
 * STORAGE AND ITS LIMITS — READ THIS BEFORE SCALING
 * -------------------------------------------------
 * `Map<key, number[]>` of failure timestamps, pruned on read. In-process, so:
 *
 *   - a restart clears every counter (an operator restart is a free reset —
 *     convenient, and also a hole);
 *   - a second replica gets its own empty counter, so the effective limit
 *     becomes N x MAX_FAILURES;
 *   - the window is a sliding one, not a fixed bucket, so a steady stream of
 *     failures never gets a clean edge to reset against.
 *
 * Before a second replica, move this to a table (a `login_failures` table with
 * (key, at) and the same pruning query) and the semantics stay identical. Do
 * NOT solve it by raising the numbers.
 *
 * THE TUNING INSTRUMENT IS THE LOG
 * -------------------------------
 * One structured line per refusal and per delay (see the caller). Read a month
 * of it and:
 *   - zero refusals: the numbers are too generous; the user never notices.
 *   - refusals on a real person's key: too tight; loosen.
 *   - many failures on one email from scattered IPs: per-account control is
 *     doing the work it exists for.
 */
import { createHash } from 'node:crypto';

/** Tunables. Every one is env-driven; these are the defaults. */
export interface ThrottleConfig {
	/**
	 * Failures per key per window before a refusal.
	 *
	 * ZERO MEANS THE CEILING IS OFF — failures only ever slow, never lock.
	 * Set on the tailnet: one account and one trusted user means a ceiling
	 * reachable by a typo is a self-lockout with no counterparty.
	 */
	maxFailures: number;
	/** Sliding window length, in seconds. */
	windowSeconds: number;
	/** Failure count at which the progressive delay starts. */
	delayAfterFailures: number;
	/** First delay step, in ms. Doubles per additional failure. */
	delayBaseMs: number;
	/**
	 * Ceiling on the delay, in ms. Default 30 s (spec §2 item 3): with the
	 * ceiling disabled, slowing is the only control left, so it has to keep
	 * slowing rather than plateau at a few seconds.
	 */
	delayMaxMs: number;
}

export const DEFAULT_THROTTLE_CONFIG: ThrottleConfig = {
	maxFailures: 10,
	windowSeconds: 900,
	delayAfterFailures: 5,
	delayBaseMs: 1000,
	delayMaxMs: 30_000
};

/** The env variable behind each field. One table, so the log and the parser agree. */
export const THROTTLE_ENV: Record<keyof ThrottleConfig, string> = {
	maxFailures: 'LOGIN_MAX_FAILURES',
	windowSeconds: 'LOGIN_FAILURE_WINDOW_SEC',
	delayAfterFailures: 'LOGIN_DELAY_AFTER_FAILURES',
	delayBaseMs: 'LOGIN_DELAY_BASE_MS',
	delayMaxMs: 'LOGIN_DELAY_MAX_MS'
};

/**
 * Read config from the environment. Unset or empty means the default; anything
 * else must be a non-negative number, or this THROWS.
 *
 * WHY THROW, WHEN THIS USED TO WARN AND FALL BACK
 * ----------------------------------------------
 * 0.2.1 degraded a malformed value to the shipped default with a warning. That
 * is a clamp by another name: the env file says one thing, the process does
 * another, and the only trace is a line nobody reads. It is the same failure as
 * the 0.2.2 deploy, where `LOGIN_MAX_FAILURES=0` sat in the env file while the
 * container ran a ceiling of 10. A tunable that silently ignores its setting is
 * worse than one that refuses to start (owner decision, 0.2.4).
 *
 * `hooks.server.ts` calls this from the `init` hook, so a bad value stops the
 * server at boot — before it listens — rather than on the first sign-in. Every
 * bad variable is reported at once, not one per restart.
 */
export function throttleConfigFromEnv(
	env: Record<string, string | undefined> = process.env
): ThrottleConfig {
	const problems: string[] = [];
	const config = { ...DEFAULT_THROTTLE_CONFIG };
	for (const field of Object.keys(THROTTLE_ENV) as (keyof ThrottleConfig)[]) {
		const name = THROTTLE_ENV[field];
		const raw = env[name];
		if (raw === undefined || raw.trim() === '') continue;
		const parsed = Number(raw);
		if (!Number.isFinite(parsed) || parsed < 0) {
			problems.push(`${name}="${raw}" is not a non-negative number`);
			continue;
		}
		config[field] = parsed;
	}
	if (problems.length) {
		throw new Error(
			`[login-throttle] invalid configuration: ${problems.join('; ')}. ` +
				'Fix the value in the env file, or unset it to use the default.'
		);
	}
	return config;
}

/**
 * The effective configuration as one structured log line, written once at
 * startup so the values in force sit in the log next to the `login_attempt`
 * lines they govern. Keyed by env variable name, so it reads against the env
 * file directly.
 */
export function throttleConfigLogLine(config: ThrottleConfig): string {
	const values = Object.fromEntries(
		(Object.keys(THROTTLE_ENV) as (keyof ThrottleConfig)[]).map((f) => [THROTTLE_ENV[f], config[f]])
	);
	return JSON.stringify({
		event: 'login_config',
		...values,
		ceiling: config.maxFailures === 0 ? 'disabled' : 'enabled'
	});
}

/** The two things a key can be. Never the raw email, never a raw IP in a log. */
export type ThrottleKeyType = 'ip' | 'email';

export type ThrottleKey = { type: ThrottleKeyType; value: string };

/**
 * Normalize an email for keying, matching `createUser` so the throttle and the
 * account store agree on what "the same address" means. Trim + lowercase:
 * `Scratch-Test@doclifts.invalid` and `scratch-test@doclifts.invalid ` are one
 * account and must be one key.
 */
export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

/** A clock, injectable so the tests never wait in real time. */
export type Clock = () => number;

export type ThrottleDecision =
	| { kind: 'allow' }
	| { kind: 'delay'; delayMs: number; keyType: ThrottleKeyType; count: number }
	| { kind: 'refuse'; retryAfterSeconds: number; keyType: ThrottleKeyType; count: number };

/** `now` in ms, injectable for tests. */
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * One structured line per refusal and per delay, and nothing else.
 *
 * This log is the tuning instrument: the numbers in the config were chosen
 * without usage data, and this is how they get corrected. A month with zero
 * refusals means they stand; refusals on a real person's key mean loosen.
 *
 * The email is never logged. `emailTag` is a stable 8-hex-char sha256 prefix,
 * so one account's failures can be correlated across days without the address
 * being written to disk. Neither is the password — that is not in this process
 * at all once the request is proxied.
 */
function logThrottle(line: {
	event: 'login_throttle';
	kind: 'refuse' | 'delay';
	key_type: 'ip' | 'email';
	count: number;
	delay_ms?: number;
	retry_after_s?: number;
}): void {
	console.log(JSON.stringify(line));
}

export type ThrottleKeys = { ip: string | null; email: string };

/**
 * The pre-check the login action runs before touching Better Auth.
 *
 * Returns `refuse` (do not call the proxy at all) or `delay` (wait, then
 * proceed). The delay is server-side on purpose: it costs a guesser the time
 * whether or not their client cooperates.
 *
 * It is NOT silent (spec item 4, 0.2.5). Before 0.2.5 a delayed attempt was
 * indistinguishable from a slow network, on the theory that a guesser should
 * not learn they are being counted. With the ceiling off in production the
 * delay is the only control, and at 30 s a silent wait reads as a hung page to
 * the person it is most likely to hit — the owner, mistyping. So the login
 * action reports the wait it just served and, via `nextLoginDelayMs`, the wait
 * the next attempt will be held for. Neither depends on whether the account
 * exists: both keys count failures for any address, real or not.
 */
export async function checkLoginThrottle(
	throttle: LoginThrottle,
	keys: ThrottleKeys
): Promise<ThrottleDecision> {
	const throttleKeys = buildKeys(keys);
	const decision = throttle.check(throttleKeys);

	if (decision.kind === 'refuse') {
		logThrottle({
			event: 'login_throttle',
			kind: 'refuse',
			key_type: decision.keyType,
			count: decision.count,
			retry_after_s: decision.retryAfterSeconds
		});
		return decision;
	}

	if (decision.kind === 'delay') {
		logThrottle({
			event: 'login_throttle',
			kind: 'delay',
			key_type: decision.keyType,
			count: decision.count,
			delay_ms: decision.delayMs
		});
		await sleep(decision.delayMs);
	}

	return decision;
}

/** The key set for one attempt: an IP when known, and always the email. */
export function buildKeys({ ip, email }: ThrottleKeys): ThrottleKey[] {
	const keys: ThrottleKey[] = [{ type: 'email', value: normalizeEmail(email) }];
	if (ip) keys.push({ type: 'ip', value: ip });
	return keys;
}

/**
 * The delay the NEXT attempt with these keys would be held for, in ms, without
 * serving it, logging it, or recording anything. 0 when the next attempt is
 * allowed straight through — and also when it would be REFUSED, because a
 * refusal answers at once with its own message, so there is no wait to warn of.
 *
 * Read after a failure is recorded, so the page can say how long the next
 * submit will hang before it hangs.
 */
export function nextLoginDelayMs(throttle: LoginThrottle, keys: ThrottleKeys): number {
	const decision = throttle.check(buildKeys(keys));
	return decision.kind === 'delay' ? decision.delayMs : 0;
}

/** Record a failed attempt against every key. */
export function recordLoginFailure(throttle: LoginThrottle, keys: ThrottleKeys): void {
	throttle.recordFailure(buildKeys(keys));
}

/** Clear both keys after a successful sign-in, so successes never accumulate. */
export function clearLoginFailures(throttle: LoginThrottle, keys: ThrottleKeys): void {
	throttle.clear(buildKeys(keys));
}

export class LoginThrottle {
	/** key -> failure timestamps, ascending, pruned on every read. */
	private readonly failures = new Map<string, number[]>();
	private readonly clock: Clock;

	constructor(
		readonly config: ThrottleConfig = DEFAULT_THROTTLE_CONFIG,
		clock?: Clock
	) {
		// A negative ceiling is not "no ceiling": the check below only treats 0
		// as disabled, so -1 would fall through to `count >= -1`, which refuses
		// every attempt — the same permanent lockout as 0, but by accident
		// instead of on purpose. Reject it where it is set rather than letting
		// an env typo become an outage.
		if (config.maxFailures < 0) {
			throw new Error(
				`login throttle: maxFailures must be >= 0 (0 disables the ceiling), got ${config.maxFailures}`
			);
		}
		this.clock = clock ?? (() => Date.now());
	}

	/**
	 * The delay curve. `base * 2^(failures - delayAfter - 1)`, capped.
	 *
	 * At defaults: failures 5..11 -> 1000, 2000, 4000, 8000, 16000, 30000,
	 * 30000. So the first four failures are instant to return, and the cost
	 * arrives only once someone is clearly guessing. The cap matters: without it, failure 20
	 * would sleep for 1000 * 2^15 ms, which is a self-inflicted denial of
	 * service on a shared host.
	 */
	delayFor(failureCount: number): number {
		const { delayAfterFailures, delayBaseMs, delayMaxMs } = this.config;
		if (failureCount < delayAfterFailures) return 0;
		const exponent = failureCount - delayAfterFailures;
		// Cap the exponent before the shift: `2 ** exponent` overflows to
		// Infinity past 1024 and to a wrong value well before that.
		const capped = Math.min(exponent, 31);
		return Math.min(delayBaseMs * 2 ** capped, delayMaxMs);
	}

	/** Failure timestamps for `key`, pruned to the live window. */
	private liveFailures(key: string): number[] {
		const cutoff = this.clock() - this.config.windowSeconds * 1000;
		const stored = this.failures.get(key) ?? [];
		const live = stored.filter((at) => at > cutoff);
		if (live.length === 0) this.failures.delete(key);
		else this.failures.set(key, live);
		return live;
	}

	/**
	 * Decide what to do about a sign-in attempt, BEFORE checking credentials.
	 *
	 * Refusal wins over delay: at the ceiling there is no point sleeping and
	 * then refusing anyway. The refusal reports the seconds until the OLDEST
	 * failure in the window expires, because that is the moment the count first
	 * drops — an accurate number a user can act on, rather than a full window
	 * they have to sit through hoping.
	 */
	check(keys: readonly ThrottleKey[]): ThrottleDecision {
		const counts: { key: ThrottleKey; count: number }[] = keys.map((key) => ({
			key,
			count: this.liveFailures(this.keyId(key)).length
		}));

		// `maxFailures === 0` disables the ceiling. Read literally, `count >=
		// 0` is true for every attempt — including an account with NO recorded
		// failures — so setting LOGIN_MAX_FAILURES=0 would refuse every sign-in
		// forever and lock the owner out of a working password permanently.
		// That is precisely the failure this release exists to end, so the
		// "0 disables" semantics are checked here rather than assumed.
		const atCeiling =
			this.config.maxFailures > 0
				? counts.find(({ count }) => count >= this.config.maxFailures)
				: undefined;
		if (atCeiling) {
			const stored = this.failures.get(this.keyId(atCeiling.key)) ?? [];
			const oldest = stored[0] ?? this.clock();
			const retryAfterMs = Math.max(0, oldest + this.config.windowSeconds * 1000 - this.clock());
			return {
				kind: 'refuse',
				retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
				keyType: atCeiling.key.type,
				count: atCeiling.count
			};
		}

		const delayed = counts
			.map(({ key, count }) => ({ key, count, delayMs: this.delayFor(count) }))
			.filter((c) => c.delayMs > 0)
			// A tight loop against one account should not stack the IP's delay on
			// top of the email's — take the worst once.
			.sort((a, b) => b.delayMs - a.delayMs)[0];
		if (delayed) {
			return {
				kind: 'delay',
				delayMs: delayed.delayMs,
				keyType: delayed.key.type,
				count: delayed.count
			};
		}

		return { kind: 'allow' };
	}

	/** Record one failure against every key. Called ONLY on a failed sign-in. */
	recordFailure(keys: readonly ThrottleKey[]): void {
		const now = this.clock();
		for (const key of keys) {
			const id = this.keyId(key);
			const stored = this.liveFailures(id);
			stored.push(now);
			this.failures.set(id, stored);
		}
	}

	/** Forget every counter for these keys. Called ONLY on a successful sign-in. */
	clear(keys: readonly ThrottleKey[]): void {
		for (const key of keys) this.failures.delete(this.keyId(key));
	}

	/**
	 * A stable, non-reversible tag for an email, for logs that must correlate
	 * one account's history without storing the address. 8 hex chars of
	 * sha256 is 32 bits: enough to group, useless to reverse.
	 */
	static emailTag(email: string): string {
		return createHash('sha256').update(normalizeEmail(email)).digest('hex').slice(0, 8);
	}

	private keyId(key: ThrottleKey): string {
		return `${key.type}:${key.value}`;
	}
}

/**
 * The process-wide throttle, configured from the environment.
 *
 * One instance per process, which is the same scope as the in-memory store —
 * a second instance would have a second store and count nothing.
 */
export const loginThrottle = new LoginThrottle(throttleConfigFromEnv());
