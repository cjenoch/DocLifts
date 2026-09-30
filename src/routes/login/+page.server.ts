import { fail, redirect } from '@sveltejs/kit';
import { parseSetCookieHeader, toCookieOptions } from 'better-auth/cookies';
import { auth } from '$lib/server/auth';
import { signInViaHandler, SIGN_IN_WINDOW_SECONDS } from '$lib/server/auth-proxy';
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
			return fail(400, { email, error: 'Enter your email and password.', retryAfter: null });
		}

		// Sign-in goes through Better Auth's own HTTP handler, NOT
		// auth.api.signInEmail({ body }).
		//
		// The reason is the rate limiter. onRequestRateLimit runs inside
		// auth.handler (better-auth 1.7.6 dist/api/index.mjs:172), and
		// server-side API calls are documented as NOT rate limited. Calling
		// auth.api directly therefore bypassed the control entirely: measured
		// against this build, 6 consecutive wrong-password POSTs to /login all
		// returned 200 at a configured 3-per-10s limit, with no 429 and no
		// Retry-After. Unlimited password guessing.
		//
		// auth-proxy.ts builds a real Request for /api/auth/sign-in/email and
		// hands it to the handler, carrying x-forwarded-for through — the
		// limiter keys on the client IP and that header is where it reads it
		// from. See that file for why the header is reduced to a single value;
		// a multi-value chain resolves to no IP and silently disables the limit.
		const result = await signInViaHandler(request.headers, { email, password });

		// 429: over the limit. Rendered on /login with the wait, NOT
		// redirected — a redirect would discard the message and bounce the user
		// straight back to a blank form.
		if (result.status === 429) {
			return fail(429, {
				email,
				error: 'Too many sign-in attempts. Try again shortly.',
				// Better Auth 1.7.6 sends no Retry-After on a 429 (measured: the
				// header is null), so fall back to the limiter's own window. The
				// header is still preferred if a future version adds it, because
				// then the library is authoritative and this is not.
				retryAfter: result.headers.get('retry-after') ?? String(SIGN_IN_WINDOW_SECONDS)
				// Every fail() above returns the same key with null, so the
				// action's return type is one shape rather than a union the page
				// component then has to narrow.
			});
		}

		// Any other failure keeps the existing deliberately-vague message:
		// which of email or password was wrong is information an attacker can
		// use, and the user has to fix both anyway.
		if (!result.ok) {
			return fail(400, { email, error: 'That email and password do not match.', retryAfter: null });
		}

		// Forward Better Auth's own Set-Cookie, PARSED. `cookies.set` takes a
		// cookie NAME, so passing the raw header through creates a cookie
		// literally named `set-cookie` whose value is the whole URL-encoded
		// header — and the browser then sends no `better-auth.session_token` at
		// all. That bug shipped in e117635 and was invisible server-side: the
		// action redirected, only the browser was unauthenticated.
		//
		// Better Auth's own parser and option mapper, so the attribute names
		// (`httponly`, `samesite`, `max-age`, `secure`) are read by the code
		// that wrote them rather than by a second hand-rolled mapping that can
		// drift. `secure` in particular is what Tailscale Serve depends on.
		//
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
