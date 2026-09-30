/**
 * One structured line per sign-in attempt.
 *
 * WHY THIS EXISTS
 * ---------------
 * On 2026-09-30 the owner was locked out of his own account with a password
 * that verified against the stored hash. The logs could not say why, because
 * the app logged only two things: Better Auth's "Invalid password" warning
 * (which fires on a mismatch) and the throttle's refusals and delays.
 *
 * That left two outcomes indistinguishable. A request that arrived and was
 * rejected looked identical to a request that never arrived at all — and the
 * correct fix for each is completely different. Several hours were spent on the
 * wrong one. Every attempt now produces exactly one line, whatever its
 * outcome, so "did my request arrive and what did it say" is one `grep`.
 *
 * WHAT IS NEVER LOGGED
 * --------------------
 * Not the password. Not the email address. Not the user agent. Each is
 * reduced to a short, stable hash where correlation is needed and an
 * explicit, non-secret signal is enough otherwise:
 *
 *   pw_len        how many characters arrived — the single most useful fact
 *                 when a typed password is rejected, and it says nothing
 *                 about the value
 *   pw_edge_ws    whether the last character is a space. iOS keyboards
 *                 autocorrect put one there constantly, and it is invisible
 *                 on a password field with the text masked. This one flag
 *                 would have diagnosed the worst night immediately.
 *   email_hash    stable across attempts, so one account's history can be
 *                 followed without ever writing the address to disk
 *   ua_hash       the same, for "which browser is failing"
 *
 * `pw_edge_ws` came directly out of the lockout investigation and is the
 * reason this module is not simply a copy of the throttle's log line.
 */

import { createHash } from 'node:crypto';

/** Why an attempt ended the way it did. */
export type LoginAttemptReason =
	| 'ok'
	| 'bad_credentials'
	| 'validation'
	| 'throttled'
	| 'origin'
	| 'error';

export interface LoginAttemptEvent {
	ok: boolean;
	status: number;
	reason: LoginAttemptReason;
	ipHash: string;
	emailHash: string;
	pwLen: number;
	pwEdgeWs: boolean;
	uaHash: string;
	/** Present only when the throttle engaged, so tuning reads from one place. */
	delayMs?: number;
	retryAfterS?: number;
	/** Which key drove a throttle outcome. */
	keyType?: 'ip' | 'email';
}

/** 8 hex chars is enough to correlate and far too short to be a credential. */
function shortHash(value: string): string {
	return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

export function hashEmail(email: string): string {
	return shortHash(email.trim().toLowerCase());
}

export function hashUserAgent(ua: string | null): string {
	return shortHash(ua ?? 'none');
}

/**
 * The two non-secret facts about a submitted password that actually help.
 *
 * `pwEdgeWhitespace` is separate from the length because the two failures look
 * identical on screen — "That email and password do not match" — and only one
 * of them is fixable by looking at what was submitted.
 */
export function describePassword(password: string): { pwLen: number; pwEdgeWs: boolean } {
	return {
		pwLen: password.length,
		pwEdgeWs: password.length > 0 && (password.startsWith(' ') || password.endsWith(' '))
	};
}

/**
 * Emit the line.
 *
 * Deliberately a plain `console.log(JSON.stringify(...))` and not a logger
 * dependency: the runtime image ships production dependencies only, and the
 * line has to be greppable in `docker compose logs web` with no setup.
 *
 * Failures here must never affect a sign-in, so the whole body is wrapped —
 * a logging bug that throws would turn a working login into a 500.
 */
export function logLoginAttempt(
	request: Request,
	fields: Omit<LoginAttemptEvent, 'ipHash' | 'emailHash' | 'pwLen' | 'pwEdgeWs' | 'uaHash'> & {
		email?: string;
		password?: string;
	}
): void {
	try {
		const { email = '', password = '', ...event } = fields;
		const line: LoginAttemptEvent = {
			...event,
			ipHash: shortHash(clientIpFromRequest(request)),
			emailHash: email ? hashEmail(email) : 'none',
			...describePassword(password),
			uaHash: hashUserAgent(request.headers.get('user-agent'))
		};
		console.log(JSON.stringify({ event: 'login_attempt', ...line }));
	} catch (cause) {
		console.error('[login_attempt] logging failed:', cause);
	}
}

/**
 * The client IP, same reduction the throttle uses.
 *
 * Duplicated rather than imported to keep this module free of a dependency on
 * auth-proxy, which imports the auth instance: a logging helper that pulls in
 * the whole auth graph is a liability in a path that runs on every attempt,
 * including failures.
 */
function clientIpFromRequest(request: Request): string {
	const forwarded = request.headers.get('x-forwarded-for');
	if (forwarded) {
		// A multi-value chain resolves to no IP in better-auth and silently
		// disables rate limiting, so take the first entry deliberately.
		const first = forwarded.split(',')[0]?.trim();
		if (first) return first;
	}
	return request.headers.get('x-real-ip') ?? request.headers.get('cf-connecting-ip') ?? 'unknown';
}
