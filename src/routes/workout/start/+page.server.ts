import { fail, redirect } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { requireUser } from '$lib/server/request-user';
import {
	openQuickSessionId,
	quickStartChoices,
	startQuickSessionFromForm
} from '$lib/server/quick-workouts';
import type { Actions, PageServerLoad } from './$types';

// The gym step before a quick workout opens (0.5.1). An open quick workout
// skips the step: Home already offers "Resume workout", and a stale tab or a
// back button lands in the open workout rather than asking again.
export const load: PageServerLoad = async ({ locals }) => {
	const userId = requireUser(locals).id;
	const open = await openQuickSessionId(db, userId);
	if (open) redirect(303, `/sessions/${open}`);
	return quickStartChoices(db, userId);
};

export const actions: Actions = {
	default: async ({ request, locals }) => {
		const form = await request.formData();
		const result = await startQuickSessionFromForm(db, requireUser(locals).id, {
			gymId: form.get('gymId'),
			newGymName: form.get('newGymName')
		});
		if (!result.ok) return fail(result.status, { message: result.message });
		redirect(303, `/sessions/${result.sessionId}`);
	}
};
