import { and, eq } from 'drizzle-orm';
import { db, programs } from '$lib/server/db';
import { requireUser } from '$lib/server/request-user';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	// Owner-scoped like every other read (CLAUDE.md, D5): until 0.4.7 this
	// listed every user's active programs, so a second user saw the owner's
	// program names on Home.
	const activePrograms = await db
		.select({
			id: programs.id,
			name: programs.name,
			description: programs.description
		})
		.from(programs)
		.where(and(eq(programs.userId, requireUser(locals).id), eq(programs.isActive, true)))
		.orderBy(programs.name);

	return { programs: activePrograms };
};
