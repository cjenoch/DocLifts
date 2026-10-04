import { hasPhotoNotice } from '$lib/server/photo-privacy';
import { photoNoticeAction } from '$lib/server/photo-privacy-action';
import { PHOTO_NOTICE_REQUIRED } from '$lib/photo-privacy';
import { error, fail, redirect } from '@sveltejs/kit';
import { asc, eq, sql } from 'drizzle-orm';
import {
	db,
	dayExercises,
	days,
	exercises,
	sessions,
	sessionExercises,
	sets
} from '$lib/server/db';
import { getLastCompletedSet, historyIdentity, type HistoryRow } from '$lib/server/progression';
import {
	endSession,
	loadSession,
	loadSessionDay,
	loadSessionSets,
	softDeleteEndedSession,
	updateSetInSession
} from '$lib/server/sessions';
import { z } from 'zod';
import {
	addSessionExercise,
	bindSessionMachine,
	createMachine,
	MachineInputError
} from '$lib/server/machines';
import type { Actions, PageServerLoad } from './$types';
import { appendWorkoutSet, removeEmptyLastSet } from '$lib/server/workout-sets';
import {
	applyProgramSwaps,
	moveSessionExercise,
	removeSessionExercise,
	skipRestOfExercise,
	swapSessionExercise,
	WorkoutEditError
} from '$lib/server/live-edit';
import { requireUser } from '$lib/server/request-user';
import { programsToAddTo } from '$lib/server/workout-to-program';
import { pickerData } from '$lib/server/picker';
import {
	autoIdentifyRepeatVisit,
	identifySessionExercise,
	namedPhotoBlocks,
	openPhotoBlock,
	photoBlocksForSession,
	undoPhotoIdentify
} from '$lib/server/photo-workout';
import { isUuid, PhotoLimitError, uploadPhoto } from '$lib/server/photos';
import { analyzePhoto } from '$lib/server/photos/analyze';
import { photoFailure } from '$lib/server/photos/http';
import { resolvePhotoLimits } from '$lib/server/photos/config';
import { photoStore } from '$lib/server/photos/store';
import { clientMeasurement, logUpload, type UploadLogLine } from '$lib/server/photos/upload-log';
import { emptyTimings, msSince } from '$lib/server/photos/timings';
import { workoutMachinePhotos } from '$lib/server/workout-photos';

const uuidParamSchema = z.string().uuid();

export const load: PageServerLoad = async ({ params, url, locals }) => {
	const parsedSessionId = uuidParamSchema.safeParse(params.id);
	if (!parsedSessionId.success) {
		error(400, 'Invalid session id');
	}

	const session = await loadSession(db, requireUser(locals).id, parsedSessionId.data, 'active');
	if (!session) {
		error(404, 'Session not found');
	}

	const { day, dayExs, systemKind } = await loadSessionDay(
		db,
		requireUser(locals).id,
		session.dayId
	);
	if (!day) {
		// FK guarantees the row exists, so this is either corruption or a
		// program owned by someone else. Either way the session page has
		// nothing to render.
		error(404, 'Session not found');
	}

	const exerciseMeta = new Map(
		dayExs.map((de) => [
			de.exerciseId,
			{
				position: de.position,
				tier: de.tier,
				progressionPolicy: de.progressionPolicy
			}
		])
	);

	const sessionSets = await loadSessionSets(db, requireUser(locals).id, session.id);

	// Per-set history for inline display. N+1 by design (MVP).
	// Exclude THIS session — once it ends, its own set would otherwise become
	// "the most recent completed" and the "Last: …" line would duplicate the
	// executed value shown right above it in the same row.
	const histories = await Promise.all(
		sessionSets.map((s) =>
			getLastCompletedSet(
				db,
				requireUser(locals).id,
				s.exerciseId,
				s.setRole,
				s.position,
				session.id,
				// Free weights: last time on any machine, at any gym (0.8.0).
				historyIdentity(s.gymEquipmentId, s.loadConvention, s.equipmentType)
			)
		)
	);

	type SetRow = (typeof sessionSets)[number] & { history: HistoryRow | null };
	type Group = {
		key: string;
		occurrenceId: string | null;
		position: number;
		machineLabel: string | null;
		gymName: string | null;
		modelName: string | null;
		loadConvention: string;
		exerciseId: string;
		exerciseName: string;
		/** The block's equipment type (0.8.1: the sheet's bind filter). */
		equipmentType: string;
		tier: 'main' | 'secondary' | 'isolation' | null;
		progressionPolicy: 'standard' | 'cautious' | 'hold' | null;
		sets: SetRow[];
	};

	const groupMap = new Map<string, Group>();
	sessionSets.forEach((s, i) => {
		const key = s.sessionExerciseId ?? s.exerciseId;
		let g = groupMap.get(key);
		if (!g) {
			const meta = exerciseMeta.get(s.exerciseId);
			g = {
				key,
				occurrenceId: s.sessionExerciseId,
				position: s.occurrencePosition ?? meta?.position ?? 0,
				machineLabel: s.machineLabel,
				gymName: s.gymName,
				modelName: s.modelName,
				loadConvention: s.loadConvention,
				exerciseId: s.exerciseId,
				exerciseName: s.exerciseName,
				equipmentType: s.equipmentType,
				tier: s.occurrenceTier ?? meta?.tier ?? null,
				progressionPolicy: s.occurrencePolicy ?? meta?.progressionPolicy ?? null,
				sets: []
			};
			groupMap.set(key, g);
		}
		g.sets.push({ ...s, history: histories[i] });
	});

	const groups = [...groupMap.values()].sort((a, b) => a.position - b.position);
	for (const g of groups) g.sets.sort((a, b) => a.position - b.position);

	const allowEndedSessionEdit = session.endedAt != null && url.searchParams.get('edit') === '1';
	// After finishing (Part L): whether a "From now on" swap reached the program.
	const programParam = url.searchParams.get('program');
	const toParam = url.searchParams.get('to');
	const programUpdate =
		session.endedAt == null
			? null
			: programParam === 'updated' && toParam && isUuid(toParam)
				? ({ kind: 'updated', programId: toParam } as const)
				: programParam === 'open' || programParam === 'changed' || programParam === 'invalid'
					? ({ kind: 'failed', reason: programParam } as const)
					: null;

	return {
		photoNoticeAccepted: await hasPhotoNotice(db, requireUser(locals).id),
		session,
		day,
		// A workout started with no program (0.5.1): no program page to go
		// back to, a fixed heading, and the add-exercise control open when empty.
		quick: systemKind === 'quick',
		groups,
		machinePhotos: await workoutMachinePhotos(
			db,
			requireUser(locals).id,
			sessionSets.flatMap((s) => (s.gymEquipmentId ? [s.gymEquipmentId] : []))
		),
		allowEndedSessionEdit,
		programUpdate,
		// A finished workout can become a program, or a day of one (Part M).
		saveAsProgram: session.endedAt
			? { programs: await programsToAddTo(db, requireUser(locals).id) }
			: null,
		// The add sheet's data (0.8.0); only an open workout adds exercises.
		picker: session.endedAt ? null : await pickerData(db, requireUser(locals).id, session.gymId),
		// An open workout shows its own bottom bar (Pause, Add exercise, Finish),
		// and the layout hides the tabs for it: one bar at a time (0.5.5).
		workoutBar: session.endedAt == null,
		// Photo in the workout (0.6.0): what each unidentified photo block shows,
		// and whether the photo button is offered (an open workout with a gym).
		photoBlocks: await photoBlocksForSession(db, requireUser(locals).id, session.id),
		// Blocks named from a photo (0.6.1), for the Undo line on an open workout.
		namedPhotoBlocks: await namedPhotoBlocks(db, requireUser(locals).id, session.id),
		photoEnabled: session.endedAt == null && session.gymId != null
	};
};

async function liveEdit<T extends Record<string, unknown>>(id: string, run: () => Promise<T>) {
	if (!uuidParamSchema.safeParse(id).success) return fail(400, { message: 'Invalid session id' });
	try {
		return await run();
	} catch (e) {
		if (e instanceof WorkoutEditError || e instanceof MachineInputError)
			return fail(400, { message: e.message });
		throw e;
	}
}

const reopenEndedSessionSchema = z.object({
	allowEndedSessionEdit: z.literal('1')
});

const deleteEndedSessionSchema = z.object({
	confirmDelete: z.preprocess((v) => (typeof v === 'string' ? v.toLowerCase() : v), z.literal('d'))
});

export const actions: Actions = {
	acknowledgePhotoNotice: photoNoticeAction,
	removeSet: async ({ request, params, locals }) => {
		if (!uuidParamSchema.safeParse(params.id).success) {
			return fail(400, { message: 'Invalid session id' });
		}
		try {
			await removeEmptyLastSet(
				db,
				requireUser(locals).id,
				params.id,
				String((await request.formData()).get('setId'))
			);
			return { removed: true };
		} catch (e) {
			if (e instanceof z.ZodError || e instanceof MachineInputError)
				return fail(400, { message: e instanceof z.ZodError ? e.issues[0].message : e.message });
			throw e;
		}
	},
	appendSet: async ({ request, params, locals }) => {
		if (!uuidParamSchema.safeParse(params.id).success) {
			return fail(400, { message: 'Invalid session id' });
		}
		try {
			const added = await appendWorkoutSet(
				db,
				requireUser(locals).id,
				params.id,
				Object.fromEntries(await request.formData())
			);
			return { addedSetId: added.id };
		} catch (e) {
			if (e instanceof z.ZodError || e instanceof MachineInputError)
				return fail(400, { message: e instanceof z.ZodError ? e.issues[0].message : e.message });
			throw e;
		}
	},
	addExercise: async ({ request, params, locals }) => {
		if (!uuidParamSchema.safeParse(params.id).success) {
			return fail(400, { message: 'Invalid session id', setId: null });
		}
		try {
			const added = await addSessionExercise(
				db,
				requireUser(locals).id,
				params.id,
				Object.fromEntries(await request.formData())
			);
			return { addedExerciseId: added.id, addedMachineId: added.gymEquipmentId };
		} catch (e) {
			if (e instanceof z.ZodError || e instanceof MachineInputError)
				return fail(400, {
					message: e instanceof z.ZodError ? e.issues[0].message : e.message,
					setId: null
				});
			throw e;
		}
	},
	bindMachine: async ({ request, params, locals }) => {
		if (!uuidParamSchema.safeParse(params.id).success) {
			return fail(400, { message: 'Invalid session id', setId: null });
		}
		const form = Object.fromEntries(await request.formData());
		const userId = requireUser(locals).id;
		try {
			// From the add sheet (0.8.1): a machine named there is made first, in
			// the same transaction, so a refused bind leaves no new machine behind.
			await db.transaction(async (tx) => {
				let input = form;
				if (
					!form.gymEquipmentId &&
					typeof form.newMachineName === 'string' &&
					form.newMachineName.trim()
				) {
					const machine = await createMachine(tx, userId, {
						gymId: form.gymId,
						localLabel: form.newMachineName,
						equipmentType: form.equipmentType
					});
					input = { ...form, gymEquipmentId: machine.id };
				}
				await bindSessionMachine(tx, userId, params.id, String(form.occurrenceId), input);
			});
		} catch (e) {
			if (e instanceof z.ZodError || e instanceof MachineInputError)
				return fail(400, { message: e.message, setId: null });
			throw e;
		}
		redirect(303, `/sessions/${params.id}`);
	},
	/**
	 * Step 1 of a photo in the workout (0.6.0): store the photo and open its
	 * block, with no model call, so set entry starts at once. The page then
	 * submits `readPhoto` on its own. One `photo_upload` line, as on the gym page.
	 */
	photo: async ({ request, params, locals }) => {
		const started = performance.now();
		if (!uuidParamSchema.safeParse(params.id).success) {
			return fail(400, { message: 'Invalid session id', setId: null });
		}
		const userId = requireUser(locals).id;
		const session = await loadSession(db, userId, params.id, 'active');
		if (!session || session.endedAt)
			return fail(404, { message: 'Session not found', setId: null });
		if (!session.gymId) return fail(400, { message: 'This workout has no gym', setId: null });
		if (!(await hasPhotoNotice(db, userId)))
			return fail(400, { message: PHOTO_NOTICE_REQUIRED, setId: null });
		const form = await request.formData();
		const file = form.get('photo');
		if (!(file instanceof File) || file.size === 0) {
			return fail(400, { message: 'Choose a photo to upload.', setId: null });
		}
		const requestId = String(form.get('requestId') ?? '');
		const measured = { ...clientMeasurement(form), receivedBytes: file.size };
		const timings = emptyTimings();
		let result: Pick<UploadLogLine, 'outcome' | 'storedBytes' | 'photoId'> = {
			outcome: 'refused',
			storedBytes: null,
			photoId: null
		};
		try {
			const uploaded = await uploadPhoto(
				db,
				userId,
				{
					gymId: session.gymId,
					bytes: new Uint8Array(await file.arrayBuffer()),
					type: file.type,
					name: file.name
				},
				{ store: photoStore(), limits: resolvePhotoLimits(), timings }
			);
			if (!uploaded) return fail(404, { message: 'Gym not found', setId: null });
			result = { outcome: 'stored', storedBytes: uploaded.photo.bytes, photoId: uploaded.photo.id };
			const block = await openPhotoBlock(db, userId, params.id, uploaded.photo.id, {
				requestId: isUuid(requestId) ? requestId : undefined,
				timeLabel: String(form.get('timeLabel') ?? '')
			});
			return { photoId: uploaded.photo.id, photoBlockId: block.id };
		} catch (e) {
			if (e instanceof MachineInputError) return fail(400, { message: e.message, setId: null });
			const failed = photoFailure(e);
			return fail(failed.status, { ...failed.data, setId: null });
		} finally {
			logUpload({
				source: 'workout',
				...measured,
				...result,
				...timings,
				totalMs: msSince(started)
			});
		}
	},
	/**
	 * Step 2: read a photo block's photo, while sets are logged. Any failure
	 * (timeout, model error, the daily limit, no placard) leaves the block as it
	 * is; the page then shows one quiet line. Never an error page.
	 */
	readPhoto: async ({ request, params, locals }) => {
		if (!uuidParamSchema.safeParse(params.id).success) {
			return fail(400, { message: 'Invalid session id', setId: null });
		}
		const userId = requireUser(locals).id;
		const photoId = String((await request.formData()).get('photoId') ?? '');
		const blocks = await photoBlocksForSession(db, userId, params.id);
		if (!Object.values(blocks).some((b) => b.photoId === photoId))
			return fail(404, { message: 'Photo not found', setId: null });
		try {
			const outcome = await analyzePhoto(db, userId, photoId, {
				store: photoStore(),
				limits: resolvePhotoLimits()
			});
			if (!outcome?.ok) return { read: 'failed' as const, photoId };
			// A repeat visit names itself (0.6.1): exact code, name guard, a
			// machine of that model logged on before in this gym.
			const named = await autoIdentifyRepeatVisit(db, userId, params.id, photoId);
			return { read: named ? ('named' as const) : ('done' as const), photoId };
		} catch (e) {
			if (e instanceof PhotoLimitError) return { read: 'failed' as const, photoId };
			throw e;
		}
	},
	/** Undo a photo block's naming (0.6.1), on an open workout. */
	undoIdentify: async ({ request, params, locals }) => {
		if (!uuidParamSchema.safeParse(params.id).success) {
			return fail(400, { message: 'Invalid session id', setId: null });
		}
		const form = await request.formData();
		try {
			const undone = await undoPhotoIdentify(
				db,
				requireUser(locals).id,
				params.id,
				String(form.get('occurrenceId') ?? ''),
				{ timeLabel: String(form.get('timeLabel') ?? '') }
			);
			if (!undone) return fail(404, { message: 'Exercise not found in this session', setId: null });
			return { undone: undone.id };
		} catch (e) {
			if (e instanceof z.ZodError || e instanceof MachineInputError)
				return fail(400, { message: 'Exercise not found in this session', setId: null });
			throw e;
		}
	},
	/** Step 3: "Use this" on a photo block. Also on a finished workout: name it later. */
	identify: async ({ request, params, locals }) => {
		if (!uuidParamSchema.safeParse(params.id).success) {
			return fail(400, { message: 'Invalid session id', setId: null });
		}
		const form = Object.fromEntries(await request.formData());
		try {
			const done = await identifySessionExercise(
				db,
				requireUser(locals).id,
				params.id,
				String(form.occurrenceId),
				form
			);
			if (!done) return fail(404, { message: 'Exercise not found in this session', setId: null });
			return { identified: done.occurrence.id };
		} catch (e) {
			if (e instanceof z.ZodError || e instanceof MachineInputError)
				return fail(400, {
					message: e instanceof z.ZodError ? e.issues[0].message : e.message,
					setId: null
				});
			throw e;
		}
	},
	// Editing a live workout (editor spec, Part L). Each refuses an ended
	// workout and finds the exercise through the session (live-edit.ts).
	removeExercise: async ({ request, params, locals }) =>
		liveEdit(params.id, async () => {
			const form = await request.formData();
			const result = await removeSessionExercise(db, requireUser(locals).id, params.id, {
				occurrenceId: form.get('occurrenceId'),
				loggedCount: form.get('loggedCount')
			});
			return { removedExercise: result.removedSets };
		}),
	skipRest: async ({ request, params, locals }) =>
		liveEdit(params.id, async () => {
			const form = await request.formData();
			await skipRestOfExercise(db, requireUser(locals).id, params.id, {
				occurrenceId: form.get('occurrenceId')
			});
			return { skipped: true };
		}),
	moveExercise: async ({ request, params, locals }) =>
		liveEdit(params.id, async () => {
			const form = await request.formData();
			await moveSessionExercise(db, requireUser(locals).id, params.id, {
				occurrenceId: form.get('occurrenceId'),
				direction: form.get('direction')
			});
			return { moved: true };
		}),
	swapExercise: async ({ request, params, locals }) =>
		liveEdit(params.id, async () => {
			const form = Object.fromEntries(await request.formData());
			const swapped = await swapSessionExercise(db, requireUser(locals).id, params.id, form);
			return { swappedExerciseId: swapped.id };
		}),
	endSession: async ({ params, locals }) => {
		const parsedSessionId = uuidParamSchema.safeParse(params.id);
		if (!parsedSessionId.success) {
			return fail(400, { message: 'Invalid session id' });
		}
		const userId = requireUser(locals).id;
		const ended = await endSession(db, userId, parsedSessionId.data);
		// A swap chosen "From now on" reaches the program only now that the
		// workout has ended (editor spec, Part L); the finished workout's page
		// says whether it did.
		if (ended.updated) {
			const swaps = await applyProgramSwaps(db, userId, parsedSessionId.data);
			if (swaps.kind === 'updated')
				redirect(303, `/sessions/${parsedSessionId.data}?program=updated&to=${swaps.programId}`);
			if (swaps.kind === 'failed')
				redirect(303, `/sessions/${parsedSessionId.data}?program=${swaps.reason}`);
		}
		// Finishing with machines still to name is allowed; the finished
		// workout's page lists them (0.6.0). A quick workout also lands there,
		// where it can be saved as a program (Part M). Otherwise Home.
		const toName = await photoBlocksForSession(db, userId, parsedSessionId.data);
		const session = await loadSession(db, userId, parsedSessionId.data, 'ended-active');
		const quick = session
			? (await loadSessionDay(db, userId, session.dayId)).systemKind === 'quick'
			: false;
		redirect(303, Object.keys(toName).length || quick ? `/sessions/${parsedSessionId.data}` : '/');
	},

	updateSet: async ({ request, params, locals }) => {
		const parsedSessionId = uuidParamSchema.safeParse(params.id);
		if (!parsedSessionId.success) {
			return fail(400, { setId: null, message: 'Invalid session id' });
		}

		const form = await request.formData();
		const setId = form.get('setId');
		if (typeof setId !== 'string' || setId.length === 0) {
			return fail(400, { setId: null, message: 'Missing setId' });
		}
		if (!uuidParamSchema.safeParse(setId).success) {
			return fail(400, { setId: null, message: 'Invalid setId' });
		}

		const allowEndedSessionEditRaw = form.get('allowEndedSessionEdit');
		const allowEndedSessionEdit = reopenEndedSessionSchema.safeParse({
			allowEndedSessionEdit: allowEndedSessionEditRaw
		}).success;

		const result = await updateSetInSession(
			db,
			requireUser(locals).id,
			parsedSessionId.data,
			setId,
			{
				executedLoad: form.get('executedLoad'),
				expectedIdentity: form.get('expectedIdentity'),
				executedReps: form.get('executedReps'),
				executedRir: form.get('executedRir'),
				notes: form.get('notes')
			},
			{ allowEndedSession: allowEndedSessionEdit }
		);

		if (!result.ok) {
			return fail(result.status, {
				setId: result.setId,
				...(result.message !== undefined && { message: result.message }),
				...(result.fieldErrors !== undefined && {
					fieldErrors: result.fieldErrors
				})
			});
		}

		// Refresh saved status in place without moving focus or clearing other drafts.
		return { savedSetId: result.setId };
	},

	deleteSession: async ({ request, params, locals }) => {
		const parsedSessionId = uuidParamSchema.safeParse(params.id);
		if (!parsedSessionId.success) {
			return fail(400, { message: 'Invalid session id' });
		}

		const form = await request.formData();
		const parsed = deleteEndedSessionSchema.safeParse({
			confirmDelete: form.get('confirmDelete')
		});
		if (!parsed.success) {
			return fail(400, { message: 'Press d in the delete box to confirm' });
		}

		const activeSession = await loadSession(
			db,
			requireUser(locals).id,
			parsedSessionId.data,
			'ended-active'
		);
		if (!activeSession) {
			return fail(404, { message: 'Session not found' });
		}

		const result = await softDeleteEndedSession(db, requireUser(locals).id, parsedSessionId.data);
		if (!result.ok) {
			return fail(result.status, { message: result.message });
		}

		// A quick workout's program has no page (0.5.1); History lists them.
		const { systemKind } = await loadSessionDay(db, requireUser(locals).id, activeSession.dayId);
		redirect(303, systemKind === 'quick' ? '/history' : `/programs/${activeSession.programId}`);
	}
};
