import { fail } from '@sveltejs/kit';
import { ZodError } from 'zod';
import { db } from '$lib/server/db';
import { createGym, createMachine, machineChoices, MachineInputError } from '$lib/server/machines';
import { requireUser } from '$lib/server/request-user';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) =>
	machineChoices(db, requireUser(locals).id);

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
