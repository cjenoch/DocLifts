import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { requireUser } from '$lib/server/request-user';
import { setUserTimeZone } from '$lib/server/user-time-zone';
import type { RequestHandler } from './$types';

/**
 * The phone's time zone (owner decision, 2026-11-09). The root layout posts
 * `timeZone=<IANA name>` here, form-encoded, only when the browser's zone
 * differs from the stored one.
 *
 * Form encoding on purpose: `csrfBoundary` in hooks.server.ts refuses any
 * form-encoded POST whose Origin is not this origin, so the endpoint sits
 * behind the same CSRF rule as every form action. Any other body type is
 * refused (415) rather than accepted outside that rule. The auth guard
 * answers an anonymous POST with a 303 before this runs; `requireUser` is the
 * floor. Writes only the caller's own row.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	const userId = requireUser(locals).id;
	const type = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
	if (type !== 'application/x-www-form-urlencoded' && type !== 'multipart/form-data') {
		return json({ message: 'Unsupported body' }, { status: 415 });
	}
	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return json({ message: 'Unknown time zone' }, { status: 400 });
	}
	const result = await setUserTimeZone(db, userId, form.get('timeZone'));
	if (!result.ok) return json({ message: result.message }, { status: result.status });
	// No body on success: the layout reads only the status, and a body it never
	// reads left the request open in the browser (the e2e waits for idle).
	return new Response(null, { status: 204 });
};
