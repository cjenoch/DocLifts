import { fail } from '@sveltejs/kit';
import { ZodError } from 'zod';
import { db } from '$lib/server/db';
import { requireUser } from '$lib/server/request-user';
import { MachineInputError } from '$lib/server/machines';
import {
	exercisesForPage,
	hideExercise,
	renameExercise,
	restoreExercise,
	setExerciseRegion
} from '$lib/server/exercise-admin';
import type { Actions, PageServerLoad } from './$types';

/** The Exercises page (0.8.0, machines spec Part J): rename, region, hide. */
export const load: PageServerLoad = async ({ locals }) =>
	exercisesForPage(db, requireUser(locals).id);

function inputFailure(e: unknown) {
	if (e instanceof ZodError)
		return fail(400, { message: e.issues.map((i) => i.message).join('; ') });
	if (e instanceof MachineInputError) return fail(400, { message: e.message });
	throw e;
}

const notFound = () => fail(404, { message: 'Exercise not found' });

export const actions: Actions = {
	rename: async ({ request, locals }) => {
		const form = Object.fromEntries(await request.formData());
		try {
			const row = await renameExercise(db, requireUser(locals).id, String(form.id), form);
			return row ? { saved: row.id } : notFound();
		} catch (e) {
			return inputFailure(e);
		}
	},
	region: async ({ request, locals }) => {
		const form = Object.fromEntries(await request.formData());
		try {
			const row = await setExerciseRegion(db, requireUser(locals).id, String(form.id), form);
			return row ? { saved: row.id } : notFound();
		} catch (e) {
			return inputFailure(e);
		}
	},
	hide: async ({ request, locals }) => {
		const id = String((await request.formData()).get('id') ?? '');
		return (await hideExercise(db, requireUser(locals).id, id)) ? { hidden: id } : notFound();
	},
	restore: async ({ request, locals }) => {
		const id = String((await request.formData()).get('id') ?? '');
		return (await restoreExercise(db, requireUser(locals).id, id)) ? { restored: id } : notFound();
	}
};
