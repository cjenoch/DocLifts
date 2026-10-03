/**
 * The Exercises page (0.8.0, SPEC "machines, gyms and pickers", Part J):
 * rename, set the body region, hide and restore an exercise. Owner-scoped
 * (D5): every statement carries `user_id = userId`, and another user's
 * exercise is "not found" (D6). The photo placeholder exercise is never
 * listed or changed here.
 *
 * - **Rename**: past workouts keep the name they recorded
 *   (`session_exercises.exercise_name`).
 * - **Hide**: the exercise leaves the picker and stays in history. A program
 *   that uses it keeps using it; hiding only affects the picker.
 */
import { and, asc, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { exercises } from './db/schema';
import type { Database } from './progression';
import { EXERCISE_BODY_REGIONS, MachineInputError } from './machines';
import { PLACEHOLDER_MOVEMENT } from './photo-workout';

const notPlaceholder = sql`${exercises.canonicalMovement} IS DISTINCT FROM ${PLACEHOLDER_MOVEMENT}`;
const uuid = z.string().uuid();
const name = z.string().trim().min(1).max(120);
const region = z.preprocess(
	(v) => (v === '' || v == null ? null : v),
	z.enum(EXERCISE_BODY_REGIONS).nullable()
);

/** Every exercise of this user, shown and hidden, A to Z. */
export async function exercisesForPage(db: Database, userId: string) {
	const rows = await db
		.select({
			id: exercises.id,
			name: exercises.name,
			equipmentType: exercises.equipmentType,
			bodyRegion: exercises.bodyRegion,
			archivedAt: exercises.archivedAt
		})
		.from(exercises)
		.where(and(eq(exercises.userId, userId), notPlaceholder))
		.orderBy(asc(exercises.name));
	return {
		shown: rows.filter((r) => !r.archivedAt),
		hidden: rows.filter((r) => r.archivedAt)
	};
}

async function update(
	db: Database,
	userId: string,
	exerciseId: string,
	set: Partial<typeof exercises.$inferInsert>,
	extra = sql`true`
) {
	if (!uuid.safeParse(exerciseId).success) return null;
	const [row] = await db
		.update(exercises)
		.set(set)
		.where(and(eq(exercises.id, exerciseId), eq(exercises.userId, userId), notPlaceholder, extra))
		.returning();
	return row ?? null;
}

/** Rename. Refused when the user already has an exercise of that name. */
export async function renameExercise(
	db: Database,
	userId: string,
	exerciseId: string,
	input: unknown
) {
	const value = z.object({ name }).parse(input);
	if (!uuid.safeParse(exerciseId).success) return null;
	const [taken] = await db
		.select({ id: exercises.id })
		.from(exercises)
		.where(
			and(
				eq(exercises.userId, userId),
				eq(exercises.name, value.name),
				ne(exercises.id, exerciseId)
			)
		);
	if (taken) throw new MachineInputError(`You already have an exercise named "${value.name}"`);
	return update(db, userId, exerciseId, { name: value.name });
}

/** Set the picker group; blank clears it ("Other"). */
export async function setExerciseRegion(
	db: Database,
	userId: string,
	exerciseId: string,
	input: unknown
) {
	const { bodyRegion } = z.object({ bodyRegion: region }).parse(input);
	return update(db, userId, exerciseId, { bodyRegion });
}

export const hideExercise = (db: Database, userId: string, exerciseId: string) =>
	update(db, userId, exerciseId, { archivedAt: new Date() }, isNull(exercises.archivedAt));

export const restoreExercise = (db: Database, userId: string, exerciseId: string) =>
	update(db, userId, exerciseId, { archivedAt: null }, isNotNull(exercises.archivedAt));
