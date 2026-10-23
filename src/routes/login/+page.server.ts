import { fail, redirect } from '@sveltejs/kit';
import { parseSetCookieHeader, toCookieOptions } from 'better-auth/cookies';
import { auth } from '$lib/server/auth';
import { signInViaHandler, SIGN_IN_WINDOW_SECONDS } from '$lib/server/auth-proxy';
import { loginWaitFor } from '$lib/server/password-entry';
import { isSafeNext } from '$lib/server/request-user';
import { errorCodeFrom, logLoginAttempt } from '$lib/server/login-attempt-log';
import type { Actions, PageServerLoad } from './$types';

/**
 * The throttle's wait, as the page states it (spec item 4: never a silent
 * wait). Whole seconds, rounded UP, so a sub-second hold reads "1 second" and
 * never "0 seconds"; null when there was no wait at all.
 */
const toSeconds = (ms: number): number | null => (ms > 0 ? Math.ceil(ms / 1000) : null);

/** No throttle wait to report: validation and the refusal never sleep. */
const NO_WAIT = { heldSeconds: null, nextDelaySeconds: null };

export const load: PageServerLoad = async ({ request, url }) => {
	// `locals.user` is NOT set on this route: the guard resolves the session
	// only for non-public paths, and /login is public, so that a page render
	// and every static asset cost no database round trip. The already-signed-in
	// check therefore does its own lookup.
	//
	// This is the one place that pays the lookup deliberately: knowing whether
	// to bounce is the entire purpose of the page.
	const session = await auth.api.getSession({ headers: request.headers, returnHeaders: false });
	const next = url.searchParams.get('next');
	const safeNext = isSafeNext(next) ? next : '/';
	if (session?.user) redirect(303, safeNext);
	return { next: safeNext };
};

export const actions: Actions = {
	default: async ({ request, cookies }) => {
		const form = await request.formData();
		const email = String(form.get('email') ?? '').trim();
		const password = String(form.get('password') ?? '');
		const next = form.get('next');

		if (!email || !password) {
			logLoginAttempt(request, {
				ok: false,
				status: 400,
				reason: 'validation',
				email,
				password
			});
			return fail(400, {
				email,
				error: 'Enter your email and password.',
				retryAfter: null,
				...NO_WAIT
			});
		}

		const result = await signInViaHandler(request.headers, { email, password });
		const wait = loginWaitFor(result);
		const waits = () => ({
			heldSeconds: toSeconds(wait.heldMs),
			nextDelaySeconds: toSeconds(wait.nextDelayMs)
		});

		// 429: over the limit. Rendered on /login with the wait, NOT
		// redirected — a redirect would discard the message and bounce the user
		// straight back to a blank form.
		if (result.status === 429) {
			logLoginAttempt(request, {
				ok: false,
				status: 429,
				reason: 'throttled',
				email,
				password,
				retryAfterS: Number(result.headers.get('retry-after') ?? SIGN_IN_WINDOW_SECONDS),
				keyType: wait.keyType
			});
			return fail(429, {
				email,
				error: 'Too many sign-in attempts. Try again shortly.',
				// Better Auth 1.7.6 sends no Retry-After on a 429 (measured: the
				// header is null), so fall back to the limiter's own window. The
				// header is still preferred if a future version adds it, because
				// then the library is authoritative and this is not.
				retryAfter: result.headers.get('retry-after') ?? String(SIGN_IN_WINDOW_SECONDS),
				...waits()
				// Every fail() above returns the same key with null, so the
				// action's return type is one shape rather than a union the page
				// component then has to narrow.
			});
		}

		// A 403 means a security check rejected the request. The password was
		// never compared, so this is NOT a failed guess: it must not consume
		// throttle budget, and it must not claim the credentials were wrong.
		//
		// Both of those happened, and together they made a correct password
		// unreachable from any browser holding a cookie for this origin. See
		// `signInViaHandler` for the mechanism and the measurement.
		if (!result.ok && result.status === 403) {
			logLoginAttempt(request, {
				ok: false,
				status: result.status,
				reason: 'origin_rejected',
				errorCode: await errorCodeFrom(result),
				email,
				password
			});
			return fail(403, {
				email,
				error:
					'Sign-in was blocked by a security check before your password was checked. This is a bug, not a wrong password.',
				retryAfter: null,
				...waits()
			});
		}

		if (!result.ok && result.status !== 401) {
			logLoginAttempt(request, {
				ok: false,
				status: result.status,
				reason: 'error',
				email,
				password
			});
			return fail(result.status, {
				email,
				error: 'Sign-in could not be completed. Try again shortly.',
				retryAfter: result.headers.get('retry-after'),
				...waits()
			});
		}

		// A credential failure keeps the existing deliberately-vague message:
		// which of email or password was wrong is information an attacker can
		// use, and the user has to fix both anyway.
		if (!result.ok) {
			// The shared password-entry boundary records only 401 as a failure.

			logLoginAttempt(request, {
				ok: false,
				status: result.status,
				reason: 'bad_credentials',
				errorCode: await errorCodeFrom(result),
				email,
				password
			});
			return fail(400, {
				email,
				error: 'That email and password do not match.',
				retryAfter: null,
				...waits()
			});
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

		// Logged LAST, after the cookies are forwarded, so `ok: true` means a
		// session actually exists rather than "the password was right". That
		// distinction is the whole value of the line.
		logLoginAttempt(request, { ok: true, status: result.status, reason: 'ok', email, password });

		for (const raw of result.headers.getSetCookie()) {
			for (const [name, attrs] of parseSetCookieHeader(raw)) {
				cookies.set(name, attrs.value, { path: attrs.path || '/', ...toCookieOptions(attrs) });
			}
		}

		redirect(303, isSafeNext(typeof next === 'string' ? next : null) ? (next as string) : '/');
	}
};
