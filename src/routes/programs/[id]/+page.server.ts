import { error, fail, redirect } from '@sveltejs/kit';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { db, days, programs, sessions } from '$lib/server/db';
import { startSessionForDay } from '$lib/server/sessions';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const [program] = await db.select().from(programs).where(eq(programs.id, params.id)).limit(1);

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
		})
		.from(sessions)
		.innerJoin(days, eq(days.id, sessions.dayId))
		.where(and(eq(sessions.programId, program.id), isNull(sessions.deletedAt)))
		.orderBy(desc(sessions.startedAt))
		.limit(20);

	const sessionsByDay = recentSessions.reduce<Record<string, number>>((acc, s) => {
		const key = new Date(s.startedAt).toISOString().slice(0, 10);
		acc[key] = (acc[key] ?? 0) + 1;
		return acc;
	}, {});

	return {
		program,
		days: programDays.map((d) => ({
			...d,
			openSessionId: openByDay.get(d.id) ?? null,
		})),
		recentSessions,
		sessionsByDay,
	};
};

const deleteSessionSchema = z.object({
	sessionId: z.string().uuid(),
});

export const actions: Actions = {
	startSession: async ({ request }) => {
		const form = await request.formData();
		const dayId = form.get('dayId');
		if (typeof dayId !== 'string' || dayId.length === 0) {
			return fail(400, { message: 'Missing dayId' });
		}

		const result = await startSessionForDay(db, dayId);
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

		const [ownedSession] = await db
			.select({ id: sessions.id })
			.from(sessions)
			.where(and(eq(sessions.id, parsed.data.sessionId), eq(sessions.programId, params.id)))
			.limit(1);

		if (!ownedSession) {
			return fail(404, { message: 'Session not found for this program' });
		}

		await db
			.update(sessions)
			.set({ deletedAt: new Date() })
			.where(and(eq(sessions.id, parsed.data.sessionId), isNull(sessions.deletedAt)));
		return { ok: true };
	},
};
