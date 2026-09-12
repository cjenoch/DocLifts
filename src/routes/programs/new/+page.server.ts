import { fail, redirect } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { blankProgramDraft, MAX_PROGRAM_DRAFT_CHARS } from '$lib/program-draft';
import { db } from '$lib/server/db';
import { listProgramExercises, saveProgramDraft } from '$lib/server/program-builder';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async () => ({
	library: await listProgramExercises(db),
	requestId: randomUUID(),
	draft: blankProgramDraft(),
	sourceProgramId: null
});

export const actions: Actions = {
	default: async ({ request }) => {
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
			result = await saveProgramDraft(db, { requestId, sourceProgramId: null, draft });
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
