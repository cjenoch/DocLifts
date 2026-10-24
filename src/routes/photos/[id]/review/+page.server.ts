import { deletionEnabled, fileLedger } from '$lib/server/privacy/ledger';
import { requestPhotoDeletion, runDeletion } from '$lib/server/privacy/lifecycle';
import { privacyDeletions, photoObjects } from '$lib/server/db';
import { subjectHash } from '$lib/server/privacy/ledger';
import { and, eq } from 'drizzle-orm';
import { error, fail, redirect } from '@sveltejs/kit';
import { ZodError } from 'zod';
import { db } from '$lib/server/db';
import { requireUser } from '$lib/server/request-user';
import { loadOwnPhoto, ownGym, PhotoLimitError } from '$lib/server/photos';
import { analyzePhoto, parseCandidate } from '$lib/server/photos/analyze';
import { matchCandidate } from '$lib/server/photos/match';
import {
	CANDIDATE_LOADING_TYPES,
	createModelFromPhoto,
	discardPhoto,
	linkPhoto
} from '$lib/server/photos/confirm';
import { photoFailure } from '$lib/server/photos/http';
import { resolvePhotoLimits } from '$lib/server/photos/config';
import { photoStore } from '$lib/server/photos/store';
import { loadModel } from '$lib/server/catalog';
import { MachineInputError } from '$lib/server/machines';
import { identifySessionExercise, unidentifiedBlockOfPhoto } from '$lib/server/photo-workout';
import type { Actions, PageServerLoad } from './$types';

// The photo must be the caller's: another user's photo is a 404, identical to
// an id that never existed (D6).
export const load: PageServerLoad = async ({ params, locals, url }) => {
	const userId = requireUser(locals).id;
	const photo = await loadOwnPhoto(db, userId, params.id);
	if (!photo) error(404, 'Photo not found');
	const gym = await ownGym(db, userId, photo.gymId);
	if (!gym) error(404, 'Photo not found');
	const candidate = parseCandidate(photo.candidate);
	const open = photo.status === 'uploaded' || photo.status === 'analyzed';
	const matching = open && candidate ? await matchCandidate(db, userId, candidate) : null;
	const resultModelId = photo.matchedModelId ?? photo.createdModelId;
	const resultModel = resultModelId ? await loadModel(db, userId, resultModelId) : null;
	const analysis = url.searchParams.get('analysis');
	// A photo that opened a workout block (0.6.0): linking names that block.
	const block = await unidentifiedBlockOfPhoto(db, userId, photo.id);
	const [removal] = await db
		.select({ completedAt: privacyDeletions.completedAt })
		.from(privacyDeletions)
		.where(
			and(
				eq(privacyDeletions.kind, 'photo'),
				eq(privacyDeletions.subjectHash, subjectHash('photo', photo.id))
			)
		);
	const [object] = await db
		.select({ state: photoObjects.state })
		.from(photoObjects)
		.where(and(eq(photoObjects.photoId, photo.id), eq(photoObjects.userId, userId)));
	return {
		deletionEnabled: deletionEnabled(),
		removalPending: (!!removal && !removal.completedAt) || (!!object && object.state !== 'stored'),
		block,
		userId,
		photo: { id: photo.id, status: photo.status, width: photo.width, height: photo.height },
		gym: { id: gym.id, name: gym.name },
		candidate,
		candidateLoadingType: candidate ? CANDIDATE_LOADING_TYPES[candidate.loading_type] : null,
		matching,
		resultModel,
		analysisNotice:
			analysis === 'limit' ? 'limit' : analysis === 'failed' && !candidate ? 'failed' : null
	};
};

function inputFailure(e: unknown) {
	if (e instanceof ZodError)
		return fail(400, { message: e.issues.map((i) => i.message).join('; ') });
	// A model another user owns is "not found", exactly like a missing id.
	if (e instanceof MachineInputError)
		return fail(e.message === 'Model not found' ? 404 : 400, { message: e.message });
	return photoFailure(e);
}

const review = (id: string) => `/photos/${id}/review`;

export const actions: Actions = {
	remove: async ({ params, locals, request }) => {
		const userId = requireUser(locals).id;
		if (!deletionEnabled()) return fail(503, { message: 'Photo removal is not enabled yet.' });
		if ((await request.formData()).get('confirmRemoval') !== 'yes')
			return fail(400, { message: 'Confirm that you want to remove this image.' });
		let ledger;
		try {
			ledger = fileLedger();
		} catch {
			return fail(503, { message: 'Removal is temporarily unavailable. Contact support.' });
		}
		const job = await requestPhotoDeletion(db, userId, params.id, ledger);
		if (!job) error(404, 'Photo not found');
		const result = await runDeletion(db, userId, job.id, photoStore(), ledger, 1);
		if (result.state !== 'completed')
			return fail(503, {
				message: 'Photo hidden. Object removal is pending an operator retry; it has not finished.'
			});
		redirect(303, '/account?photoRemoved=1');
	},
	analyze: async ({ params, request, locals }) => {
		const userId = requireUser(locals).id;
		const form = await request.formData();
		const note = String(form.get('note') ?? '').slice(0, 200);
		let notice = '';
		try {
			const outcome = await analyzePhoto(db, userId, params.id, {
				store: photoStore(),
				limits: resolvePhotoLimits(),
				note
			});
			if (!outcome) error(404, 'Photo not found');
			if (!outcome.ok) notice = '?analysis=failed';
		} catch (e) {
			if (e instanceof PhotoLimitError) notice = '?analysis=limit';
			else return photoFailure(e);
		}
		redirect(303, review(params.id) + notice);
	},
	link: async ({ params, request, locals }) => {
		const userId = requireUser(locals).id;
		const form = Object.fromEntries(await request.formData());
		// A workout block's photo: identify the block (one machine per model per
		// gym; the block's sets and photo move with it), then back to the workout.
		const block = await unidentifiedBlockOfPhoto(db, userId, params.id);
		try {
			if (block) {
				const done = await identifySessionExercise(
					db,
					userId,
					block.sessionId,
					block.occurrenceId,
					{ modelId: form.modelId }
				);
				if (!done) error(404, 'Photo not found');
			} else {
				const done = await linkPhoto(db, userId, params.id, form);
				if (!done) error(404, 'Photo not found');
			}
		} catch (e) {
			return inputFailure(e);
		}
		redirect(303, block ? `/sessions/${block.sessionId}` : review(params.id));
	},
	create: async ({ params, request, locals }) => {
		const userId = requireUser(locals).id;
		const form = Object.fromEntries(await request.formData());
		const block = await unidentifiedBlockOfPhoto(db, userId, params.id);
		try {
			await db.transaction(async (tx) => {
				const done = await createModelFromPhoto(tx, userId, params.id, form);
				if (!done) error(404, 'Photo not found');
				// A workout block's photo: the block joins the machine just made.
				if (block)
					await identifySessionExercise(tx, userId, block.sessionId, block.occurrenceId, {
						modelId: done.modelId
					});
			});
		} catch (e) {
			return inputFailure(e);
		}
		redirect(303, block ? `/sessions/${block.sessionId}` : review(params.id));
	},
	discard: async ({ params, locals }) => {
		const userId = requireUser(locals).id;
		if (deletionEnabled()) {
			const photo = await loadOwnPhoto(db, userId, params.id);
			if (!photo || !['uploaded', 'analyzed'].includes(photo.status)) error(404, 'Photo not found');
			const ledger = fileLedger();
			const job = await requestPhotoDeletion(db, userId, params.id, ledger);
			if (!job) error(404, 'Photo not found');
			const result = await runDeletion(db, userId, job.id, photoStore(), ledger, 1);
			if (result.state !== 'completed')
				return fail(503, { message: 'Photo hidden. Object cleanup is pending an operator retry.' });
			redirect(303, '/account?photoRemoved=1');
		}
		try {
			if (!(await discardPhoto(db, userId, params.id, photoStore()))) error(404, 'Photo not found');
		} catch (e) {
			return photoFailure(e);
		}
		redirect(303, review(params.id));
	}
};
