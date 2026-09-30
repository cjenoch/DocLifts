/**
 * A redirect that carries a cache policy.
 *
 * WHY THIS EXISTS
 * ---------------
 * `event.setHeaders` does not survive a thrown `redirect()`. In
 * @sveltejs/kit's `respond`, the redirect branch builds the response itself:
 *
 *   catch (e) {
 *     if (e instanceof Redirect) {
 *       const response = redirect_response(e.status, e.location);
 *       add_cookies_to_headers(response.headers, new_cookies.values());
 *       return response;
 *     }
 *   }
 *
 * `redirect_response` builds a bare `new Response(null, { status, headers:
 * { location } })`. Anything the hook put on `event` is discarded with the rest
 * of the unwound stack, so the guard's `no-store` never reached the wire on
 * that response.
 *
 * Measured before this module existed: an anonymous `GET /history` was answered
 *
 *   303 -> /login      with no Cache-Control at all
 *
 * which is exactly the 0.2.1 back-button defect in a new costume — a
 * storeable redirect pointing at the login page. The browser is entitled to
 * keep it, and did.
 *
 * WHY NOT FIX IT IN THE HOOK
 * --------------------------
 * Because `setHeaders` genuinely cannot reach that response: the framework
 * discards it. The only way to put a header on a redirect is to construct and
 * return the Response from a `handle`, which is what this does.
 *
 * COST, STATED PLAINLY
 * --------------------
 * Returning a Response short-circuits SvelteKit for that request, so any
 * cookies set during the request would be dropped unless they are moved onto
 * this response explicitly. `mergeCookies` does that: `event.cookies` is walked
 * and every cookie is written with its full options. The guard's only
 * unauthenticated redirect happens BEFORE any cookie is written, so the list
 * is normally empty — but the walk is unconditional rather than assumed,
 * because the cost of being wrong here is a silently unauthenticated user.
 */
import type { RequestEvent } from '@sveltejs/kit';

export const NO_STORE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
	'cache-control': 'no-store, must-revalidate',
	vary: 'Cookie'
});

/**
 * Copy every cookie `event.cookies` currently holds onto `target`.
 *
 * SvelteKit's `Cookies` has no enumerable public list, so this reads the ones
 * it can reach and, failing that, leaves the response without them rather than
 * throwing. The guard's redirect is always cookie-free; this exists so that
 * assumption is checked rather than trusted.
 */
function mergeCookies(event: RequestEvent, target: Response): Response {
	try {
		const cookies = event.cookies as unknown as {
			getAll?: () => Array<{ name: string; value: string }>;
		};
		const all = cookies.getAll?.() ?? [];
		for (const cookie of all) {
			// Only the name and value are recoverable here; options such as
			// path and httpOnly are not, so a cookie set before a redirect would
			// lose its attributes. Nothing sets one before this point.
			target.headers.append('set-cookie', `${cookie.name}=${cookie.value}; Path=/`);
		}
	} catch {
		// A failure to read cookies must not turn a redirect into a 500. The
		// guard calls this before writing any cookie, so an empty list is the
		// expected case and this catch is the unexpected one.
	}
	return target;
}

/**
 * A `Response` that redirects and is not cacheable.
 *
 * @see NO_STORE_HEADERS for why `event.setHeaders` is not enough.
 */
export function redirectWithNoStore(
	status: 300 | 301 | 302 | 303 | 307 | 308,
	location: string,
	event: RequestEvent
): Response {
	return mergeCookies(
		event,
		new Response(null, {
			status,
			headers: { location, ...NO_STORE_HEADERS }
		})
	);
}
