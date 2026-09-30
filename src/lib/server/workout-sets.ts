import { and, eq, isNull, desc } from 'drizzle-orm';
import { z } from 'zod';
import { sessions, sets } from './db/schema';
import type { Database } from './progression';
import { MachineInputError } from './machines';

export async function removeEmptyLastSet(
	db: Database,
	userId: string,
	sessionId: string,
	setId: string
) {
	z.string().uuid().parse(setId);
	return db.transaction(async (tx) => {
		// Owner predicate in the same query that resolves the session, matching
		// appendWorkoutSet. Another user's session reads as absent, so the
		// refusal is identical to an unknown id and nothing is deleted.
		const [session] = await tx
			.select()
			.from(sessions)
			.where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
			.for('update');
		if (!session || session.endedAt || session.deletedAt)
			throw new MachineInputError('This workout is no longer active.');
		const [row] = await tx
			.select()
			.from(sets)
			.where(and(eq(sets.id, setId), eq(sets.sessionId, sessionId), eq(sets.userId, userId)));
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
export async function appendWorkoutSet(
	db: Database,
	userId: string,
	sessionId: string,
	input: unknown
) {
	const value = z
		.object({
			sourceSetId: z.string().uuid(),
			requestId: z.string().uuid(),
			setRole: z.enum(['working', 'warmup', 'backoff'])
		})
		.parse(input);
	return db.transaction(async (tx) => {
		// Owner predicate in the same query that resolves the session, not a
		// separate id-only pre-check. Another user's session reads as absent,
		// so appending to it hits the same refusal as an unknown id.
		const [session] = await tx
			.select()
			.from(sessions)
			.where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
			.for('update');
		if (!session || session.endedAt || session.deletedAt)
			throw new MachineInputError('This workout is no longer active.');
		const [source] = await tx
			.select()
			.from(sets)
			.where(
				and(eq(sets.id, value.sourceSetId), eq(sets.sessionId, sessionId), eq(sets.userId, userId))
			);
		if (!source) throw new MachineInputError('Exercise not found in this workout.');
		// Idempotency lookup is scoped to the session it would append to. A
		// requestId that exists under another owner is not this caller's, and
		// the insert's primary key would reject it as a raw 23505 rather than
		// as a conflict.
		const [existing] = await tx
			.select()
			.from(sets)
			.where(and(eq(sets.id, value.requestId), eq(sets.userId, userId)));
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
				userId,
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
