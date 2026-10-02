import { fail } from '@sveltejs/kit';
import { ZodError } from 'zod';
import { db } from '$lib/server/db';
import { createGym, createMachine, machineChoices, MachineInputError } from '$lib/server/machines';
import {
	archivedRows,
	gymRemovalPlan,
	removeGym,
	restoreGym,
	restoreMachine
} from '$lib/server/machine-admin';
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
	// Remove and restore (0.7.0, machines spec Part G): what Remove would do to
	// each gym, and the Archived sections.
	const removal = Object.fromEntries(
		await Promise.all(
			choices.gyms.map(async (g) => [g.id, await gymRemovalPlan(db, userId, g.id)] as const)
		)
	);
	const removed = url.searchParams.get('removed');
	return {
		...choices,
		...picker,
		photos,
		selectedGymId: gym?.id ?? '',
		q: params.q ?? '',
		removal,
		archived: await archivedRows(db, userId),
		removed: removed === 'deleted' || removed === 'archived' ? removed : null
	};
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
	removeGym: async ({ request, locals }) => {
		try {
			const gymId = String((await request.formData()).get('gymId') ?? '');
			const done = await removeGym(db, requireUser(locals).id, gymId);
			if (!done) return fail(404, { message: 'Gym not found' });
			return { message: done.outcome === 'deleted' ? 'Gym deleted.' : 'Gym removed.' };
		} catch (e) {
			return inputFailure(e);
		}
	},
	restoreGym: async ({ request, locals }) => {
		const gymId = String((await request.formData()).get('gymId') ?? '');
		if (!(await restoreGym(db, requireUser(locals).id, gymId)))
			return fail(404, { message: 'Gym not found' });
		return { message: 'Gym restored.' };
	},
	restoreMachine: async ({ request, locals }) => {
		const form = await request.formData();
		try {
			const done = await restoreMachine(
				db,
				requireUser(locals).id,
				String(form.get('gymId') ?? ''),
				String(form.get('machineId') ?? '')
			);
			if (!done) return fail(404, { message: 'Machine not found' });
			return { message: 'Machine restored.' };
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
