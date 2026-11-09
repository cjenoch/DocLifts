import { deletionEnabled, durableLedger } from '$lib/server/privacy/ledger';
import {
	deletionJobState,
	requestPhotoDeletion,
	runDeletion,
	type DeletionRunState
} from '$lib/server/privacy/lifecycle';
import {
	photoRemovalUi,
	removalOutcomeMessage,
	type StoredRemovalState
} from '$lib/photo-removal-ui';
import { privacyDeletions, photoObjects, llmCalls } from '$lib/server/db';
import { isTransientErrorCode } from '$lib/server/llm';
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
	// The photo's last read, when it was a transient provider answer (429/502/503,
	// after the automatic retry): "temporarily unavailable" survives a reload and
	// a visit from the gym page's list, like the workout block's (2026-11-09).
	// `analyzePhoto` records a failed read only on an `uploaded` photo.
	const [lastRead] =
		photo.status === 'uploaded' && photo.llmCallId
			? await db
					.select({ status: llmCalls.status, errorCode: llmCalls.errorCode })
					.from(llmCalls)
					.where(and(eq(llmCalls.id, photo.llmCallId), eq(llmCalls.userId, userId)))
			: [];
	const unavailable =
		lastRead?.status === 'provider_error' && isTransientErrorCode(lastRead.errorCode);
	// A photo that opened a workout block (0.6.0): linking names that block.
	const block = await unidentifiedBlockOfPhoto(db, userId, photo.id);
	const [removal] = await db
		.select({ completedAt: privacyDeletions.completedAt, lastError: privacyDeletions.lastError })
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
	// Stored state only, through deletionJobState. An inventoried object past
	// `stored` with no open job is still on its way out: pending.
	const job = removal ? deletionJobState(removal) : null;
	const removalState: StoredRemovalState | null =
		job === 'pending' || job === 'needs_retry'
			? job
			: object && object.state !== 'stored'
				? 'pending'
				: null;
	return {
		deletionEnabled: deletionEnabled(),
		removal: removalState,
		block,
		userId,
		photo: { id: photo.id, status: photo.status, width: photo.width, height: photo.height },
		gym: { id: gym.id, name: gym.name },
		candidate,
		candidateLoadingType: candidate ? CANDIDATE_LOADING_TYPES[candidate.loading_type] : null,
		matching,
		resultModel,
		analysisNotice:
			analysis === 'limit'
				? 'limit'
				: !candidate && (analysis === 'unavailable' || unavailable)
					? 'unavailable'
					: analysis === 'failed' && !candidate
						? 'failed'
						: null
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

/** This request's removal batch: completed goes on; `busy` (another runner holds
 * the job or its object), `pending` and `failed` each say what is true. */
function removalOutcome(state: DeletionRunState) {
	if (state === 'completed') redirect(303, '/account?photoRemoved=1');
	if (state === 'not_found') error(404, 'Photo not found');
	return fail(503, { message: removalOutcomeMessage(state), removal: state });
}

export const actions: Actions = {
	remove: async ({ params, locals, request }) => {
		const userId = requireUser(locals).id;
		if (!deletionEnabled()) return fail(503, { message: photoRemovalUi.disabled });
		if ((await request.formData()).get('confirmRemoval') !== 'yes')
			return fail(400, { message: photoRemovalUi.confirmRequired });
		let ledger, job;
		try {
			ledger = durableLedger();
			job = await requestPhotoDeletion(db, userId, params.id, ledger);
		} catch {
			return fail(503, { message: photoRemovalUi.notAcknowledged });
		}
		if (!job) error(404, 'Photo not found');
		const result = await runDeletion(db, userId, job.id, photoStore(), ledger, 1);
		return removalOutcome(result.state);
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
			if (!outcome.ok) notice = outcome.retryable ? '?analysis=unavailable' : '?analysis=failed';
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
			let ledger, job;
			try {
				ledger = durableLedger();
				job = await requestPhotoDeletion(db, userId, params.id, ledger);
			} catch {
				return fail(503, { message: photoRemovalUi.notAcknowledged });
			}
			if (!job) error(404, 'Photo not found');
			const result = await runDeletion(db, userId, job.id, photoStore(), ledger, 1);
			return removalOutcome(result.state);
		}
		try {
			if (!(await discardPhoto(db, userId, params.id, photoStore()))) error(404, 'Photo not found');
		} catch (e) {
			return photoFailure(e);
		}
		redirect(303, review(params.id));
	}
};
