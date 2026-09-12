import { error, fail, redirect } from '@sveltejs/kit';
import { asc, eq, sql } from 'drizzle-orm';
import {
	db,
	dayExercises,
	days,
	exercises,
	sessions,
	sessionExercises,
	sets
} from '$lib/server/db';
import { getLastCompletedSet, type HistoryRow } from '$lib/server/progression';
import {
	endSession,
	loadSession,
	nextSetIdInSession,
	softDeleteEndedSession,
	updateSetInSession
} from '$lib/server/sessions';
import { z } from 'zod';
import {
	addSessionExercise,
	bindSessionMachine,
	machineChoices,
	MachineInputError
} from '$lib/server/machines';
import type { Actions, PageServerLoad } from './$types';

const uuidParamSchema = z.string().uuid();

export const load: PageServerLoad = async ({ params, url }) => {
	const parsedSessionId = uuidParamSchema.safeParse(params.id);
	if (!parsedSessionId.success) {
		error(400, 'Invalid session id');
	}

	const session = await loadSession(db, parsedSessionId.data, 'active');
	if (!session) {
		error(404, 'Session not found');
	}

	const [day] = await db.select().from(days).where(eq(days.id, session.dayId)).limit(1);
	if (!day) {
		// Defensive: FK guarantees existence.
		error(500, 'Day missing for session');
	}

	// Day's exercise ordering + tier (for grouping + display).
	const dayExs = await db
		.select({
			exerciseId: dayExercises.exerciseId,
			position: dayExercises.position,
			tier: dayExercises.tier,
			progressionPolicy: dayExercises.progressionPolicy
		})
		.from(dayExercises)
		.where(eq(dayExercises.dayId, day.id))
		.orderBy(asc(dayExercises.position));

	const exerciseMeta = new Map(
		dayExs.map((de) => [
			de.exerciseId,
			{
				position: de.position,
				tier: de.tier,
				progressionPolicy: de.progressionPolicy
			}
		])
	);

	const sessionSets = await db
		.select({
			id: sets.id,
			exerciseId: sets.exerciseId,
			exerciseName: sql<string>`coalesce(${sessionExercises.exerciseName}, ${exercises.name})`,
			sessionExerciseId: sets.sessionExerciseId,
			gymEquipmentId: sets.gymEquipmentId,
			loadConvention: sets.loadConvention,
			machineLabel: sessionExercises.machineLabel,
			gymName: sessionExercises.gymName,
			modelName: sessionExercises.modelName,
			occurrencePosition: sessionExercises.position,
			occurrenceTier: sessionExercises.tier,
			occurrencePolicy: sessionExercises.progressionPolicy,
			position: sets.position,
			setRole: sets.setRole,
			targetMetric: sets.targetMetric,
			prescribedLoad: sets.prescribedLoad,
			prescribedRepsMin: sets.prescribedRepsMin,
			prescribedRepsMax: sets.prescribedRepsMax,
			prescribedRir: sets.prescribedRir,
			suggestionReasoning: sets.suggestionReasoning,
			executedLoad: sets.executedLoad,
			executedReps: sets.executedReps,
			executedRir: sets.executedRir,
			notes: sets.notes
		})
		.from(sets)
		.innerJoin(exercises, eq(sets.exerciseId, exercises.id))
		.leftJoin(sessionExercises, eq(sessionExercises.id, sets.sessionExerciseId))
		.where(eq(sets.sessionId, session.id))
		.orderBy(asc(sets.position));

	// Per-set history for inline display. N+1 by design (MVP).
	// Exclude THIS session — once it ends, its own set would otherwise become
	// "the most recent completed" and the "Last: …" line would duplicate the
	// executed value shown right above it in the same row.
	const histories = await Promise.all(
		sessionSets.map((s) =>
			getLastCompletedSet(db, s.exerciseId, s.setRole, s.position, session.id, s)
		)
	);

	type SetRow = (typeof sessionSets)[number] & { history: HistoryRow | null };
	type Group = {
		key: string;
		occurrenceId: string | null;
		position: number;
		machineLabel: string | null;
		gymName: string | null;
		modelName: string | null;
		loadConvention: string;
		exerciseId: string;
		exerciseName: string;
		tier: 'main' | 'secondary' | 'isolation' | null;
		progressionPolicy: 'standard' | 'cautious' | 'hold' | null;
		sets: SetRow[];
	};

	const groupMap = new Map<string, Group>();
	sessionSets.forEach((s, i) => {
		const key = s.sessionExerciseId ?? s.exerciseId;
		let g = groupMap.get(key);
		if (!g) {
			const meta = exerciseMeta.get(s.exerciseId);
			g = {
				key,
				occurrenceId: s.sessionExerciseId,
				position: s.occurrencePosition ?? meta?.position ?? 0,
				machineLabel: s.machineLabel,
				gymName: s.gymName,
				modelName: s.modelName,
				loadConvention: s.loadConvention,
				exerciseId: s.exerciseId,
				exerciseName: s.exerciseName,
				tier: s.occurrenceTier ?? meta?.tier ?? null,
				progressionPolicy: s.occurrencePolicy ?? meta?.progressionPolicy ?? null,
				sets: []
			};
			groupMap.set(key, g);
		}
		g.sets.push({ ...s, history: histories[i] });
	});

	const groups = [...groupMap.values()].sort((a, b) => a.position - b.position);
	for (const g of groups) g.sets.sort((a, b) => a.position - b.position);

	const allowEndedSessionEdit = session.endedAt != null && url.searchParams.get('edit') === '1';

	return { session, day, groups, allowEndedSessionEdit, choices: await machineChoices(db) };
};

const reopenEndedSessionSchema = z.object({
	allowEndedSessionEdit: z.literal('1')
});

const deleteEndedSessionSchema = z.object({
	confirmDelete: z.preprocess((v) => (typeof v === 'string' ? v.toLowerCase() : v), z.literal('d'))
});

export const actions: Actions = {
	addExercise: async ({ request, params }) => {
		try {
			await addSessionExercise(db, params.id, Object.fromEntries(await request.formData()));
		} catch (e) {
			if (e instanceof z.ZodError || e instanceof MachineInputError)
				return fail(400, { message: e.message, setId: null });
			throw e;
		}
		redirect(303, `/sessions/${params.id}`);
	},
	bindMachine: async ({ request, params }) => {
		const form = Object.fromEntries(await request.formData());
		try {
			await bindSessionMachine(db, params.id, String(form.occurrenceId), form);
		} catch (e) {
			if (e instanceof z.ZodError || e instanceof MachineInputError)
				return fail(400, { message: e.message, setId: null });
			throw e;
		}
		redirect(303, `/sessions/${params.id}`);
	},
	endSession: async ({ params }) => {
		const parsedSessionId = uuidParamSchema.safeParse(params.id);
		if (!parsedSessionId.success) {
			return fail(400, { message: 'Invalid session id' });
		}
		await endSession(db, parsedSessionId.data);
		redirect(303, '/');
	},

	updateSet: async ({ request, params }) => {
		const parsedSessionId = uuidParamSchema.safeParse(params.id);
		if (!parsedSessionId.success) {
			return fail(400, { setId: null, message: 'Invalid session id' });
		}

		const form = await request.formData();
		const setId = form.get('setId');
		if (typeof setId !== 'string' || setId.length === 0) {
			return fail(400, { setId: null, message: 'Missing setId' });
		}

		const allowEndedSessionEditRaw = form.get('allowEndedSessionEdit');
		const allowEndedSessionEdit = reopenEndedSessionSchema.safeParse({
			allowEndedSessionEdit: allowEndedSessionEditRaw
		}).success;

		const result = await updateSetInSession(
			db,
			parsedSessionId.data,
			setId,
			{
				executedLoad: form.get('executedLoad'),
				expectedIdentity: form.get('expectedIdentity'),
				executedReps: form.get('executedReps'),
				executedRir: form.get('executedRir'),
				notes: form.get('notes')
			},
			{ allowEndedSession: allowEndedSessionEdit }
		);

		if (!result.ok) {
			return fail(result.status, {
				setId: result.setId,
				...(result.message !== undefined && { message: result.message }),
				...(result.fieldErrors !== undefined && {
					fieldErrors: result.fieldErrors
				})
			});
		}

		// Redirect to the same page with a fragment anchoring the NEXT row,
		// so saving scrolls the user toward what they're about to log instead
		// of resetting to top. Falls back to the just-saved row when there's
		// no next set (last row of the session). Browser-native scroll-to-
		// anchor; no client JS required.
		const nextId = await nextSetIdInSession(db, parsedSessionId.data, result.setId);
		redirect(303, `/sessions/${parsedSessionId.data}#set-${nextId ?? result.setId}`);
	},

	deleteSession: async ({ request, params }) => {
		const parsedSessionId = uuidParamSchema.safeParse(params.id);
		if (!parsedSessionId.success) {
			return fail(400, { message: 'Invalid session id' });
		}

		const form = await request.formData();
		const parsed = deleteEndedSessionSchema.safeParse({
			confirmDelete: form.get('confirmDelete')
		});
		if (!parsed.success) {
			return fail(400, { message: 'Press d in the delete box to confirm' });
		}

		const activeSession = await loadSession(db, parsedSessionId.data, 'ended-active');
		if (!activeSession) {
			return fail(404, { message: 'Session not found' });
		}

		const result = await softDeleteEndedSession(db, parsedSessionId.data);
		if (!result.ok) {
			return fail(result.status, { message: result.message });
		}

		redirect(303, `/programs/${activeSession.programId}`);
	}
};
