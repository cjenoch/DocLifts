/**
 * Turn a SvelteKit form action into a real HTTP request against
 * `auth.handler`.
 *
 * WHY THIS EXISTS
 * ---------------
 * Better Auth's rate limiter — `onRequestRateLimit`, the thing that stops
 * password guessing — runs INSIDE `auth.handler` (better-auth 1.7.6,
 * dist/api/index.mjs:172, in the router's `onRequest`). Calling
 * `auth.api.signInEmail({ body })` is a server-side API call, which the library
 * documents as deliberately NOT rate limited.
 *
 * `/login`'s action used to do exactly that, so the limiter was inert on the
 * only sign-in path the app has: measured 6 consecutive wrong-password POSTs
 * to `/login` all returned 200, with no 429 and no Retry-After, at a configured
 * limit of 3 per 10 seconds.
 *
 * Two ways to fix it, and why this one:
 *
 *   - Call the limiter directly. It is not exported as public API in 1.7.6, so
 *     this depends on an internal and breaks on upgrade.
 *   - Roll our own counter. Duplicates what the framework already does, and
 *     brings its own storage and its own tests.
 *
 * So the action stops bypassing the handler: it builds a real Request for the
 * auth route and hands it to `auth.handler`, which is the documented, limited
 * path. One code path, not two.
 *
 * THE IP HEADER IS LOAD-BEARING
 * -----------------------------
 * The limiter keys on the client IP, read from `x-forwarded-for`
 * (`advanced.ipAddress.ipAddressHeaders` defaults to exactly that — verified in
 * @better-auth/core 1.7.6 dist/utils/ip.mjs, DEFAULT_IP_HEADERS).
 *
 * Two facts from that same file shape this function:
 *
 *   1. `getIPFromHeader` returns null when the header holds MORE THAN ONE value
 *      and no `trustedProxies` are configured. Null means no IP, and in
 *      production (`isTest() || isDevelopment()` false) a null IP disables rate
 *      limiting for that request. So forwarding the raw header verbatim would
 *      silently disable the very control this file exists to restore, the
 *      moment a proxy appends to the chain instead of overwriting it.
 *
 *   2. The leftmost entry of X-Forwarded-For is client-supplied and therefore
 *      spoofable. Tailscale Serve OVERWRITES the header with the connecting
 *      tailnet node's address, so the single value it sends is trustworthy
 *      here. That is a property of this deployment, not a general one — see
 *      the public-cutover item in the T8 list, which needs `trustedProxies`.
 *
 * Hence: forward ONE value, taken from the left of the chain, and say why.
 *
 * ---------------------------------------------------------------------------
 * A SECOND, LATER DEFECT THIS FILE SURVIVED: the auth route 404'd entirely
 * ---------------------------------------------------------------------------
 * Re-routing the action to `auth.handler` is necessary but not sufficient. The
 * handler is only reached for requests Better Auth recognises as its own:
 *
 *   better-auth 1.7.6, dist/integrations/svelte-kit.mjs
 *     function isAuthPath(url, options) {
 *       const baseURL = new URL(`${options.baseURL}${options.basePath || "/api/auth"}`);
 *       if (_url.origin !== baseURL.origin) return false;
 *       ...
 *     }
 *
 * So with a wrong `baseURL`, EVERY /api/auth/* request falls through to
 * SvelteKit's router and 404s with an HTML page (x-sveltekit-page: true), not
 * a JSON error. That is what the first round of this fix actually measured, and
 * it looked exactly like a missing route.
 *
 * Two causes, both silent, both fixed at the source rather than worked around:
 *
 *   1. `handle` was `sequence(guard, betterAuth)`. The guard returns
 *      `resolve(event)` immediately for any allowlisted path, and `/api/auth` is
 *      allowlisted — so `svelteKitHandler` never ran at all. Order is now
 *      `sequence(betterAuth, guard)`.
 *   2. `auth.ts` read `env.PUBLIC_ORIGIN` from `$env/dynamic/private` at MODULE
 *      SCOPE. That object is populated by SvelteKit's `Server.init()`, which
 *      runs at server startup — after the server entry has already imported
 *      this graph. So it was `{}` and `baseURL` silently fell back to
 *      `http://127.0.0.1:3000`, an origin no request ever carries. Now
 *      `process.env`, with a hard failure in production instead of a fallback.
 *
 * And compose passed the variable only as `ORIGIN`, which adapter-node uses for
 * its own CSRF origin. It is now passed under its real name as well.
 */

import { auth } from './auth';

/**
 * The absolute origin the auth handler should see.
 *
 * `process.env`, not `$env/dynamic/private`: this module is imported at module
 * scope, before SvelteKit's `Server.init()` populates the dynamic env object, so
 * `env.PUBLIC_ORIGIN` would be undefined here no matter what the container had.
 * The reasoning is written out in full in auth.ts — this is the same trap.
 *
 * MUST equal `auth.options.baseURL`. If these two disagree, the proxied request
 * carries an origin that `isAuthPath` will not match against the configured
 * baseURL, and every sign-in 404s. Both read the same variable for that reason.
 */
function authOrigin(): string {
	return process.env.PUBLIC_ORIGIN ?? 'http://127.0.0.1:3000';
}

/**
 * The sign-in rate-limit WINDOW, in seconds.
 *
 * Better Auth 1.7.6 sends NO `Retry-After` header on a 429 — measured against
 * the served build, `headers.get('retry-after')` is `null` on the refused
 * request. So a UI that wants to tell the user how long to wait cannot read it
 * from the response and has to state the window itself.
 *
 * This constant therefore duplicates a library default, which is exactly the
 * kind of copy that drifts. It is exported from ONE place, asserted in
 * e2e/rate-limit.e2e.ts as `WINDOW_SECONDS` measured against the running server,
 * so a Better Auth upgrade that changes the default fails the e2e rather than
 * quietly making this message wrong.
 *
 * Source: better-auth 1.7.6, dist/api/rate-limiter/index.mjs
 *   getDefaultSpecialRules() -> path starts with /sign-in: window 10, max 3
 */
export const SIGN_IN_WINDOW_SECONDS = 10;

/** The auth route, which is `baseURL`'s path + Better Auth's basePath. */
export const SIGN_IN_ROUTE = '/api/auth/sign-in/email';
export const SIGN_OUT_ROUTE = '/api/auth/sign-out';

/**
 * The incoming headers we carry across, and why each one is here.
 *
 * Deliberately NOT a blind copy of the incoming header set: that would hand
 * Better Auth a Host, Origin, and Content-Length describing a different request
 * than the one being made, and would forward anything a client attached for
 * no reason.
 */
const FORWARDED = [
	// The limiter's key. Reduced to a single value — see the file comment.
	'x-forwarded-for',
	// Better Auth builds its own origin check from these; behind Tailscale
	// Serve the socket values are the proxy's, not the browser's.
	'x-forwarded-proto',
	'x-forwarded-host',
	// Per-client identity for audit logging.
	'user-agent',
	// Origin and Referer, on BOTH paths.
	//
	// Better Auth's CSRF middleware validates origin only when the request
	// carries a cookie (origin-check.mjs: `if (headers.has("cookie")) return
	// await validateOrigin(ctx)`), and then requires the origin to match
	// trustedOrigins — which is baseURL. Forwarding both keeps that check
	// ACTIVE AND PASSING against the real origin instead of removing the
	// cookie so it is skipped.
	//
	// This list once deliberately excluded them, with a comment saying
	// forwarding Origin made Better Auth reject sign-in as cross-site. That
	// comment was written when baseURL still fell back to
	// http://127.0.0.1:3000, so the origin it compared against was one no
	// browser ever sends. Once PUBLIC_ORIGIN was fixed that reasoning inverted,
	// and stripping Origin became sufficient to fail every cookie-bearing
	// sign-in with a 403 before the password was checked — which is how the
	// owner was locked out of a correct password.
	//
	// Measured on the served build before this change:
	//   no cookie  -> 200 ok:true
	//   any cookie -> 403, password never compared
	'origin',
	'referer',
	// Required by sign-out: Better Auth reads the session token from here to
	// know which session row to destroy. Without it sign-out "succeeds" and
	// leaves the session alive, which is worse than failing.
	'cookie'
	// `origin` and `referer` are forwarded on BOTH paths. See
	// `forwardedHeaders` for why that changed; it is not a no-op.
] as const;

/**
 * The single client IP for a request, or `null` if it cannot be determined.
 *
 * Deliberately the same value Better Auth's limiter would key on: the leftmost
 * entry of `x-forwarded-for`, reduced to one. `forwardedHeaders` does the same
 * reduction, and the two MUST agree — if the throttle keyed on one IP and the
 * backstop on another, the log would describe a different attacker from the
 * one being refused.
 *
 * `null` is a real possibility and is NOT treated as a distinct bucket. Under
 * Tailscale Serve the header is always present and always single-valued. Behind
 * a proxy that appends rather than overwrites, it would not be — see the
 * `trustedProxies` item in the T8 list.
 */
export function clientIpFrom(headers: Headers): string | null {
	const raw = headers.get('x-forwarded-for');
	if (!raw) return null;
	const first = raw.split(',')[0]?.trim();
	return first ? first : null;
}

/**
 * Build the headers for the proxied auth request.
 *
 * `content-type` is set by the caller because the body is JSON regardless of
 * what the browser sent (a form post is urlencoded).
 */
export function forwardedHeaders(
	incoming: Headers,
	body: { contentType: 'application/json' }
): Headers {
	const out = new Headers({ 'content-type': body.contentType });

	for (const name of FORWARDED) {
		const value = incoming.get(name);
		if (value === null) continue;

		if (name === 'x-forwarded-for') {
			// Exactly one value. See the file comment: a multi-value header
			// resolves to no IP at all, and no IP means no rate limit.
			const first = value.split(',')[0]?.trim();
			if (first) out.set('x-forwarded-for', first);
			continue;
		}

		out.set(name, value);
	}

	return out;
}

/**
 * Proxy a sign-in to Better Auth's own handler.
 *
 * Returns the raw Response so the caller can distinguish the three cases that
 * matter: a session was created, the credentials were refused, or the caller is
 * over the limit.
 */
export async function signInViaHandler(
	incoming: Headers,
	credentials: { email: string; password: string }
): Promise<Response> {
	const url = new URL(SIGN_IN_ROUTE, authOrigin());

	return auth.handler(
		new Request(url, {
			method: 'POST',
			headers: forwardedHeaders(incoming, { contentType: 'application/json' }),
			body: JSON.stringify(credentials)
		})
	);
}

export const CHANGE_PASSWORD_ROUTE = '/api/auth/change-password';

/**
 * Change the signed-in user's password through Better Auth's own handler.
 *
 * `revokeOtherSessions: true` is the whole point. In better-auth 1.7.6
 * (dist/api/routes/update-user.mjs, `changePassword`) it does, in order:
 *
 *   verify currentPassword -> update the hash -> deleteUserSessions(userId)
 *   -> createSession(userId) -> setSessionCookie
 *
 * So every `auth.session` row for the user is deleted — including the one
 * making this request — and the device in use gets a fresh session on the new
 * password, which is spec §2 item 1 exactly. The internal `updatePassword`
 * (what `user:set-password` uses) revokes nothing; this endpoint is the one
 * that does.
 *
 * Through the handler, not `auth.api`, for the same reasons as sign-in: the
 * rate limiter and the origin check both live in the handler, and the session
 * is resolved from the forwarded cookie.
 */
export async function changePasswordViaHandler(
	incoming: Headers,
	passwords: { currentPassword: string; newPassword: string }
): Promise<Response> {
	const url = new URL(CHANGE_PASSWORD_ROUTE, authOrigin());
	return auth.handler(
		new Request(url, {
			method: 'POST',
			headers: forwardedHeaders(incoming, { contentType: 'application/json' }),
			body: JSON.stringify({ ...passwords, revokeOtherSessions: true })
		})
	);
}

/** The same shape for sign-out, so there is one code path and not two. */
export async function signOutViaHandler(incoming: Headers): Promise<Response> {
	const url = new URL(SIGN_OUT_ROUTE, authOrigin());
	return auth.handler(
		new Request(url, {
			method: 'POST',
			headers: forwardedHeaders(incoming, { contentType: 'application/json' }),
			body: JSON.stringify({})
		})
	);
}
