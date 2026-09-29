import { error, redirect } from '@sveltejs/kit';
import { parseSetCookieHeader, toCookieOptions } from 'better-auth/cookies';
import { auth } from '$lib/server/auth';
import type { Actions, PageServerLoad } from './$types';

/**
 * There is deliberately no `+page.svelte`. Without one, a GET to this route
 * does NOT get a quiet 405 — it reaches render_page and throws
 * `Missing +page.svelte component for route /logout`, which SvelteKit answers
 * with a **500**. (Found by the e2e logout test, not by reading the docs.)
 *
 * So the GET is answered here instead: 405 with an `Allow: POST` header, which
 * is the truthful response for a route that only has actions. No sign-out
 * happens on GET, ever.
 */
export const load: PageServerLoad = async ({ setHeaders }) => {
	setHeaders({ allow: 'POST' });
	error(405, 'This endpoint accepts POST only.');
};

/**
 * Logout — POST only, by design.
 *
 * A GET /logout would let a prefetch, a crawler, or an <img> tag sign the user
 * out. That is why this is a form action and not a link. The `load` below
 * refuses GET with 405, and there is no `+page.svelte`, so nothing here can be
 * rendered or prefetched into a sign-out.
 *
 * The sign-out goes through `auth.api` on the server rather than posting a
 * form at Better Auth's /api/auth/sign-out endpoint. The request shape is then
 * whatever 1.7.6 expects, and the cookie clearing is Better Auth's own rather
 * than something we reimplement against a response header.
 */
export const actions: Actions = {
	default: async ({ request, cookies }) => {
		// `headers` forwards the incoming cookie so Better Auth can identify
		// the session to destroy.
		//
		// `asResponse: true` is required, and its absence is silent. In 1.7.6,
		// dist/api/to-auth-endpoints.mjs:
		//
		//   asResponse: context?.asResponse ?? isRequestLike(context?.request)
		//
		// With no `request` and no explicit flag the endpoint runs, deletes the
		// session row, and writes Set-Cookie to an internal response that is
		// then discarded. The browser keeps its cookie and the user stays
		// signed in. (Same reason as the sign-in action; see there.)
		const result = await auth.api.signOut({
			headers: request.headers,
			asResponse: true
		});

		// Forward Better Auth's own Set-Cookie, PARSED. `cookies.set` takes a
		// cookie NAME, so passing the raw header through creates a cookie
		// literally named `set-cookie` whose value is the whole URL-encoded
		// header — and the browser then sends no `better-auth.session_token` at
		// all. That bug shipped in e117635 and was invisible server-side: the
		// action redirected, only the browser was unauthenticated.
		//
		// Better Auth's own parser and option mapper, so the attribute names
		// (`httponly`, `samesite`, `max-age`) are read by the code that wrote
		// them rather than by a second hand-rolled mapping that can drift.
		// getSetCookie() rather than get(), because sign-out can emit several
		// Set-Cookie headers.
		for (const raw of result.headers.getSetCookie()) {
			for (const [name, attrs] of parseSetCookieHeader(raw)) {
				cookies.set(name, attrs.value, { path: attrs.path || '/', ...toCookieOptions(attrs) });
			}
		}

		redirect(303, '/login');
	}
};
