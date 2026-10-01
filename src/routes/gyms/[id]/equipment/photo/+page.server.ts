import { error, fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { requireUser } from '$lib/server/request-user';
import { ownGym, uploadPhoto } from '$lib/server/photos';
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
		try {
			const photo = await uploadPhoto(
				db,
				userId,
				{
					gymId: params.id,
					bytes: new Uint8Array(await file.arrayBuffer()),
					type: file.type,
					name: file.name
				},
				{ store: photoStore(), limits: resolvePhotoLimits() }
			);
			if (!photo) error(404, 'Gym not found');
			return { message: 'Photo uploaded', photoId: photo.id };
		} catch (e) {
			return photoFailure(e);
		}
	}
};
