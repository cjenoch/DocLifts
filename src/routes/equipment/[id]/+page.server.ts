import { error, fail } from '@sveltejs/kit';
import { ZodError } from 'zod';
import { db } from '$lib/server/db';
import { gymsOf, instancesOfModel, loadModel } from '$lib/server/catalog';
import { createMachine, MachineInputError } from '$lib/server/machines';
import { requireUser } from '$lib/server/request-user';
import type { Actions, PageServerLoad } from './$types';

// A global model is visible to everyone; another user's owned model is a 404,
// identical to an id that never existed (D6).
export const load: PageServerLoad = async ({ params, locals }) => {
	const userId = requireUser(locals).id;
	const model = await loadModel(db, userId, params.id);
	if (!model) error(404, 'Model not found');
	const [instances, myGyms] = await Promise.all([
		instancesOfModel(db, userId, model.id),
		gymsOf(db, userId)
	]);
	return { model, instances, gyms: myGyms, userId };
};

export const actions: Actions = {
	// Creates a gym_equipment row in one of THIS user's gyms. createMachine
	// scopes the gym by owner and the model by modelVisibleTo, so neither a
	// foreign gym nor a foreign model gets through even if the page is bypassed.
	addToGym: async ({ params, request, locals }) => {
		const userId = requireUser(locals).id;
		const model = await loadModel(db, userId, params.id);
		if (!model) return fail(404, { message: 'Model not found' });
		const form = Object.fromEntries(await request.formData());
		try {
			await createMachine(db, userId, {
				gymId: form.gymId,
				localLabel: form.localLabel,
				stackLb: form.stackLb,
				incrementLb: form.incrementLb,
				equipmentType: model.loadingType,
				equipmentModelId: model.id
			});
			return { message: 'Added to your gym' };
		} catch (e) {
			if (e instanceof ZodError)
				return fail(400, { message: e.issues.map((i) => i.message).join('; ') });
			if (e instanceof MachineInputError) return fail(400, { message: e.message });
			throw e;
		}
	}
};
