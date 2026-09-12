import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { programs, days, dayExercises, prescribedSets } from './db/schema';
import type { Database } from './progression';

// Template-edit boundary: callers edit this returned copy, never the original.
// Session quick-add deliberately does not call this or alter any template row.
export async function duplicateProgramForEdit(db: Database, programId: string) {
	z.string().uuid().parse(programId);
	return db.transaction(async (tx) => {
		const [source] = await tx
			.select()
			.from(programs)
			.where(eq(programs.id, programId))
			.for('update');
		if (!source) throw new Error('Program not found');
		if (!source.isActive) throw new Error('Program is inactive; edit its active successor');
		const [copy] = await tx
			.insert(programs)
			.values({ name: source.name, description: source.description, sourceProgramId: source.id })
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
					await tx
						.insert(prescribedSets)
						.values(
							prescriptions.map(({ id, ...values }) => ({
								...values,
								dayExerciseId: newExercise.id
							}))
						);
			}
		}
		await tx
			.update(programs)
			.set({ isActive: false, updatedAt: new Date() })
			.where(eq(programs.id, source.id));
		return copy;
	});
}
