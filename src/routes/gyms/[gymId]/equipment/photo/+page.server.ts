import { error, fail, redirect } from '@sveltejs/kit';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { equipmentPhotos } from '$lib/server/db/schema';
import { requireUser } from '$lib/server/request-user';
import { ownGym, PhotoLimitError, uploadPhoto } from '$lib/server/photos';
import { analyzePhoto } from '$lib/server/photos/analyze';
import { photoFailure } from '$lib/server/photos/http';
import { resolvePhotoLimits } from '$lib/server/photos/config';
import { photoStore } from '$lib/server/photos/store';
import { clientMeasurement, logUpload, type UploadLogLine } from '$lib/server/photos/upload-log';
import { emptyTimings, msSince } from '$lib/server/photos/timings';
import type { Actions, PageServerLoad } from './$types';

// The gym must be the caller's: another user's gym is a 404, identical to an
// id that never existed (D6).
export const load: PageServerLoad = async ({ params, locals }) => {
	const userId = requireUser(locals).id;
	const gym = await ownGym(db, userId, params.gymId);
	if (!gym) error(404, 'Gym not found');
	// Photos still waiting for a decision, so an interrupted review can be resumed.
	const waiting = await db
		.select({
			id: equipmentPhotos.id,
			status: equipmentPhotos.status,
			createdAt: equipmentPhotos.createdAt
		})
		.from(equipmentPhotos)
		.where(
			and(
				eq(equipmentPhotos.userId, userId),
				eq(equipmentPhotos.gymId, gym.id),
				inArray(equipmentPhotos.status, ['uploaded', 'analyzed'])
			)
		)
		.orderBy(desc(equipmentPhotos.createdAt))
		.limit(20);
	return { gym, waiting };
};

export const actions: Actions = {
	upload: async ({ params, request, locals }) => {
		// totalMs runs from here to the response being decided (0.5.3).
		const started = performance.now();
		const userId = requireUser(locals).id;
		const form = await request.formData();
		const file = form.get('photo');
		if (!(file instanceof File) || file.size === 0) {
			return fail(400, { message: 'Choose a photo to upload.' });
		}
		const note = String(form.get('note') ?? '').slice(0, 200);
		// What the browser says it did, for the log line only. Never trusted:
		// nothing below reads it, and validation and storage see only `file`.
		const measured = { ...clientMeasurement(form), receivedBytes: file.size };
		// Filled in by each stage as it finishes, for the log line only.
		const timings = emptyTimings();
		let result: Pick<UploadLogLine, 'outcome' | 'storedBytes' | 'photoId'> = {
			outcome: 'refused',
			storedBytes: null,
			photoId: null
		};
		const store = photoStore;
		let target: string;
		try {
			try {
				const limits = resolvePhotoLimits();
				const uploaded = await uploadPhoto(
					db,
					userId,
					{
						gymId: params.gymId,
						bytes: new Uint8Array(await file.arrayBuffer()),
						type: file.type,
						name: file.name
					},
					{ store: store(), limits, timings }
				);
				if (!uploaded) error(404, 'Gym not found');
				const { photo, image } = uploaded;
				result = { outcome: 'stored', storedBytes: photo.bytes, photoId: photo.id };
				// Analysis runs inline: one request from photo to review. A failed
				// analysis leaves the photo `uploaded` (llm_calls records why) and
				// is not a failed upload; the review page says so and offers a retry.
				// It is handed the processed JPEG that was just stored, so the store
				// is not read back; a re-analysis on the review page reads it.
				target = `/photos/${photo.id}/review`;
				try {
					const outcome = await analyzePhoto(db, userId, photo.id, {
						store: store(),
						limits,
						note,
						image,
						timings
					});
					if (!outcome?.ok) target += '?analysis=failed';
				} catch (e) {
					if (!(e instanceof PhotoLimitError)) throw e;
					target += '?analysis=limit';
				}
			} catch (e) {
				return photoFailure(e);
			}
			redirect(303, target);
		} finally {
			// One line per upload, written once the response is decided, so it
			// carries the model's time as well (0.5.3). Only when the line is
			// printed moved; every step runs in the order it always did.
			logUpload({
				source: 'gym_page',
				...measured,
				...result,
				...timings,
				totalMs: msSince(started)
			});
		}
	}
};
