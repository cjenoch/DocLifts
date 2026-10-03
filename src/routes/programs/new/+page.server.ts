import { error, fail, redirect } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { blankProgramDraft, MAX_PROGRAM_DRAFT_CHARS } from '$lib/program-draft';
import { db } from '$lib/server/db';
import { listProgramExercises, saveProgramDraft } from '$lib/server/program-builder';
import { requireUser } from '$lib/server/request-user';
import { programDraftFromWorkout, WorkoutNotFoundError } from '$lib/server/workout-to-program';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	const userId = requireUser(locals).id;
	// Save a finished workout as a program (editor spec, Part M): the editor
	// opens on a draft built from it. Nothing is created until it is saved.
	const fromSession = url.searchParams.get('fromSession');
	let draft = blankProgramDraft();
	if (fromSession) {
		try {
			draft = await programDraftFromWorkout(db, userId, fromSession);
		} catch (cause) {
			if (cause instanceof WorkoutNotFoundError) error(404, 'Workout not found');
			throw cause;
		}
	}
	return {
		library: await listProgramExercises(db, userId),
		requestId: randomUUID(),
		draft,
		sourceProgramId: null,
		// Its own stored draft, so another unsaved program is not picked up.
		draftKey: fromSession ? `new:from:${fromSession}` : 'new',
		openDay: fromSession ? 0 : null
	};
};

export const actions: Actions = {
	default: async ({ request, locals }) => {
		let values: FormData;
		try {
			values = await request.formData();
		} catch {
			return fail(400, {
				error: 'Unable to read this program submission. Check its size and retry.'
			});
		}
		const requestId = String(values.get('requestId') ?? '');
		let draft: unknown;
		let result: { id: string };
		try {
			const payload = values.get('payload');
			if (typeof payload !== 'string' || payload.length > MAX_PROGRAM_DRAFT_CHARS) {
				return fail(400, {
					error: `Missing or oversized program draft (maximum ${MAX_PROGRAM_DRAFT_CHARS.toLocaleString('en-US')} characters).`,
					requestId
				});
			}
			draft = JSON.parse(payload);
			result = await saveProgramDraft(db, requireUser(locals).id, {
				requestId,
				sourceProgramId: null,
				draft
			});
		} catch (cause) {
			return fail(400, {
				error:
					cause instanceof Error
						? cause.message
						: 'Unable to save this program. Check the draft and retry.',
				draft,
				requestId
			});
		}
		redirect(303, `/programs/${result.id}`);
	}
};
