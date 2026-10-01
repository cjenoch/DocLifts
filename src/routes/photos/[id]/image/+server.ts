import { error } from '@sveltejs/kit';
import { Readable } from 'node:stream';
import { db } from '$lib/server/db';
import { requireUser } from '$lib/server/request-user';
import { readOwnPhoto } from '$lib/server/photos';
import { photoStore } from '$lib/server/photos/store';
import type { RequestHandler } from './$types';

/**
 * The ONLY way a stored photo leaves the server. Guarded like every page (the
 * hook redirects an anonymous request), and the photo is resolved with
 * `user_id = userId`: another user's photo, a discarded one, and a missing id
 * are the same 404 (D6). Same-origin, so the CSP's `img-src 'self'` covers it;
 * there are no presigned or public URLs.
 *
 * Cache policy: the hook already sets `no-store, must-revalidate` and
 * `Vary: Cookie` on every non-asset response, and SvelteKit applies the hook's
 * headers over the endpoint's, so that is what this answers with. `no-store`
 * forbids every cache, private ones included.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	const userId = requireUser(locals).id;
	const image = await readOwnPhoto(db, userId, params.id, photoStore());
	if (!image) error(404, 'Not found');
	return new Response(Readable.toWeb(image.body) as ReadableStream, {
		headers: {
			'content-type': image.contentType,
			'x-content-type-options': 'nosniff',
			'content-disposition': 'inline'
		}
	});
};
