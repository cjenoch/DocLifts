import { fail, redirect } from '@sveltejs/kit';
import { parseSetCookieHeader, toCookieOptions } from 'better-auth/cookies';
import { auth } from '$lib/server/auth';
import { clientIpFrom, signInViaHandler, SIGN_IN_WINDOW_SECONDS } from '$lib/server/auth-proxy';
import {
	checkLoginThrottle,
	clearLoginFailures,
	loginThrottle,
	nextLoginDelayMs,
	recordLoginFailure,
	type ThrottleKeys
} from '$lib/server/login-throttle';
import { isSafeNext } from '$lib/server/request-user';
import { errorCodeFrom, logLoginAttempt } from '$lib/server/login-attempt-log';
import { signupConfig } from '$lib/server/signup-config';
import type { Actions, PageServerLoad } from './$types';

/**
 * The throttle's wait, as the page states it (spec item 4: never a silent
 * wait). Whole seconds, rounded UP, so a sub-second hold reads "1 second" and
 * never "0 seconds"; null when there was no wait at all.
 */
const toSeconds = (ms: number): number | null => (ms > 0 ? Math.ceil(ms / 1000) : null);

/** No throttle wait to report: validation and the refusal never sleep. */
const NO_WAIT = { heldSeconds: null, nextDelaySeconds: null };

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
	return { signupEnabled: signupConfig().enabled };
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

		// Failure-only throttle, BEFORE the proxy call. See login-throttle.ts for
		// why Better Auth's own limiter cannot be the control: it charges
		// successes, so a person signing out and back in with a correct
		// password used to lock themselves out.
		//
		// The password is not checked on the refuse path, so a refusal leaks
		// nothing about whether the account exists or the password is right.
		const throttleKeys: ThrottleKeys = { ip: clientIpFrom(request.headers), email };
		const decision = await checkLoginThrottle(loginThrottle, throttleKeys);
		// How long THIS attempt was held, and — read after the outcome is known —
		// how long the next will be. Every failure below reports both, whatever
		// its own reason, so the page can say why the submit hung and that the
		// next one will too. Keyed on the same IP and email hashes as the
		// throttle itself, so an address with no account gets exactly the same
		// numbers as one with: the notice is no enumeration oracle.
		const heldMs = decision.kind === 'delay' ? decision.delayMs : 0;
		const waits = () => ({
			heldSeconds: toSeconds(heldMs),
			nextDelaySeconds: toSeconds(nextLoginDelayMs(loginThrottle, throttleKeys))
		});
		if (decision.kind === 'refuse') {
			logLoginAttempt(request, {
				ok: false,
				status: 429,
				reason: 'throttled',
				email,
				password,
				retryAfterS: decision.retryAfterSeconds,
				keyType: decision.keyType
			});
			return fail(429, {
				email,
				error: `Too many failed sign-in attempts. Try again in about ${decision.retryAfterSeconds} seconds.`,
				retryAfter: String(decision.retryAfterSeconds),
				...NO_WAIT
			});
		}

		if (decision.kind === 'delay') {
			// Logged BEFORE the sleep, so a slow response has an explanation
			// sitting in the log for the duration of the delay rather than
			// after it.
			logLoginAttempt(request, {
				ok: false,
				status: 0,
				reason: 'throttled',
				email,
				password,
				delayMs: decision.delayMs,
				keyType: decision.keyType
			});
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
			logLoginAttempt(request, {
				ok: false,
				status: 429,
				reason: 'throttled',
				email,
				password,
				retryAfterS: SIGN_IN_WINDOW_SECONDS
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
			if ((await errorCodeFrom(result.clone())) === 'EMAIL_NOT_VERIFIED') {
				return fail(403, {
					email,
					error:
						'Verify your email before signing in. Use the link in your inbox, or request another verification email.',
					retryAfter: null,
					...NO_WAIT
				});
			}
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

		// Any other failure keeps the existing deliberately-vague message:
		// which of email or password was wrong is information an attacker can
		// use, and the user has to fix both anyway.
		if (!result.ok) {
			// The one place a failure is recorded. A successful sign-in below
			// clears both keys, so neither success nor the merely act of trying
			// can accumulate toward a refusal.
			recordLoginFailure(loginThrottle, throttleKeys);
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
		clearLoginFailures(loginThrottle, throttleKeys);
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
