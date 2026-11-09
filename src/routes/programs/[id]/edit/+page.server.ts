import { error, fail, redirect } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { MAX_PROGRAM_DRAFT_CHARS } from '$lib/program-draft';
import { db } from '$lib/server/db';
import {
	listProgramExercises,
	loadProgramDraft,
	ProgramNotFoundError,
	saveProgramDraft
} from '$lib/server/program-builder';
import { requireUser } from '$lib/server/request-user';
import { programVersionState } from '$lib/server/program-versions';
import { programDraftWithWorkoutDay, WorkoutNotFoundError } from '$lib/server/workout-to-program';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals, url }) => {
	if (!z.uuid().safeParse(params.id).success) error(400, 'Invalid program id');
	const userId = requireUser(locals).id;
	// Part M: a finished workout added as this program's last day.
	const fromSession = url.searchParams.get('fromSession');
	const [library, draft] = await Promise.all([
		listProgramExercises(db, userId),
		(fromSession
			? programDraftWithWorkoutDay(db, userId, params.id, fromSession)
			: loadProgramDraft(db, userId, params.id)
		).catch((cause: unknown) => {
			if (cause instanceof ProgramNotFoundError) error(404, 'Program not found');
			if (cause instanceof WorkoutNotFoundError) error(404, 'Workout not found');
			throw cause;
		})
	]);
	// A retired version cannot be saved (ProgramInactiveError), so its editor
	// never opens: the retired program page says it was replaced and links to
	// the current version (owner decision, 2026-11-08). Checked after the draft
	// loads, so a foreign or absent program is still the 404 above (D6).
	if ((await programVersionState(db, userId, params.id))?.isActive === false)
		redirect(303, `/programs/${params.id}`);
	return {
		library,
		requestId: randomUUID(),
		draft,
		sourceProgramId: params.id,
		draftKey: fromSession ? `${params.id}:from:${fromSession}` : params.id,
		openDay: fromSession ? draft.days.length - 1 : null
	};
};

export const actions: Actions = {
	default: async ({ request, params, locals }) => {
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
			if (!z.uuid().safeParse(params.id).success) {
				return fail(400, { error: 'Invalid program id', draft, requestId });
			}
			// The route, never a hidden client field, determines the source version.
			result = await saveProgramDraft(db, requireUser(locals).id, {
				requestId,
				sourceProgramId: params.id,
				draft
			});
		} catch (cause) {
			return fail(400, {
				error:
					cause instanceof Error
						? cause.message
						: 'Unable to save this version. Check the draft and retry.',
				draft,
				requestId
			});
		}
		redirect(303, `/programs/${result.id}`);
	}
};
