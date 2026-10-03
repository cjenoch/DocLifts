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
import { clientIpFrom } from './client-ip';

/** Why an attempt ended the way it did. */
export type LoginAttemptReason =
	| 'ok'
	| 'bad_credentials'
	| 'validation'
	| 'throttled'
	/**
	 * The request was rejected by a security check before the password was ever
	 * compared. `status` is 403.
	 *
	 * RESTORED DELIBERATELY. This variant was in the original spec, then I
	 * deleted it as dead code because nothing produced it. The thing nothing
	 * produced it was the bug: every proxy failure was labelled
	 * `bad_credentials`, so a CSRF rejection displayed as "that email and
	 * password do not match" and counted toward the lockout. Whoever adds a
	 * variant now adds the call site and the test in the same commit.
	 */
	| 'origin_rejected'
	| 'error';

export type LoginAttemptErrorCode =
	| 'MISSING_OR_NULL_ORIGIN'
	| 'INVALID_ORIGIN'
	| 'CROSS_SITE_NAVIGATION_LOGIN_BLOCKED'
	| 'INVALID_EMAIL_OR_PASSWORD'
	| 'INVALID_CALLBACK_URL'
	| 'INVALID_REDIRECT_URL';

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
	/**
	 * Better Auth's own error code, when the handler returned one.
	 *
	 * Added after a 403 cost an evening: the log said `bad_credentials` for a
	 * rejection that had never compared a password, and the page said the same.
	 * With the code present, a production 403 is diagnosed from one line —
	 * `MISSING_OR_NULL_ORIGIN` versus `INVALID_EMAIL_OR_PASSWORD` are
	 * different bugs with different fixes, and both previously rendered as
	 * "that email and password do not match".
	 *
	 * The union below documents the codes observed so far.
	 *
	 * Deliberately `string` and NOT `LoginAttemptErrorCode`. The union is what
	 * this path is expected to produce; it is not a filter. A code nobody
	 * anticipated is precisely the thing worth seeing, and typing the field as
	 * the union would force a cast at the one place the value comes from
	 * untyped JSON — turning "unknown code" into "no code".
	 */
	errorCode?: string;
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
/**
 * Better Auth's error code from a handler response, or undefined.
 *
 * Read from a CLONE: the body of the proxied response is still needed by the
 * action, and consuming it here would make the failure look like a success.
 *
 * Unknown codes are passed through as-is rather than dropped or coerced to a
 * member of `LoginAttemptErrorCode` — the union is what this code path is
 * expected to produce, not a filter, and a code nobody anticipated is exactly
 * the thing worth seeing in the log.
 */
export async function errorCodeFrom(response: Response): Promise<string | undefined> {
	try {
		const clone = response.clone();
		if (!clone.body) return undefined;
		const body = (await clone.json()) as { code?: unknown };
		return typeof body.code === 'string' ? body.code : undefined;
	} catch {
		// Not JSON, or no body. A missing code must not break the attempt log.
		return undefined;
	}
}

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
			ipHash: shortHash(clientIpFrom(request.headers) ?? 'unknown'),
			emailHash: email ? hashEmail(email) : 'none',
			...describePassword(password),
			uaHash: hashUserAgent(request.headers.get('user-agent'))
		};
		console.log(JSON.stringify({ event: 'login_attempt', ...line }));
	} catch (cause) {
		console.error('[login_attempt] logging failed:', cause);
	}
}
