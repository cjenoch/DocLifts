/**
 * Bounded retry for transient provider answers (owner decision, 2026-11-09,
 * after the first production photo error past PR #65 was an OpenRouter 429
 * that the next calls would have survived).
 *
 * It lives ABOVE `complete()`, not inside it: `complete()` keeps
 * `maxRetries: 0` and its one-request-one-row invariant, and this calls it
 * once per attempt. So each attempt has its own `llm_calls` row, is counted by
 * the per-user hourly cap (a retry the cap refuses is a `refused` /
 * `hourly_cap` row, not a hidden request), and gets its own timeout. It is in
 * llm/ because the classification reads `LlmProviderError`, and the next
 * feature that wants the same rule should not re-spell it.
 *
 * The rule:
 * - Retried: `LlmProviderError` with HTTP 429, 502 or 503, once (two attempts).
 * - Never retried: every other status (401/403 included), network errors,
 *   `LlmRefused`, `LlmSchemaError`, `LlmNotConfigured`, `LlmTimeout` (a timeout
 *   has spent most of the shared budget, so a second attempt could only be
 *   cut short), and anything that is not an `LlmError`.
 * - The wait is the provider's Retry-After when it sent one, else
 *   `baseDelayMs` plus up to `jitterMs` of jitter.
 * - Both attempts and the wait fit inside ONE deadline, `budgetMs` from the
 *   start. When the wait plus `minAttemptMs` would pass it, there is no wait
 *   and no second attempt: the first error is thrown, and it is still
 *   transient, so the caller can offer a manual retry.
 *
 * What is thrown is the LAST attempt's error, unchanged: the caller sees
 * exactly what `llm_calls` recorded last.
 */
import type { Database } from '../progression';
import { LlmProviderError } from './errors';
import type { CompleteRequest, CompleteResult } from './index';

/** The provider answers worth one more try: rate limited, bad gateway, unavailable. */
export const TRANSIENT_HTTP_STATUSES: readonly number[] = [429, 502, 503];

/** The `complete()` signature, so a caller can pass a test double. */
export type CompleteFn = <T>(
	db: Database,
	userId: string,
	request: CompleteRequest<T>
) => Promise<CompleteResult<T>>;

/** True for a provider failure a later call may well survive. */
export function isTransientLlmError(error: unknown): error is LlmProviderError {
	return (
		error instanceof LlmProviderError &&
		error.status !== null &&
		TRANSIENT_HTTP_STATUSES.includes(error.status)
	);
}

/** The same rule over a recorded `llm_calls.error_code` (`http_<status>`). */
export function isTransientErrorCode(code: string | null | undefined): boolean {
	return TRANSIENT_HTTP_STATUSES.some((status) => code === `http_${status}`);
}

export type RetryPolicy = {
	/** The one deadline for every attempt and the wait between them. */
	budgetMs: number;
	/** A second attempt is started only with at least this much budget left after the wait. */
	minAttemptMs: number;
	/** The wait when the provider sent no Retry-After... */
	baseDelayMs: number;
	/** ...plus a random 0 to this, so a burst of failed calls does not come back together. */
	jitterMs: number;
};

export type RetryDeps = {
	/** Default Date.now. */
	now?: () => number;
	/** Default setTimeout. */
	sleep?: (ms: number) => Promise<void>;
	/** Default Math.random. */
	random?: () => number;
	/** Asked before a second attempt; false keeps the first error (e.g. a daily limit reached). */
	beforeRetry?: () => Promise<boolean>;
};

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * `complete()` with at most one retry of a transient provider answer, inside
 * one deadline. Resolves like `complete()`; throws the last attempt's error.
 */
export async function completeWithRetry<T>(
	complete: CompleteFn,
	db: Database,
	userId: string,
	request: CompleteRequest<T>,
	policy: RetryPolicy,
	deps: RetryDeps = {}
): Promise<CompleteResult<T>> {
	const now = deps.now ?? (() => Date.now());
	const deadline = now() + policy.budgetMs;
	const attempt = () =>
		complete(db, userId, {
			...request,
			timeoutMs: Math.min(request.timeoutMs ?? Infinity, deadline - now())
		});
	try {
		return await attempt();
	} catch (first) {
		if (!isTransientLlmError(first)) throw first;
		const wait =
			first.retryAfterMs ??
			policy.baseDelayMs + Math.floor((deps.random ?? Math.random)() * policy.jitterMs);
		if (now() + wait + policy.minAttemptMs > deadline) throw first;
		if (deps.beforeRetry && !(await deps.beforeRetry())) throw first;
		await (deps.sleep ?? realSleep)(wait);
		return await attempt();
	}
}
