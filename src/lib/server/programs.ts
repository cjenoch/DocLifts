import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { programs, days, dayExercises, prescribedSets } from './db/schema';
import type { Database } from './progression';

// Template-edit boundary: callers edit this returned copy, never the original.
// Session quick-add deliberately does not call this or alter any template row.
export type ProgramTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

// Caller owns the transaction: copy, archive and edits must commit or roll back together.
export async function duplicateProgramForEditInTransaction(
	tx: ProgramTransaction,
	userId: string,
	programId: string
) {
	z.string().uuid().parse(programId);
	// Ownership is in the locking query, so another user's program is simply
	// not there — same message, no 403 (D6).
	const [source] = await tx
		.select()
		.from(programs)
		.where(and(eq(programs.id, programId), eq(programs.userId, userId)))
		.for('update');
	if (!source) throw new Error('Program not found');
	if (!source.isActive) throw new Error('Program is inactive; edit its active successor');
	const [copy] = await tx
		.insert(programs)
		.values({
			name: source.name,
			description: source.description,
			sourceProgramId: source.id,
			// The copy belongs to whoever is editing. Without this the duplicate
			// is ownerless and invisible to every scoped query.
			userId
		})
		.returning();
	for (const day of await tx.select().from(days).where(eq(days.programId, source.id))) {
		const { id: dayId, ...dayValues } = day;
		const [newDay] = await tx
			.insert(days)
			.values({ ...dayValues, programId: copy.id })
			.returning();
		for (const exercise of await tx
			.select()
			.from(dayExercises)
			.where(eq(dayExercises.dayId, dayId))) {
			const { id: exerciseId, ...exerciseValues } = exercise;
			const [newExercise] = await tx
				.insert(dayExercises)
				.values({ ...exerciseValues, dayId: newDay.id })
				.returning();
			const prescriptions = await tx
				.select()
				.from(prescribedSets)
				.where(eq(prescribedSets.dayExerciseId, exerciseId));
			if (prescriptions.length)
				await tx.insert(prescribedSets).values(
					prescriptions.map(({ id, ...values }) => ({
						...values,
						dayExerciseId: newExercise.id
					}))
				);
		}
	}
	await tx.update(programs).set({ isActive: false }).where(eq(programs.id, source.id));
	return copy;
}
