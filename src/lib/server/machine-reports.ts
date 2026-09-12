import { and, count, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { exercises, sessionExercises, sessions, sets } from './db/schema';
import type { Database } from './progression';
export async function topExerciseIdentities(db: Database) {
	const exerciseName = sql<string>`coalesce(${sessionExercises.exerciseName}, ${exercises.name})`;
	return db
		.select({
			exerciseName,
			exerciseId: sets.exerciseId,
			gymEquipmentId: sets.gymEquipmentId,
			loadConvention: sets.loadConvention,
			machineLabel: sessionExercises.machineLabel,
			gymName: sessionExercises.gymName,
			completedSetRows: count(sets.id)
		})
		.from(sets)
		.innerJoin(sessions, eq(sessions.id, sets.sessionId))
		.innerJoin(exercises, eq(exercises.id, sets.exerciseId))
		.leftJoin(sessionExercises, eq(sessionExercises.id, sets.sessionExerciseId))
		.where(
			and(
				isNull(sessions.deletedAt),
				isNotNull(sessions.endedAt),
				isNotNull(sets.executedLoad),
				isNotNull(sets.executedReps)
			)
		)
		.groupBy(
			sets.exerciseId,
			sets.gymEquipmentId,
			sets.loadConvention,
			exerciseName,
			sessionExercises.machineLabel,
			sessionExercises.gymName
		)
		.orderBy(desc(count(sets.id)))
		.limit(10);
}
