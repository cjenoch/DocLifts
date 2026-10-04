import { fail, redirect, type RequestEvent } from '@sveltejs/kit';
import { db } from './db';
import { requireUser } from './request-user';
import { acknowledgePhotoNotice } from './photo-privacy';
import { PHOTO_NOTICE_VERSION, PHOTO_NOTICE_REQUIRED } from '$lib/photo-privacy';

/** Same-page action: no redirect target or user ID is accepted from the client. */
export async function photoNoticeAction({
	request,
	locals,
	url
}: Pick<RequestEvent, 'request' | 'locals' | 'url'>) {
	const userId = requireUser(locals).id;
	const form = await request.formData();
	if (form.get('photoNoticeVersion') !== PHOTO_NOTICE_VERSION || form.get('acknowledge') !== 'yes')
		return fail(400, { message: PHOTO_NOTICE_REQUIRED, setId: null });
	await acknowledgePhotoNotice(db, userId);
	if (request.headers.get('x-sveltekit-action') === 'true') return { photoNoticeAccepted: true };
	redirect(303, url.pathname);
}
