import { error, fail, redirect } from '@sveltejs/kit';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { db, days, programs, sessions } from '$lib/server/db';
import {
	listDeletedSessionsForProgram,
	loadProgramOwnedSession,
	restoreSoftDeletedSession,
	softDeleteEndedSession,
	startSessionForDay,
	hardDeleteSession,
	purgeDeletedSessionsForProgram,
} from '$lib/server/sessions';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';

const uuidParamSchema = z.string().uuid();

export const load: PageServerLoad = async ({ params }) => {
	const parsedProgramId = uuidParamSchema.safeParse(params.id);
	if (!parsedProgramId.success) {
		error(400, 'Invalid program id');
	}

	const [program] = await db
		.select()
		.from(programs)
		.where(eq(programs.id, parsedProgramId.data))
		.limit(1);

	if (!program) {
		error(404, 'Program not found');
	}

	const programDays = await db
		.select({
			id: days.id,
			name: days.name,
			position: days.position,
			alternateGroupId: days.alternateGroupId,
			notes: days.notes,
		})
		.from(days)
		.where(eq(days.programId, program.id))
		.orderBy(asc(days.position));

	const dayIds = programDays.map((d) => d.id);
	const openSessions = dayIds.length
		? await db
				.select({ id: sessions.id, dayId: sessions.dayId })
				.from(sessions)
				.where(
					and(inArray(sessions.dayId, dayIds), isNull(sessions.endedAt), isNull(sessions.deletedAt))
				)
		: [];
	const openByDay = new Map(openSessions.map((s) => [s.dayId, s.id]));

	const recentSessions = await db
		.select({
			id: sessions.id,
			dayId: sessions.dayId,
			dayName: days.name,
			startedAt: sessions.startedAt,
			endedAt: sessions.endedAt,
			deletedAt: sessions.deletedAt,
		})
		.from(sessions)
		.innerJoin(days, eq(days.id, sessions.dayId))
		.where(and(eq(sessions.programId, program.id), isNull(sessions.deletedAt)))
		.orderBy(desc(sessions.startedAt))
		.limit(20);

	const sessionsByDay = recentSessions.reduce<Record<string, number>>((acc, s) => {
		if (!s.endedAt) return acc;
		const key = new Date(s.startedAt).toISOString().slice(0, 10);
		acc[key] = (acc[key] ?? 0) + 1;
		return acc;
	}, {});

	const trashSessions = await listDeletedSessionsForProgram(db, program.id, 50);

	return {
		program,
		days: programDays.map((d) => ({
			...d,
			openSessionId: openByDay.get(d.id) ?? null,
		})),
		recentSessions,
		sessionsByDay,
		trashSessions,
	};
};

const deleteSessionSchema = z.object({
	sessionId: z.string().uuid(),
});

const restoreSessionSchema = z.object({
	sessionId: z.string().uuid(),
});

const permanentDeleteSchema = z.object({
	sessionId: z.string().uuid(),
	confirmDelete: z.preprocess((v) => (typeof v === 'string' ? v.toLowerCase() : v), z.literal('d')),
});

const purgeTrashSchema = z.object({
	confirmPurge: z.preprocess(
		(v) => (typeof v === 'string' ? v.toUpperCase() : v),
		z.literal('PURGE')
	),
	expectedCount: z.preprocess((v) => (typeof v === 'string' ? Number(v) : v), z.number().int().nonnegative()),
});

export const actions: Actions = {
	startSession: async ({ request }) => {
		const form = await request.formData();
		const dayId = form.get('dayId');
		if (typeof dayId !== 'string' || dayId.length === 0) {
			return fail(400, { message: 'Missing dayId' });
		}
		const parsedDayId = uuidParamSchema.safeParse(dayId);
		if (!parsedDayId.success) {
			return fail(400, { message: 'Invalid dayId' });
		}

		const result = await startSessionForDay(db, parsedDayId.data);
		if (!result.ok) {
			return fail(result.status, { message: result.message });
		}

		redirect(303, `/sessions/${result.sessionId}`);
	},

	deleteSession: async ({ request, params }) => {
		const form = await request.formData();
		const parsed = deleteSessionSchema.safeParse({
			sessionId: form.get('sessionId'),
		});
		if (!parsed.success) {
			return fail(400, { message: 'Invalid session id' });
		}

		const ownedSession = await loadProgramOwnedSession(db, parsed.data.sessionId, params.id, 'ended-active');
		if (!ownedSession) {
			return fail(404, { message: 'Session not found for this program' });
		}

		const result = await softDeleteEndedSession(db, parsed.data.sessionId);
		if (!result.ok) {
			return fail(result.status, { message: result.message });
		}
		return { ok: true };
	},

	restoreSession: async ({ request, params }) => {
		const form = await request.formData();
		const parsed = restoreSessionSchema.safeParse({
			sessionId: form.get('sessionId'),
		});
		if (!parsed.success) {
			return fail(400, { message: 'Invalid session id' });
		}

		const ownedSession = await loadProgramOwnedSession(db, parsed.data.sessionId, params.id, 'deleted-only');
		if (!ownedSession) {
			return fail(404, { message: 'Session not found for this program' });
		}

		const result = await restoreSoftDeletedSession(db, parsed.data.sessionId);
		if (!result.ok) {
			return fail(result.status, { message: result.message });
		}
		return { ok: true };
	},

	permanentDeleteSession: async ({ request, params }) => {
		const form = await request.formData();
		const parsed = permanentDeleteSchema.safeParse({
			sessionId: form.get('sessionId'),
			confirmDelete: form.get('confirmDelete'),
		});
		if (!parsed.success) {
			return fail(400, { message: 'Press d in the permanent delete box to confirm' });
		}

		const ownedSession = await loadProgramOwnedSession(db, parsed.data.sessionId, params.id, 'deleted-only');
		if (!ownedSession) {
			return fail(404, { message: 'Session not found for this program' });
		}

		const result = await hardDeleteSession(db, parsed.data.sessionId);
		if (!result.ok) {
			return fail(result.status, { message: result.message });
		}
		return { ok: true };
	},

	purgeTrash: async ({ request, params }) => {
		const form = await request.formData();
		const parsed = purgeTrashSchema.safeParse({
			confirmPurge: form.get('confirmPurge'),
			expectedCount: form.get('expectedCount'),
		});
		if (!parsed.success) {
			return fail(400, { message: 'Type PURGE and confirm count to empty trash' });
		}

		const deleted = await listDeletedSessionsForProgram(db, params.id, 1000);
		if (deleted.length !== parsed.data.expectedCount) {
			return fail(409, { message: `Trash count changed. Expected ${parsed.data.expectedCount}, found ${deleted.length}.` });
		}

		const purged = await purgeDeletedSessionsForProgram(db, params.id);
		return { ok: true, purged: purged.purged };
	},
};