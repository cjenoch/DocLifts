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
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	if (!z.uuid().safeParse(params.id).success) error(400, 'Invalid program id');
	const [library, draft] = await Promise.all([
		listProgramExercises(db),
		loadProgramDraft(db, params.id).catch((cause: unknown) => {
			if (cause instanceof ProgramNotFoundError) error(404, 'Program not found');
			throw cause;
		})
	]);
	return { library, requestId: randomUUID(), draft, sourceProgramId: params.id };
};

export const actions: Actions = {
	default: async ({ request, params }) => {
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
			result = await saveProgramDraft(db, { requestId, sourceProgramId: params.id, draft });
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
