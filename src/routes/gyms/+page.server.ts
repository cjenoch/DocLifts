import { fail } from '@sveltejs/kit';
import { ZodError } from 'zod';
import { db } from '$lib/server/db';
import { createGym, createMachine, machineChoices, MachineInputError } from '$lib/server/machines';
import { requireUser } from '$lib/server/request-user';
import { modelChoices, parsePickerParams } from '$lib/server/catalog';
import { photoIdsByMachine } from '$lib/server/photos';
import type { Actions, PageServerLoad } from './$types';

// The model list is narrowed server-side by GET parameters (`gym`, `q`,
// `all=1`): the gym's own manufacturers by default, everything on request.
export const load: PageServerLoad = async ({ locals, url }) => {
	const userId = requireUser(locals).id;
	const choices = await machineChoices(db, userId);
	const params = parsePickerParams(url.searchParams);
	// Default to the first gym, so a first visit already shows that gym's
	// manufacturers. An id that is not one of this user's gyms falls back too.
	const gym = choices.gyms.find((g) => g.id === params.gym) ?? choices.gyms[0];
	const picker = await modelChoices(db, userId, { ...params, gym: gym?.id });
	const photos = await photoIdsByMachine(db, userId);
	return { ...choices, ...picker, photos, selectedGymId: gym?.id ?? '', q: params.q ?? '' };
};

function inputFailure(error: unknown) {
	if (error instanceof ZodError)
		return fail(400, { message: error.issues.map((i) => i.message).join('; ') });
	if (error instanceof MachineInputError) return fail(400, { message: error.message });
	throw error;
}

export const actions: Actions = {
	createGym: async ({ request, locals }) => {
		try {
			await createGym(db, requireUser(locals).id, Object.fromEntries(await request.formData()));
			return { message: 'Gym created' };
		} catch (e) {
			return inputFailure(e);
		}
	},
	createMachine: async ({ request, locals }) => {
		try {
			await createMachine(db, requireUser(locals).id, Object.fromEntries(await request.formData()));
			return { message: 'Machine created' };
		} catch (e) {
			return inputFailure(e);
		}
	}
};
