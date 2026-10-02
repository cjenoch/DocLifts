import { and, eq, isNull } from 'drizzle-orm';
import { db, programs } from '$lib/server/db';
import { requireUser } from '$lib/server/request-user';
import { openQuickSessionId } from '$lib/server/quick-workouts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const userId = requireUser(locals).id;
	// Owner-scoped like every other read (CLAUDE.md, D5): until 0.4.7 this
	// listed every user's active programs, so a second user saw the owner's
	// program names on Home. System programs (the hidden quick-workout
	// program, 0.5.1) are never listed.
	const activePrograms = await db
		.select({
			id: programs.id,
			name: programs.name,
			description: programs.description
		})
		.from(programs)
		.where(
			and(eq(programs.userId, userId), eq(programs.isActive, true), isNull(programs.systemKind))
		)
		.orderBy(programs.name);

	return { programs: activePrograms, openQuickSessionId: await openQuickSessionId(db, userId) };
};
