import { and, eq, isNull, desc } from 'drizzle-orm';
import { z } from 'zod';
import { sessions, sets } from './db/schema';
import type { Database } from './progression';
import { MachineInputError } from './machines';

export async function removeEmptyLastSet(db: Database, sessionId: string, setId: string) {
	z.string().uuid().parse(setId);
	return db.transaction(async (tx) => {
		const [session] = await tx
			.select()
			.from(sessions)
			.where(eq(sessions.id, sessionId))
			.for('update');
		if (!session || session.endedAt || session.deletedAt)
			throw new MachineInputError('This workout is no longer active.');
		const [row] = await tx
			.select()
			.from(sets)
			.where(and(eq(sets.id, setId), eq(sets.sessionId, sessionId)));
		if (!row) throw new MachineInputError('Set not found.');
		if (
			row.executedLoad != null ||
			row.executedReps != null ||
			row.executedRir != null ||
			row.notes
		)
			throw new MachineInputError('Logged sets cannot be removed here.');
		const siblings = await tx
			.select()
			.from(sets)
			.where(
				and(
					eq(sets.sessionId, sessionId),
					row.sessionExerciseId
						? eq(sets.sessionExerciseId, row.sessionExerciseId)
						: and(isNull(sets.sessionExerciseId), eq(sets.exerciseId, row.exerciseId))
				)
			)
			.orderBy(desc(sets.position));
		if (siblings.length < 2 || siblings[0].id !== row.id)
			throw new MachineInputError('Only the last empty set can be removed.');
		await tx.delete(sets).where(eq(sets.id, row.id));
	});
}

// Lock the session, as the other workout mutations do. Never renumber existing history slots.
export async function appendWorkoutSet(db: Database, sessionId: string, input: unknown) {
	const value = z
		.object({
			sourceSetId: z.string().uuid(),
			requestId: z.string().uuid(),
			setRole: z.enum(['working', 'warmup', 'backoff'])
		})
		.parse(input);
	return db.transaction(async (tx) => {
		const [session] = await tx
			.select()
			.from(sessions)
			.where(eq(sessions.id, sessionId))
			.for('update');
		if (!session || session.endedAt || session.deletedAt)
			throw new MachineInputError('This workout is no longer active.');
		const [source] = await tx
			.select()
			.from(sets)
			.where(and(eq(sets.id, value.sourceSetId), eq(sets.sessionId, sessionId)));
		if (!source) throw new MachineInputError('Exercise not found in this workout.');
		const [existing] = await tx.select().from(sets).where(eq(sets.id, value.requestId));
		if (existing) {
			if (
				existing.sessionId !== sessionId ||
				existing.sessionExerciseId !== source.sessionExerciseId ||
				existing.exerciseId !== source.exerciseId
			)
				throw new MachineInputError('Please reload and try again.');
			return existing;
		}
		const [last] = await tx
			.select()
			.from(sets)
			.where(
				and(
					eq(sets.sessionId, sessionId),
					source.sessionExerciseId
						? eq(sets.sessionExerciseId, source.sessionExerciseId)
						: and(isNull(sets.sessionExerciseId), eq(sets.exerciseId, source.exerciseId))
				)
			)
			.orderBy(desc(sets.position))
			.limit(1);
		const load = value.setRole === last.setRole ? (last.executedLoad ?? last.prescribedLoad) : null;
		const [added] = await tx
			.insert(sets)
			.values({
				id: value.requestId,
				sessionId,
				exerciseId: source.exerciseId,
				sessionExerciseId: source.sessionExerciseId,
				gymEquipmentId: source.gymEquipmentId,
				loadConvention: source.loadConvention,
				position: last.position + 1,
				setRole: value.setRole,
				targetMetric: last.targetMetric,
				prescribedLoad: load,
				prescribedRepsMin: last.prescribedRepsMin,
				prescribedRepsMax: last.prescribedRepsMax,
				prescribedRir: last.prescribedRir,
				suggestionReasoning:
					load == null ? null : 'Copied from the previous set. Adjust to what you lift.'
			})
			.returning();
		return added;
	});
}
