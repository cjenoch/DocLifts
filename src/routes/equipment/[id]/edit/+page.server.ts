import { error, fail, redirect } from '@sveltejs/kit';
import { ZodError } from 'zod';
import { db } from '$lib/server/db';
import { copyModelForUser, loadModel, updateOwnedModel } from '$lib/server/catalog';
import { requireUser } from '$lib/server/request-user';
import type { Actions, PageServerLoad } from './$types';

// Your own model: an edit form. A global (catalog) model: not editable in
// place — the page offers "create my own copy" instead. Another user's model:
// 404, like a missing id (D6).
export const load: PageServerLoad = async ({ params, locals }) => {
	const userId = requireUser(locals).id;
	const model = await loadModel(db, userId, params.id);
	if (!model) error(404, 'Model not found');
	return { model, editable: model.ownerUserId === userId };
};

function invalid(e: unknown) {
	if (e instanceof ZodError)
		return fail(400, { message: e.issues.map((i) => i.message).join('; ') });
	throw e;
}

export const actions: Actions = {
	// Only ever an owned row: the owner is in the UPDATE's WHERE. A global or
	// foreign id updates nothing and answers 404.
	update: async ({ params, request, locals }) => {
		const userId = requireUser(locals).id;
		try {
			const row = await updateOwnedModel(
				db,
				userId,
				params.id,
				Object.fromEntries(await request.formData())
			);
			if (!row) return fail(404, { message: 'Model not found' });
		} catch (e) {
			return invalid(e);
		}
		redirect(303, `/equipment/${params.id}`);
	},
	copy: async ({ params, request, locals }) => {
		const userId = requireUser(locals).id;
		let copyId: string;
		try {
			const copy = await copyModelForUser(
				db,
				userId,
				params.id,
				Object.fromEntries(await request.formData())
			);
			if (!copy) return fail(404, { message: 'Model not found' });
			copyId = copy.id;
		} catch (e) {
			return invalid(e);
		}
		redirect(303, `/equipment/${copyId}`);
	}
};
