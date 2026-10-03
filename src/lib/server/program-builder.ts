import { createHash } from 'node:crypto';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
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
import { PLACEHOLDER_MOVEMENT } from './photo-workout';
import { duplicateProgramForEditInTransaction, type ProgramTransaction } from './programs';

export async function listProgramExercises(
	db: Database,
	userId: string
): Promise<{ id: string; name: string; equipmentType: string; isLowerBody: boolean }[]> {
	return db
		.select({
			id: exercises.id,
			name: exercises.name,
			equipmentType: exercises.equipmentType,
			isLowerBody: exercises.isLowerBody
		})
		.from(exercises)
		.where(
			and(
				eq(exercises.userId, userId),
				// The photo placeholder is never a program exercise (Part M: a
				// block still on it must be named before its draft can be saved).
				sql`${exercises.canonicalMovement} IS DISTINCT FROM ${PLACEHOLDER_MOVEMENT}`
			)
		)
		.orderBy(asc(exercises.name), asc(exercises.id));
}

export class ProgramNotFoundError extends Error {
	constructor() {
		super('Program not found');
		this.name = 'ProgramNotFoundError';
	}
}

export async function loadProgramDraft(
	db: Database,
	userId: string,
	id: string
): Promise<ProgramDraft> {
	z.string().uuid().parse(id);
	// Another user's program is 'not found', not 'forbidden' (D6). So is a
	// system program: the quick-workout program has no editor (0.5.1).
	const [program] = await db
		.select()
		.from(programs)
		.where(and(eq(programs.id, id), eq(programs.userId, userId), isNull(programs.systemKind)));
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
	userId: string,
	exercise: ProgramDraft['days'][number]['exercises'][number]
): Promise<string> {
	if (exercise.exerciseId) {
		const [existing] = await tx
			.select({ id: exercises.id })
			.from(exercises)
			.where(and(eq(exercises.id, exercise.exerciseId), eq(exercises.userId, userId)));
		if (!existing) throw new Error('Referenced exercise not found');
		return existing.id;
	}
	const quick = exercise.newExercise!; // validated exclusive choice
	// The per-user unique from 0009, UNIQUE(user_id, name), serializes concurrent
	// quick-adds for THIS user without retyping metadata — and lets a second user
	// own an exercise with the same name. The global UNIQUE(name) this used to
	// target is dropped in 0010_drop_exercise_name_unique, once
	// program-builder.ts is the last caller needing it.
	const [inserted] = await tx
		.insert(exercises)
		.values({ ...quick, userId })
		.onConflictDoNothing({ target: [exercises.userId, exercises.name] })
		.returning();
	const existing =
		inserted ??
		(
			await tx
				.select()
				.from(exercises)
				.where(and(eq(exercises.name, quick.name), eq(exercises.userId, userId)))
		)[0];
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
	userId: string,
	input: { requestId: string; sourceProgramId: string | null; draft: unknown }
): Promise<{ id: string }> {
	const { requestId, sourceProgramId, draft } = saveSchema.parse(input);
	// userId is inside the fingerprint as well as the receipt lookup: two users
	// submitting the same draft under the same requestId are two different
	// requests, not a replay of one.
	const fingerprint = createHash('sha256')
		.update(JSON.stringify({ userId, sourceProgramId, draft }))
		.digest('hex');
	return db.transaction(async (tx) => {
		// A transaction-scoped lock covers the absent-receipt case too. Hash collisions
		// only serialize unrelated requests; the UUID PK and fingerprint remain authoritative.
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtextextended(${requestId}::uuid::text, 0))`
		);
		// The lookup is GLOBAL on requestId, because request_id is this table's
		// PRIMARY KEY. Scoping it to the user would let a colliding requestId
		// fall through to the INSERT and surface a raw 23505 rather than a
		// clean refusal. Scoping the FINGERPRINT instead is what makes the
		// refusal safe: userId is hashed into it, so a second user reusing an
		// existing requestId produces a different fingerprint and this throws.
		// A receipt is therefore never returned to a different user, so no
		// program id leaks.
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
			const copy = await duplicateProgramForEditInTransaction(tx, userId, sourceProgramId);
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
					sourceProgramId: null,
					userId
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
				const exerciseId = await resolveExercise(tx, userId, exercise);
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
		await tx.insert(programDraftRequests).values({ userId, requestId, fingerprint, programId: id });
		return { id };
	});
}
