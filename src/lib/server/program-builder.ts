import { createHash } from 'node:crypto';
import { asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { programDraftSchema, type ProgramDraft } from '../program-draft';
import {
	programs,
	days,
	dayExercises,
	prescribedSets,
	exercises,
	programDraftRequests
} from './db/schema';
import type { Database } from './progression';
import { duplicateProgramForEditInTransaction, type ProgramTransaction } from './programs';

export async function listProgramExercises(
	db: Database
): Promise<{ id: string; name: string; equipmentType: string; isLowerBody: boolean }[]> {
	return db
		.select({
			id: exercises.id,
			name: exercises.name,
			equipmentType: exercises.equipmentType,
			isLowerBody: exercises.isLowerBody
		})
		.from(exercises)
		.orderBy(asc(exercises.name), asc(exercises.id));
}

export class ProgramNotFoundError extends Error {
	constructor() {
		super('Program not found');
		this.name = 'ProgramNotFoundError';
	}
}

export async function loadProgramDraft(db: Database, id: string): Promise<ProgramDraft> {
	z.string().uuid().parse(id);
	const [program] = await db.select().from(programs).where(eq(programs.id, id));
	if (!program) throw new ProgramNotFoundError();
	const draft: ProgramDraft = { name: program.name, description: program.description, days: [] };
	for (const day of await db
		.select()
		.from(days)
		.where(eq(days.programId, id))
		.orderBy(asc(days.position))) {
		const result: ProgramDraft['days'][number] = {
			name: day.name,
			notes: day.notes,
			alternateGroupId: day.alternateGroupId,
			exercises: []
		};
		for (const exercise of await db
			.select()
			.from(dayExercises)
			.where(eq(dayExercises.dayId, day.id))
			.orderBy(asc(dayExercises.position))) {
			const rows = await db
				.select()
				.from(prescribedSets)
				.where(eq(prescribedSets.dayExerciseId, exercise.id))
				.orderBy(asc(prescribedSets.position));
			result.exercises.push({
				exerciseId: exercise.exerciseId,
				newExercise: null,
				tier: exercise.tier,
				progressionPolicy: exercise.progressionPolicy,
				notes: exercise.notes,
				// Legacy nullable targets remain visibly invalid (zero), never silently replaced with new prescriptions.
				sets: rows.map(
					({
						setRole,
						targetMetric,
						targetRepsMin,
						targetRepsMax,
						targetRir,
						restSecondsMin,
						restSecondsMax,
						initialLoad,
						notes
					}) => ({
						setRole,
						targetMetric,
						targetRepsMin: targetRepsMin ?? 0,
						targetRepsMax: targetRepsMax ?? 0,
						targetRir,
						restSecondsMin,
						restSecondsMax,
						initialLoad,
						notes
					})
				)
			});
		}
		draft.days.push(result);
	}
	return draft;
}

async function resolveExercise(
	tx: ProgramTransaction,
	exercise: ProgramDraft['days'][number]['exercises'][number]
): Promise<string> {
	if (exercise.exerciseId) {
		const [existing] = await tx
			.select({ id: exercises.id })
			.from(exercises)
			.where(eq(exercises.id, exercise.exerciseId));
		if (!existing) throw new Error('Referenced exercise not found');
		return existing.id;
	}
	const quick = exercise.newExercise!; // validated exclusive choice
	// The unique name constraint serializes concurrent quick-adds without retyping metadata.
	const [inserted] = await tx
		.insert(exercises)
		.values(quick)
		.onConflictDoNothing({ target: exercises.name })
		.returning();
	const existing =
		inserted ?? (await tx.select().from(exercises).where(eq(exercises.name, quick.name)))[0];
	if (
		!existing ||
		existing.equipmentType !== quick.equipmentType ||
		existing.isLowerBody !== quick.isLowerBody
	) {
		throw new Error(
			`Existing exercise "${quick.name}" has incompatible equipment or lower-body metadata; choose the library entry or a different name`
		);
	}
	return existing.id;
}

const saveSchema = z
	.object({
		requestId: z.string().uuid(),
		sourceProgramId: z.string().uuid().nullable(),
		draft: programDraftSchema
	})
	.strict();

export async function saveProgramDraft(
	db: Database,
	input: { requestId: string; sourceProgramId: string | null; draft: unknown }
): Promise<{ id: string }> {
	const { requestId, sourceProgramId, draft } = saveSchema.parse(input);
	const fingerprint = createHash('sha256')
		.update(JSON.stringify({ sourceProgramId, draft }))
		.digest('hex');
	return db.transaction(async (tx) => {
		// A transaction-scoped lock covers the absent-receipt case too. Hash collisions
		// only serialize unrelated requests; the UUID PK and fingerprint remain authoritative.
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtextextended(${requestId}::uuid::text, 0))`
		);
		const [receipt] = await tx
			.select()
			.from(programDraftRequests)
			.where(eq(programDraftRequests.requestId, requestId));
		if (receipt) {
			if (receipt.fingerprint !== fingerprint)
				throw new Error('Request ID already used for a different program draft');
			return { id: receipt.programId };
		}
		let id: string;
		if (sourceProgramId) {
			// Deep-copy every child under the source row lock before editing ONLY the
			// unpublished copy. No other transaction can see it before this commits.
			const copy = await duplicateProgramForEditInTransaction(tx, sourceProgramId);
			id = copy.id;
			await tx.delete(days).where(eq(days.programId, id));
			await tx
				.update(programs)
				.set({ name: draft.name, description: draft.description })
				.where(eq(programs.id, id));
		} else {
			const [program] = await tx
				.insert(programs)
				.values({
					name: draft.name,
					description: draft.description,
					isActive: true,
					sourceProgramId: null
				})
				.returning();
			id = program.id;
		}
		for (const [dayIndex, day] of draft.days.entries()) {
			const [savedDay] = await tx
				.insert(days)
				.values({
					programId: id,
					name: day.name,
					notes: day.notes,
					alternateGroupId: day.alternateGroupId,
					position: dayIndex + 1
				})
				.returning();
			for (const [exerciseIndex, exercise] of day.exercises.entries()) {
				const exerciseId = await resolveExercise(tx, exercise);
				const [savedExercise] = await tx
					.insert(dayExercises)
					.values({
						dayId: savedDay.id,
						exerciseId,
						position: exerciseIndex + 1,
						tier: exercise.tier,
						progressionPolicy: exercise.progressionPolicy,
						notes: exercise.notes
					})
					.returning();
				await tx.insert(prescribedSets).values(
					exercise.sets.map((set, index) => ({
						...set,
						dayExerciseId: savedExercise.id,
						position: index + 1
					}))
				);
			}
		}
		await tx.insert(programDraftRequests).values({ requestId, fingerprint, programId: id });
		return { id };
	});
}
