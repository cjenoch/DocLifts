/**
 * What Home needs to know about an account beyond its programs (0.5.5,
 * Part E): whether it has ever had a workout, and whether it has imported
 * history. Both owner-scoped (D5): sessions by `user_id`, imported workouts
 * through `import_id` -> `workout_log_imports.user_id`.
 */
import { eq, sql } from 'drizzle-orm';
import { importedWorkouts, sessions, workoutLogImports } from './db/schema';
import type { Database } from './progression';

export type HomeState = {
	/** Any workout at all, open, finished or in Trash. */
	hasWorkouts: boolean;
	/** Any imported workout; the "Imported workout history" link is hidden without one. */
	hasImported: boolean;
};

export async function homeState(db: Database, userId: string): Promise<HomeState> {
	const [row] = await db
		.select({
			hasWorkouts: sql<boolean>`exists (${db
				.select({ one: sql`1` })
				.from(sessions)
				.where(eq(sessions.userId, userId))})`,
			hasImported: sql<boolean>`exists (${db
				.select({ one: sql`1` })
				.from(importedWorkouts)
				.innerJoin(workoutLogImports, eq(workoutLogImports.id, importedWorkouts.importId))
				.where(eq(workoutLogImports.userId, userId))})`
		})
		.from(sql`(select 1) as one`);
	return { hasWorkouts: Boolean(row?.hasWorkouts), hasImported: Boolean(row?.hasImported) };
}
