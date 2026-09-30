/**
 * Per-request auth resolution AND the route guard.
 *
 * ORDERING IS THE WHOLE POINT, so the two concerns are separate handles
 * composed with `sequence` rather than one function that hopes to get it
 * right.
 *
 * In better-auth 1.7.6, dist/integrations/svelte-kit.mjs:
 *
 *   const svelteKitHandler = async ({ auth, event, resolve, building }) => {
 *     if (building) return resolve(event);
 *     const { request, url } = event;
 *     if (isAuthPath(url.toString(), auth.options)) return auth.handler(request);
 *     return resolve(event);              // <-- renders the whole page
 *   };
 *
 * So the earlier single-function shape
 *
 *   const preResolved = await svelteKitHandler({ event, resolve, ... });
 *   if (preResolved) return preResolved;   // <-- always true on a page request
 *   ...guard here...
 *
 * put the guard AFTER the page was already rendered, where it was dead code.
 * Anonymous /history answered 200. With `sequence`, the guard handle runs to
 * completion (or throws a redirect) before the auth handle ever calls
 * resolve, so nothing renders for an unauthenticated visitor.
 *
 * This also fixes the write hole a layout `load` guard always had: a form
 * action executes before any load, so `/gyms?/createGym` from an anonymous
 * POST used to run createGym and only meet the guard on the re-render.
 *
 * `requireUser` still goes in every action (T4). The hook is one `if`; the
 * actions are where the writes happen.
 */
import { svelteKitHandler } from 'better-auth/svelte-kit';
import { building } from '$app/environment';
import { sequence } from '@sveltejs/kit/hooks';
import { redirect, type Handle } from '@sveltejs/kit';
import { auth } from '$lib/server/auth';
import { db } from '$lib/server/db';
import { isPublicPath, resolveAuthRedirect } from '$lib/server/request-user';
import { warnIfNoLoginCapableAccount } from '$lib/server/startup-account-check';

/**
 * The no-login-capable-account warning, fired once.
 *
 * WHY IT RUNS ON THE FIRST REQUEST AND NOT AT BOOT
 * ------------------------------------------------
 * The runtime image installs production dependencies only — no `tsx`, no
 * TypeScript sources — so a boot-time script is not available without changing
 * the image. adapter-node's instrumented server is generated, so there is no
 * entry point to hang this on either.
 *
 * The first request is close enough to boot in practice: the healthcheck is a
 * GET, and the compose healthcheck hits `/` within 10s of the container
 * starting. The warning is therefore in the container log before anyone can
 * see a page, and `docker compose logs web` shows it.
 *
 * Memoized so it cannot repeat per request, and SWALLOWED on failure: an
 * unreachable database here must not stop the app from booting, or a transient
 * blip during a deploy would take the service down. The healthcheck covers
 * that case.
 */
let startupChecked = false;
function checkAccountsOnce(): void {
	if (startupChecked) return;
	startupChecked = true;
	void warnIfNoLoginCapableAccount(db).catch((cause: unknown) => {
		console.error('[startup] account check failed:', cause);
	});
}

/**
 * Authenticated pages must never be cached, by anyone.
 *
 * Found by driving the released build in a real browser: sign in, open
 * /history, log out, press BACK. The browser did not re-request anything — it
 * re-rendered /history from its own cache, showing the user's workouts to
 * someone who had just signed out, with no login form and nothing they could
 * do. The server-side session was already dead (0 rows in auth.session), so
 * this was never a server authz bug: the page was in the browser's
 * back/forward cache and nothing had told it not to keep it.
 *
 * Why the cache was allowed to: SvelteKit's no-store default is a dev-time
 * behaviour, not an adapter-node build guarantee, and nothing here set a
 * header. A response with no Cache-Control is heuristically cacheable.
 *
 * `no-store` rather than `private, no-cache`:
 *   - `private` would stop shared caches but still permits the BACK button
 *     (bfcache) and the browser's own store, which is the actual symptom;
 *   - `no-store` covers all of it, bfcache included.
 *
 * `Vary: Cookie` so a shared cache in front of this app cannot hand one
 * person's /history to another even if the policy above is ever loosened. The
 * session lives in a cookie, so the response genuinely varies on it.
 */
const NO_STORE = { 'cache-control': 'no-store, must-revalidate', vary: 'Cookie' } as const;

/**
 * The guard. Ahead of every render and every form action, for every method.
 *
 * The public-path check runs BEFORE the session lookup, so static assets and
 * `/api/auth/*` do not cost a database round trip per request.
 *
 * The layout's own `load` still resolves the session for /login, which needs
 * to know whether an already-signed-in visitor should bounce to `/`.
 */
const guard: Handle = async ({ event, resolve }) => {
	checkAccountsOnce();

	if (isPublicPath(event.url.pathname)) return resolve(event);

	// Not public, so a session lookup is about to happen either way, and
	// everything rendered from here is private to one account — whether or not
	// the lookup succeeds, since an unauthenticated visitor gets a redirect and
	// a redirect is not worth caching either. See NO_STORE.
	event.setHeaders(NO_STORE);

	const session = await auth.api.getSession({
		headers: event.request.headers,
		// No body: we only read, and passing one would consume the stream
		// that form actions still need.
		returnHeaders: false
	});

	event.locals.auth = auth;
	event.locals.user = session?.user
		? { id: session.user.id, email: session.user.email, name: session.user.name }
		: null;

	if (!event.locals.user) {
		// 303 so the browser re-issues a GET: a redirected POST must not
		// re-run the action it was blocked from.
		const target = resolveAuthRedirect(event.url);
		redirect(303, target === '/login' ? '/login' : `/login?next=${encodeURIComponent(target)}`);
	}

	return resolve(event);
};

const betterAuth: Handle = ({ event, resolve }) =>
	svelteKitHandler({ event, resolve, auth, building });

/**
 * ORDER MATTERS, AND IT IS THE OPPOSITE OF WHAT IT LOOKS LIKE.
 *
 *   sequence(guard, betterAuth)  -- guard wins for allowlisted paths
 *   sequence(betterAuth, guard)  -- correct
 *
 * `guard` returns `resolve(event)` immediately for any path in its public
 * allowlist, and `/api/auth` is in that list. With `guard` first, EVERY
 * /api/auth/* request was answered by SvelteKit's router instead of reaching
 * Better Auth's handler — `svelteKitHandler` never ran at all.
 *
 * That is why /api/auth/* returned an HTML 404 page (x-sveltekit-page: true),
 * not a JSON error, and why the sign-in rate limit could not be exercised
 * against the handler even after the action was re-routed to it.
 *
 * The allowlist entry for /api/auth is still correct and still needed: with
 * betterAuth first it is what stops the guard from demanding a session for
 * Better Auth's own endpoints. But the allowlist is for the GUARD's benefit, not
 * a claim about routing order.
 */
export const handle: Handle = sequence(betterAuth, guard);
