import { and, eq, like } from 'drizzle-orm';
import { db, programs } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
  const activePrograms = await db
    .select({
      id: programs.id,
      name: programs.name,
      description: programs.description,
    })
    .from(programs)
    .where(and(eq(programs.isActive, true), like(programs.name, 'Sunrise Center%')))
    .orderBy(programs.name);

  return { programs: activePrograms };
};
