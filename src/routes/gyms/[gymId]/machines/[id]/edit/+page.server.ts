import { error, fail, redirect } from '@sveltejs/kit';
import { ZodError } from 'zod';
import { db } from '$lib/server/db';
import { loadMachine, MachineInputError, updateMachine } from '$lib/server/machines';
import { requireUser } from '$lib/server/request-user';
import type { Actions, PageServerLoad } from './$types';

// The machine is resolved through its gym and the gym's owner, in one query:
// another user's machine, or one under a different gym, is a 404 (D6).
export const load: PageServerLoad = async ({ params, locals }) => {
	const userId = requireUser(locals).id;
	const found = await loadMachine(db, userId, params.gymId, params.id);
	if (!found) error(404, 'Machine not found');
	return found;
};

export const actions: Actions = {
	update: async ({ params, request, locals }) => {
		const userId = requireUser(locals).id;
		try {
			const row = await updateMachine(
				db,
				userId,
				params.gymId,
				params.id,
				Object.fromEntries(await request.formData())
			);
			if (!row) return fail(404, { message: 'Machine not found' });
		} catch (e) {
			if (e instanceof ZodError)
				return fail(400, { message: e.issues.map((i) => i.message).join('; ') });
			if (e instanceof MachineInputError) return fail(400, { message: e.message });
			throw e;
		}
		redirect(303, `/gyms?gym=${params.gymId}`);
	}
};
