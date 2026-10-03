import type { Handle } from '@sveltejs/kit';

/**
 * Same-origin form protection, before both the auth handler and page actions.
 * SvelteKit's global form guard runs before hooks and cannot exempt one route.
 * Keep its deny-by-default rule here; only cookie-free, Origin-free OAuth token
 * POSTs may use form encoding from a native/server client. Authorization code
 * + S256 PKCE or a refresh token supplies authorization, never a browser cookie.
 * Better Auth's own Origin/CSRF checks remain enabled as a second boundary.
 */
export const csrfBoundary: Handle = async ({ event, resolve }) => {
	const { request, url } = event;
	const origin = request.headers.get('origin');
	const type = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
	const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method);
	const form = ['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain'].includes(
		type
	);
	const tokenExchange =
		request.method === 'POST' &&
		url.pathname === '/api/auth/oauth2/token' &&
		type === 'application/x-www-form-urlencoded' &&
		!request.headers.has('cookie') &&
		origin === null;
	if (mutating && form && origin !== url.origin && !tokenExchange) {
		return new Response(`Cross-site ${request.method} form submissions are forbidden`, {
			status: 403,
			headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'private, no-store' }
		});
	}
	return resolve(event);
};
