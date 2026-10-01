/**
 * Upload a photo to a served build the way the browser's form does: a
 * multipart POST to `?/upload` with the session cookie, an Origin (SvelteKit's
 * CSRF check) and `accept: text/html` (so a redirect is a real 303 rather than
 * a JSON envelope at 200). Not a test file; shared by the photo and CSP e2es.
 */
export async function postPhoto(
	origin: string,
	cookie: string,
	gymId: string,
	bytes: Uint8Array,
	{
		type = 'image/jpeg',
		name = 'placard.jpg',
		note = '',
		fields = {} as Record<string, string>
	} = {}
): Promise<Response> {
	const form = new FormData();
	form.append('photo', new Blob([bytes], { type }), name);
	form.append('note', note);
	for (const [k, v] of Object.entries(fields)) form.append(k, v);
	return fetch(new URL(`/gyms/${gymId}/equipment/photo?/upload`, origin), {
		method: 'POST',
		headers: { cookie, origin, accept: 'text/html' },
		body: form,
		redirect: 'manual'
	});
}

/** The photo id from an upload's 303 to `/photos/<id>/review`. Throws otherwise. */
export function reviewedPhotoId(res: Response): string {
	const location = res.headers.get('location') ?? '';
	const match = location.match(/^\/photos\/([0-9a-f-]{36})\/review/);
	if (res.status !== 303 || !match) {
		throw new Error(`upload answered ${res.status} -> ${location || '(no location)'}`);
	}
	return match[1];
}
