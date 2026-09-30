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

export const handle: Handle = sequence(guard, betterAuth);
