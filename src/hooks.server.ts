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
import { isPublicPath, resolveAuthRedirect } from '$lib/server/request-user';

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
