/**
 * Per-request auth resolution.
 *
 * Phase 1 does NOT add the route guard — that is T2, with the login page and
 * the 303 redirect. This hook only makes `event.locals.user` available so
 * T2 can guard on it. Until T2 lands, every route is still reachable
 * unauthenticated, which is intentional: T1 must not break the app.
 */
import { svelteKitHandler } from 'better-auth/svelte-kit';
import { auth } from '$lib/server/auth';
import type { Handle } from '@sveltejs/kit';

export const handle: Handle = async ({ event, resolve }) => {
	// Better Auth's own endpoints (/api/auth/*) and its session resolution
	// both need the raw Request, so this runs before any of our own logic.
	const preResolved = await svelteKitHandler({ event, resolve, auth, building: false });

	if (preResolved) return preResolved;

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

	return resolve(event);
};
