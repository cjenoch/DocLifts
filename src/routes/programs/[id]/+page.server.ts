import { error, fail, redirect } from '@sveltejs/kit';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { db, days, programs, sessions } from '$lib/server/db';
import { startSessionForDay } from '$lib/server/sessions';
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
				.where(and(inArray(sessions.dayId, dayIds), isNull(sessions.endedAt)))
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
		.where(eq(sessions.programId, program.id))
		.orderBy(desc(sessions.startedAt))
		.limit(10);

	return {
		program,
		days: programDays.map((d) => ({
			...d,
			openSessionId: openByDay.get(d.id) ?? null,
		})),
		recentSessions,
	};
};

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
};
