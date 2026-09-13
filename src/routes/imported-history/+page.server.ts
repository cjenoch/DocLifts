import { desc } from 'drizzle-orm';
import { db, importedWorkouts } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	const workouts = await db
		.select()
		.from(importedWorkouts)
		.orderBy(desc(importedWorkouts.workoutDate), desc(importedWorkouts.sourceLine));
	return { workouts };
};
