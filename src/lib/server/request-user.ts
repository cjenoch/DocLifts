/**
 * Authentication guard and the `requireUser` helper.
 *
 * Two distinct jobs, deliberately one module because they are one concept:
 *
 *  - `resolveAuthRedirect` / the `load` guard in +layout.server.ts decide what
 *    an UNAUTHENTICATED visitor sees. They are a convenience: the layout guard
 *    runs on every navigation, so a new page cannot accidentally ship unguarded
 *    by omission.
 *  - `requireUser(locals)` is what routes actually call to get the owner id.
 *    It throws rather than returning `undefined`, so no `?.` can leak an
 *    `undefined` into a module and no route can quietly operate on "no user".
 *
 * The guard is a UX layer; `requireUser` is the type-level and runtime floor.
 * Both are needed: the guard makes the 401 unreachable in practice, and
 * `requireUser` makes it impossible to write the call wrong.
 */
import { error, redirect, type RequestEvent } from '@sveltejs/kit';
import type { Auth } from './auth';

/**
 * Paths reachable without a session.
 *
 * `+page.server.ts` files outside src/routes/ — the auth endpoints, the
 * health check, the webhook — are not listed and not guarded, by design: they
 * are not user-facing pages and each does its own authentication. The route
 * inventory test in auth-guard.test.ts asserts that every page under
 * src/routes/ is either listed here or covered by the default redirect, so a
 * new page cannot be added unguarded by accident.
 */
const ALLOWLIST: readonly string[] = [
	'/login',
	'/logout',
	'/signup',
	'/api/auth',
	'/_app',
	'/favicon',
	'/robots.txt',
	'/manifest',
	'/health',
	'/mcp',
	'/account/connections/start',
	'/.well-known/oauth-protected-resource',
	'/.well-known/oauth-authorization-server'
];

/**
 * True when `pathname` may be served to an unauthenticated visitor.
 *
 * Prefix match, so `/api/auth/anything` is allowed and `/_app/immutable/...`
 * is too. The public asset prefixes are fixed by SvelteKit and Vite, not by us.
 */
export function isPublicPath(pathname: string): boolean {
	// A prefix match alone is not enough. `/login/../reports` starts with
	// `/login/`, and a browser resolves it to `/reports` — so the string that
	// passed the check and the path actually served are not the same, which is
	// a guard bypass. Normalise first, then match. `new URL` collapses `.`/`..`
	// and normalises backslashes the way a browser does.
	let normalized = pathname;
	try {
		normalized = new URL(pathname, 'http://placeholder.invalid').pathname;
	} catch {
		// Unparseable: fall through with the raw value, which matches no
		// allowlist entry and so ends up guarded.
	}

	return ALLOWLIST.some(
		(prefix) =>
			normalized === prefix ||
			normalized.startsWith(prefix + '/') ||
			normalized.startsWith(prefix + '.')
	);
}

/**
 * Asset prefixes that must KEEP their caching.
 *
 * WHY THIS IS SEPARATE FROM THE ALLOWLIST
 * ---------------------------------------
 * `isPublicPath` answers "may an unauthenticated visitor reach this?" — a
 * question about authorization. This answers "is this a build artifact whose
 * bytes never change for a given URL?" — a question about caching. They came
 * to the same list for one release and that was wrong: `/login` was public,
 * so the 0.2.1 no-store change skipped it, and because it set no policy of
 * its own a response with no Cache-Control is heuristically cacheable. A
 * browser held a stale sign-in form across a password change.
 *
 * Conflating them also had the merit of being invisible: nothing about
 * "public" implies "uncacheable", and the login page is the one page where
 * being stored is most damaging.
 *
 * The rule is simply: immutable build artifacts cache, everything else does
 * not. `/login`, `/signup`, error pages, and every authenticated page are
 * HTML carrying or gating credentials, and none of them are cacheable.
 */
const ASSET_PREFIXES: readonly string[] = [
	// Vite's immutable build output. The name is a content hash, so these are
	// safe to cache forever once fetched.
	'/_app/immutable',
	'/_app/version.json'
];

export function isAssetPath(pathname: string): boolean {
	let normalized = pathname;
	try {
		normalized = new URL(pathname, 'http://placeholder.invalid').pathname;
	} catch {
		// Unparseable: matches nothing, so it is treated as HTML. That is the
		// safe direction — uncacheable rather than cached.
	}
	return ASSET_PREFIXES.some(
		(prefix) =>
			normalized === prefix ||
			normalized.startsWith(prefix + '/') ||
			normalized.startsWith(prefix + '.')
	);
}

/**
 * `?next=` is an open-redirect vector if taken as given. Accept only a
 * same-origin relative path.
 *
 * Rejected: an absolute URL (`https://evil.example`), a protocol-relative URL
 * (`//evil.example`), a backslash form that some browsers normalise to a
 * slash (`/\evil.example`), and anything carrying a scheme. The test
 * `isSafeNext` must hold is that a browser resolving the result stays on this
 * origin — which is exactly "starts with a single `/` and is not `//`".
 */
export function isSafeNext(next: string | null | undefined): next is string {
	if (!next) return false;
	if (!next.startsWith('/')) return false;
	// `//host` and `/\host` are treated as protocol-relative by browsers.
	if (next.startsWith('//') || next.startsWith('/\\')) return false;
	// Belt and braces: no scheme may appear anywhere, even after a path
	// segment (`/redirect?u=https://evil.example` is harmless, but a value
	// like `javascript:` never reaches here anyway since it fails the `/`).
	if (next.includes('://')) return false;
	// Traversal that collapses to a protocol-relative URL. `/..//evil.example`
	// starts with a single `/` and has no scheme, so the checks above all pass
	// — but a browser resolves the `..` and is left with `//evil.example`, an
	// open redirect. Normalise the way a browser would and re-check the
	// result. This is the one shape that a string-prefix test misses.
	let resolved: URL;
	try {
		resolved = new URL(next, 'http://placeholder.invalid');
	} catch {
		return false;
	}
	// Same origin after normalisation.
	if (resolved.origin !== 'http://placeholder.invalid') return false;

	// The decisive check, and the reason this function exists. `new URL` is
	// not the last word: the guard emits a `Location` header, and a browser
	// resolves that string AGAIN, on its own. So the invariant is on the
	// RESOLVED PATHNAME, not on the input: a pathname beginning `//` or `/\`
	// is protocol-relative, and a browser follows it off-origin regardless of
	// how the URL object classified it.
	//
	// `/..//evil.example` is the case that motivates this. It starts with a
	// single `/` and carries no scheme, so a prefix-only test passes it, and
	// `new URL(next, origin).origin` is SAME origin — the object-level check
	// says safe. But the resolved pathname is `//evil.example`, and emitting
	// that as `Location:` sends the user to https://evil.example. No real
	// application path begins with `//`, so rejecting it costs nothing.
	const p = resolved.pathname;
	if (p.startsWith('//') || p.startsWith('/\\')) return false;

	// Percent-encoded separators: `/%2F%2Fevil.example` decodes to `//…` in
	// some intermediaries and is a classic filter bypass. Decode, then apply
	// the same rule.
	let decoded: string;
	try {
		decoded = decodeURIComponent(p);
	} catch {
		return false; // malformed percent-encoding: refuse rather than guess
	}
	if (decoded.startsWith('//') || decoded.startsWith('/\\')) return false;
	if (decoded.includes('\\')) return false;

	return true;
}

/** The destination to send an unauthenticated visitor to. */
export function resolveAuthRedirect(url: URL): string {
	const next = url.searchParams.get('next');
	return isSafeNext(next) ? next : '/login';
}

/**
 * The signed-in user, or a 401. Use for `locals.user` in any route that
 * touches owner-scoped data.
 *
 * Throws rather than returning null so a missing user is a hard failure at
 * the call site instead of an `undefined` that flows into a query. After T3
 * scopes every module to a `userId`, this is also what keeps the "flip
 * `.notNull()` and get zero type errors" check honest: a route that forgot
 * the guard would be a type error, not a runtime surprise.
 */
export function requireUser(locals: App.Locals): NonNullable<App.Locals['user']> {
	if (!locals.user) {
		throw error(401, 'Not signed in');
	}
	return locals.user;
}

export type { Auth };
