import { fail, redirect } from '@sveltejs/kit';
import { parseSetCookieHeader, toCookieOptions } from 'better-auth/cookies';
import { auth } from '$lib/server/auth';
import { isSafeNext } from '$lib/server/request-user';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ request }) => {
	// `locals.user` is NOT set on this route: the guard resolves the session
	// only for non-public paths, and /login is public, so that a page render
	// and every static asset cost no database round trip. The already-signed-in
	// check therefore does its own lookup.
	//
	// This is the one place that pays the lookup deliberately: knowing whether
	// to bounce is the entire purpose of the page.
	const session = await auth.api.getSession({ headers: request.headers, returnHeaders: false });
	if (session?.user) redirect(303, '/');
	return {};
};

export const actions: Actions = {
	default: async ({ request, cookies }) => {
		const form = await request.formData();
		const email = String(form.get('email') ?? '').trim();
		const password = String(form.get('password') ?? '');
		const next = form.get('next');

		if (!email || !password) {
			return fail(400, { email, error: 'Enter your email and password.' });
		}

		// Better Auth owns the credential check, the rate limit, and the cookie
		// shape. Do not pre-validate the password length or the email format
		// here: a second, divergent set of rules is a second source of "why
		// won't this let me in". signInEmail also returns the canonical
		// lowercased email, so the session cookie matches what sign-up stored.
		//
		// `asResponse: true` is REQUIRED and its absence is silent. In 1.7.6,
		// dist/api/to-auth-endpoints.mjs:
		//
		//   asResponse: context?.asResponse ?? isRequestLike(context?.request)
		//
		// With no `request` and no explicit flag, the endpoint runs, validates
		// the password, creates the session row — and the Set-Cookie header is
		// written to an internal response that is then DISCARDED. The action
		// still redirects, so the app looks like it worked, and the user is
		// bounced straight back to /login on the next navigation. The session
		// row in `authSessions` is the only evidence it happened.
		const result = await auth.api.signInEmail({
			body: { email, password },
			asResponse: true
		});

		if (!result.ok) {
			// Deliberately vague: which of the two was wrong is information an
			// attacker can use, and the user needs to fix both anyway.
			return fail(400, { email, error: 'That email and password do not match.' });
		}

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
		// getSetCookie() rather than get(), because several Set-Cookie headers
		// can be emitted.
		for (const raw of result.headers.getSetCookie()) {
			for (const [name, attrs] of parseSetCookieHeader(raw)) {
				cookies.set(name, attrs.value, { path: attrs.path || '/', ...toCookieOptions(attrs) });
			}
		}

		redirect(303, isSafeNext(typeof next === 'string' ? next : null) ? (next as string) : '/');
	}
};
