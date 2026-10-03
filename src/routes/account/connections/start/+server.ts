import { verifyOAuthQueryParams } from '@better-auth/oauth-provider';
import { auth } from '$lib/server/auth';
import { error, redirect } from '@sveltejs/kit';
import { isSafeNext } from '$lib/server/request-user';
import type { RequestHandler } from './$types';
/** Public OAuth continuation, not a data route. Validate before redirecting to login. */
export const GET: RequestHandler = async ({ url, request }) => {
	if (!(await verifyOAuthQueryParams(url.search.slice(1), (await auth.$context).secret)))
		error(400, 'Connection request expired. Start again from your agent.');
	const session = await auth.api.getSession({ headers: request.headers });
	if (!session?.user) {
		const next = url.pathname + url.search;
		if (!isSafeNext(next)) error(400, 'Invalid connection request.');
		redirect(303, '/login?next=' + encodeURIComponent(next));
	}
	redirect(303, '/api/auth/oauth2/authorize' + url.search);
};
