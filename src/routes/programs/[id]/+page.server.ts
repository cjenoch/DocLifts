import { error } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db, days, programs } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
  const [program] = await db
    .select()
    .from(programs)
    .where(eq(programs.id, params.id))
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
    .orderBy(days.position);

  return { program, days: programDays };
};
