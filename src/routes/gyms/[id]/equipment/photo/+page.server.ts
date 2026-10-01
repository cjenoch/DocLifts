import { error, fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { requireUser } from '$lib/server/request-user';
import { ownGym, PhotoLimitError, uploadPhoto } from '$lib/server/photos';
import { analyzePhoto } from '$lib/server/photos/analyze';
import { photoFailure } from '$lib/server/photos/http';
import { resolvePhotoLimits } from '$lib/server/photos/config';
import { photoStore } from '$lib/server/photos/store';
import type { Actions, PageServerLoad } from './$types';

// The gym must be the caller's: another user's gym is a 404, identical to an
// id that never existed (D6).
export const load: PageServerLoad = async ({ params, locals }) => {
	const userId = requireUser(locals).id;
	const gym = await ownGym(db, userId, params.id);
	if (!gym) error(404, 'Gym not found');
	return { gym };
};

export const actions: Actions = {
	upload: async ({ params, request, locals }) => {
		const userId = requireUser(locals).id;
		const form = await request.formData();
		const file = form.get('photo');
		if (!(file instanceof File) || file.size === 0) {
			return fail(400, { message: 'Choose a photo to upload.' });
		}
		const note = String(form.get('note') ?? '').slice(0, 200);
		const store = photoStore();
		let photoId: string;
		try {
			const limits = resolvePhotoLimits();
			const photo = await uploadPhoto(
				db,
				userId,
				{
					gymId: params.id,
					bytes: new Uint8Array(await file.arrayBuffer()),
					type: file.type,
					name: file.name
				},
				{ store, limits }
			);
			if (!photo) error(404, 'Gym not found');
			photoId = photo.id;
			// Analysis runs inline: one request from photo to review. A failed
			// analysis leaves the photo `uploaded` (llm_calls records why) and
			// is not a failed upload; the review page offers "try again".
			let analysis: 'ok' | 'failed' | 'limit' = 'failed';
			try {
				const outcome = await analyzePhoto(db, userId, photo.id, { store, limits, note });
				analysis = outcome?.ok ? 'ok' : 'failed';
			} catch (e) {
				if (!(e instanceof PhotoLimitError)) throw e;
				analysis = 'limit';
			}
			return {
				message: analysis === 'ok' ? 'Photo uploaded and read' : 'Photo uploaded',
				photoId,
				analysis
			};
		} catch (e) {
			return photoFailure(e);
		}
	}
};
