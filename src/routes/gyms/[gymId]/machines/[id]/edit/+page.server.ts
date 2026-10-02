import { error, fail, redirect } from '@sveltejs/kit';
import { ZodError } from 'zod';
import { db } from '$lib/server/db';
import { loadMachine, MachineInputError, updateMachine } from '$lib/server/machines';
import {
	applyStandardStack,
	changeMachineModel,
	machineRemovalPlan,
	mergeCandidates,
	mergeMachines,
	mergePreview,
	removeMachine,
	replaceMachine,
	undoableMergeInto,
	undoMerge
} from '$lib/server/machine-admin';
import { modelChoices } from '$lib/server/catalog';
import { requireUser } from '$lib/server/request-user';
import type { Actions, PageServerLoad } from './$types';

/** Search results shown under "Change model": enough to find one, no more. */
const MODEL_RESULTS = 20;

// The machine is resolved through its gym and the gym's owner, in one query:
// another user's machine, or one under a different gym, is a 404 (D6).
export const load: PageServerLoad = async ({ params, locals, url }) => {
	const userId = requireUser(locals).id;
	const found = await loadMachine(db, userId, params.gymId, params.id);
	if (!found) error(404, 'Machine not found');
	// Remove, change model and merge (0.7.0, machines spec Parts G, H, K).
	const q = (url.searchParams.get('q') ?? '').trim().slice(0, 120);
	const models = q ? (await modelChoices(db, userId, { q })).models.slice(0, MODEL_RESULTS) : [];
	const mergeWith = url.searchParams.get('merge') ?? '';
	const candidates = await mergeCandidates(db, userId, params.gymId, params.id);
	const other = candidates.find((c) => c.id === mergeWith) ?? null;
	return {
		...found,
		removal: await machineRemovalPlan(db, userId, params.gymId, params.id),
		q,
		models,
		candidates,
		mergeWith: other,
		preview: other ? await mergePreview(db, userId, params.gymId, params.id, other.id) : null,
		undoable: await undoableMergeInto(db, userId, params.id)
	};
};

function inputFailure(e: unknown) {
	if (e instanceof ZodError)
		return fail(400, { message: e.issues.map((i) => i.message).join('; ') });
	if (e instanceof MachineInputError)
		return fail(e.message === 'Model not found' ? 404 : 400, { message: e.message });
	throw e;
}

const editPage = (gymId: string, id: string) => `/gyms/${gymId}/machines/${id}/edit`;

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
			return inputFailure(e);
		}
		redirect(303, `/gyms?gym=${params.gymId}`);
	},
	remove: async ({ params, locals }) => {
		let outcome: string;
		try {
			const done = await removeMachine(db, requireUser(locals).id, params.gymId, params.id);
			if (!done) return fail(404, { message: 'Machine not found' });
			outcome = done.outcome;
		} catch (e) {
			return inputFailure(e);
		}
		redirect(303, `/gyms?gym=${params.gymId}&removed=${outcome}`);
	},
	changeModel: async ({ params, request, locals }) => {
		try {
			const done = await changeMachineModel(
				db,
				requireUser(locals).id,
				params.gymId,
				params.id,
				Object.fromEntries(await request.formData())
			);
			if (!done) return fail(404, { message: 'Machine not found' });
			if (done.outcome === 'replace')
				return { replaceModelId: done.modelId, replaceLabel: done.label };
			return { changed: true, stackOffer: done.stackOffer };
		} catch (e) {
			return inputFailure(e);
		}
	},
	replace: async ({ params, request, locals }) => {
		let next: string;
		try {
			const done = await replaceMachine(
				db,
				requireUser(locals).id,
				params.gymId,
				params.id,
				Object.fromEntries(await request.formData())
			);
			if (!done) return fail(404, { message: 'Machine not found' });
			next = done.machine.id;
		} catch (e) {
			return inputFailure(e);
		}
		redirect(303, editPage(params.gymId, next));
	},
	applyStack: async ({ params, locals }) => {
		const row = await applyStandardStack(db, requireUser(locals).id, params.gymId, params.id);
		if (!row) return fail(404, { message: 'Machine not found' });
		return { stackApplied: row.stackLb };
	},
	merge: async ({ params, request, locals }) => {
		const form = Object.fromEntries(await request.formData());
		const keptId = String(form.keptId ?? '');
		const droppedId = keptId === params.id ? String(form.otherId ?? '') : params.id;
		try {
			const done = await mergeMachines(db, requireUser(locals).id, params.gymId, {
				keptId,
				droppedId
			});
			if (!done) return fail(404, { message: 'Machine not found' });
		} catch (e) {
			return inputFailure(e);
		}
		redirect(303, editPage(params.gymId, keptId));
	},
	undoMerge: async ({ params, request, locals }) => {
		try {
			const done = await undoMerge(
				db,
				requireUser(locals).id,
				String((await request.formData()).get('mergeId') ?? '')
			);
			if (!done) return fail(404, { message: 'Merge not found' });
		} catch (e) {
			return inputFailure(e);
		}
		redirect(303, editPage(params.gymId, params.id));
	}
};
