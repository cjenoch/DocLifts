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
 * CURRENTLY BLOCKED BY A ZOD VERSION CONFLICT — DO NOT "FIX" THE PROXY FOR THIS
 * ---------------------------------------------------------------------------
 * Calling `auth.handler` reaches Better Auth's IP resolution, which is:
 *
 *   @better-auth/core 1.7.6, dist/utils/ip.mjs
 *     var ipv4Schema = z$1.ipv4();
 *     return z$1.validate(ipv4Schema, ip);
 *
 * `z.validate` exists only in zod >= 4.6. `pnpm why zod` shows TWO copies:
 *
 *   zod@4.4.3   doclifts@0.1.0 (dependencies)      <- package.json says ^4.4.3
 *   zod@4.6.5   @better-auth/core, better-auth, better-call
 *
 * The production build emits `import * as z$1 from 'zod'` for the core package —
 * a BARE specifier, externalized rather than bundled, because the only zod copy
 * in the bundle is 4.6.5 while the import stays external. At runtime that
 * resolves to the app's top-level node_modules/zod, which is 4.4.3, where
 * `validate` is `undefined`. The handler then throws
 * `TypeError: z$1.validate is not a function` and returns a generic
 * `{"type":"error"}` with status 500.
 *
 * The symptom is deliberately obscure: /login returns 500 for EVERY sign-in,
 * including correct credentials, which reads like an auth misconfiguration
 * rather than a dependency resolution problem.
 *
 * The fix is a one-line dependency change — `zod` to `^4.6.5` in package.json,
 * which `pnpm why` shows is safe because DocLifts is the ONLY consumer of
 * 4.4.3. It is NOT made here: dependency changes are the owner's call, and a
 * security fix should not arrive bundled with a lockfile change nobody
 * approved.
 *
 * Verified in the meantime, and both halves matter:
 *   - `node -e "import('zod').then(m => console.log(typeof m.validate))"`
 *       -> "undefined", version 4.4.3
 *   - the 4.6.5 copy under better-auth's own node_modules
 *       -> "function"
 *
 * e2e/rate-limit.e2e.ts is written and will pass once the version is resolved;
 * it is the test that found this and it is the test that proves the fix.
 */

import { env } from '$env/dynamic/private';
import { auth } from './auth';

/**
 * The absolute origin the auth handler should see.
 *
 * Falls back to the dev default so `pnpm dev` and the test harness work with no
 * environment set. In production ORIGIN is required by docker-compose.yml, so
 * this is never guessing there.
 */
function authOrigin(): string {
	return env.PUBLIC_ORIGIN ?? 'http://127.0.0.1:3000';
}

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
	// Required by sign-out: Better Auth reads the session token from here to
	// know which session row to destroy. Without it sign-out "succeeds" and
	// leaves the session alive, which is worse than failing.
	'cookie'
] as const;

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
