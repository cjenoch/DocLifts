/**
 * Editing a live workout (editor spec, Part L): remove, skip the rest, move,
 * and swap an exercise. Every action changes this workout only, runs in one
 * transaction under the session lock (`lockActive`: owner-scoped, refused once
 * the workout has ended), and finds the exercise through the session, so a
 * stale tab or another user's id reads as "Please reload and try again."
 *
 * The program is never touched while the workout is open. The one exception
 * the spec allows, a swap chosen "From now on", is applied by
 * `applyProgramSwaps` after the workout ends, through the normal draft and
 * `saveProgramDraft` path.
 *
 * How "From now on" is recorded, with no new column: a swapped set keeps its
 * `prescribed_set_id` only when the swap is for the program too. "Just today"
 * drops the link (the program's exercise counts as not done that day). So at
 * finish, a linked set whose exercise differs from its planned exercise is a
 * swap to carry into the program.
 *
 * The progression engine needs nothing new: history reads only sets with
 * saved values in ended workouts (CLAUDE.md, history filters), so a removed
 * exercise and the empty sets a skip deletes leave no evidence, and a workout
 * where an exercise was skipped never counts as a backwards session for the
 * positions it did not log.
 */
import { and, asc, eq, inArray, isNotNull, isNull, ne } from 'drizzle-orm';
import { z } from 'zod';
import {
	dayExercises,
	days,
	exercises,
	prescribedSets,
	programDraftRequests,
	programs,
	sessionExercises,
	sessions,
	sets
} from './db/schema';
import { lockActive, prefillOccurrence } from './machines';
import { loadProgramDraft, saveProgramDraft } from './program-builder';
import { FREE_WEIGHT_TYPES, type Database } from './progression';

export class WorkoutEditError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'WorkoutEditError';
	}
}

const STALE = 'Please reload and try again.';

type Row = typeof sets.$inferSelect;
const logged = (r: Row) =>
	r.executedLoad != null || r.executedReps != null || r.executedRir != null || !!r.notes;

/** The occurrence and its sets, found through the (already locked) session. */
async function occurrenceOf(db: Database, sessionId: string, occurrenceId: unknown) {
	const id = z.string().uuid().safeParse(occurrenceId);
	if (!id.success) throw new WorkoutEditError(STALE);
	const [occurrence] = await db
		.select()
		.from(sessionExercises)
		.where(and(eq(sessionExercises.id, id.data), eq(sessionExercises.sessionId, sessionId)));
	if (!occurrence) throw new WorkoutEditError(STALE);
	const rows = await db
		.select()
		.from(sets)
		.where(eq(sets.sessionExerciseId, occurrence.id))
		.orderBy(asc(sets.position));
	return { occurrence, rows };
}

/**
 * Remove an exercise and its sets from this workout. With logged sets the
 * caller must state how many it is deleting (the page's confirm step); a
 * count that no longer matches is a stale tab and is refused.
 */
export async function removeSessionExercise(
	db: Database,
	userId: string,
	sessionId: string,
	input: { occurrenceId: unknown; loggedCount?: unknown }
): Promise<{ removedSets: number; removedLogged: number }> {
	return db.transaction(async (tx) => {
		await lockActive(tx, userId, sessionId);
		const { occurrence, rows } = await occurrenceOf(tx, sessionId, input.occurrenceId);
		const count = rows.filter(logged).length;
		if (count > 0 && Number(input.loggedCount) !== count) throw new WorkoutEditError(STALE);
		await tx.delete(sets).where(eq(sets.sessionExerciseId, occurrence.id));
		await tx.delete(sessionExercises).where(eq(sessionExercises.id, occurrence.id));
		return { removedSets: rows.length, removedLogged: count };
	});
}

/** Skip the rest: the empty sets go, the logged ones stay. */
export async function skipRestOfExercise(
	db: Database,
	userId: string,
	sessionId: string,
	input: { occurrenceId: unknown }
): Promise<{ removedSets: number }> {
	return db.transaction(async (tx) => {
		await lockActive(tx, userId, sessionId);
		const { rows } = await occurrenceOf(tx, sessionId, input.occurrenceId);
		const empty = rows.filter((r) => !logged(r));
		if (!empty.length || empty.length === rows.length) throw new WorkoutEditError(STALE);
		await tx.delete(sets).where(
			inArray(
				sets.id,
				empty.map((r) => r.id)
			)
		);
		return { removedSets: empty.length };
	});
}

/**
 * Move an exercise one place up or down. The two positions are exchanged
 * through a free temporary value, inside the transaction, so
 * `session_exercises_position_unique` holds at every statement.
 */
export async function moveSessionExercise(
	db: Database,
	userId: string,
	sessionId: string,
	input: { occurrenceId: unknown; direction: unknown }
): Promise<void> {
	const direction = z.enum(['up', 'down']).safeParse(input.direction);
	if (!direction.success) throw new WorkoutEditError(STALE);
	await db.transaction(async (tx) => {
		await lockActive(tx, userId, sessionId);
		const { occurrence } = await occurrenceOf(tx, sessionId, input.occurrenceId);
		const all = await tx
			.select({ id: sessionExercises.id, position: sessionExercises.position })
			.from(sessionExercises)
			.where(eq(sessionExercises.sessionId, sessionId))
			.orderBy(asc(sessionExercises.position));
		const index = all.findIndex((o) => o.id === occurrence.id);
		const other = all[direction.data === 'up' ? index - 1 : index + 1];
		if (!other) throw new WorkoutEditError(STALE);
		const parking = Math.min(0, ...all.map((o) => o.position)) - 1;
		await tx
			.update(sessionExercises)
			.set({ position: parking })
			.where(eq(sessionExercises.id, occurrence.id));
		await tx
			.update(sessionExercises)
			.set({ position: occurrence.position })
			.where(eq(sessionExercises.id, other.id));
		await tx
			.update(sessionExercises)
			.set({ position: other.position })
			.where(eq(sessionExercises.id, occurrence.id));
	});
}

const swapSchema = z.object({
	occurrenceId: z.string().uuid(),
	exerciseId: z.string().uuid(),
	scope: z.enum(['today', 'program']).default('today'),
	// A free weight keeps the weight format the sheet remembers for it, so
	// its history (which keys on the format) is found. A machine exercise
	// starts with no machine, as a planned one does; choosing one sets it.
	loadConvention: z
		.enum(['unknown', 'plates_per_side', 'total_plates', 'per_arm', 'displayed'])
		.optional()
});

/**
 * Swap an untouched exercise for another. The set count, roles and rep
 * targets stay; loads are filled again from the new exercise's own history.
 * Refused once any set has a saved value, the same gate as a machine change.
 */
export async function swapSessionExercise(
	db: Database,
	userId: string,
	sessionId: string,
	input: unknown
) {
	const parsed = swapSchema.safeParse(input);
	if (!parsed.success) throw new WorkoutEditError(STALE);
	const value = parsed.data;
	return db.transaction(async (tx) => {
		await lockActive(tx, userId, sessionId);
		const { occurrence, rows } = await occurrenceOf(tx, sessionId, value.occurrenceId);
		if (rows.some(logged))
			throw new WorkoutEditError(
				'This exercise has logged sets, so it cannot be swapped. Skip the rest and add the other exercise instead.'
			);
		const [exercise] = await tx
			.select()
			.from(exercises)
			.where(and(eq(exercises.id, value.exerciseId), eq(exercises.userId, userId)));
		if (!exercise) throw new WorkoutEditError(STALE);
		if (exercise.id === occurrence.exerciseId)
			throw new WorkoutEditError(`This is already ${exercise.name}.`);
		const planned = rows.some((r) => r.prescribedSetId != null);
		if (value.scope === 'program' && !planned) throw new WorkoutEditError(STALE);
		const free = FREE_WEIGHT_TYPES.has(exercise.equipmentType);
		const loadConvention =
			free && value.loadConvention && value.loadConvention !== 'plates_per_side'
				? value.loadConvention
				: ('legacy' as const);
		const [updated] = await tx
			.update(sessionExercises)
			.set({
				exerciseId: exercise.id,
				exerciseName: exercise.name,
				equipmentType: exercise.equipmentType,
				gymEquipmentId: null,
				machineLabel: null,
				modelName: null,
				gymName: free ? occurrence.gymName : null,
				loadConvention
			})
			.where(eq(sessionExercises.id, occurrence.id))
			.returning();
		await tx
			.update(sets)
			.set({
				exerciseId: exercise.id,
				gymEquipmentId: null,
				loadConvention,
				// "Just today": the program's exercise counts as not done today.
				...(value.scope === 'today' ? { prescribedSetId: null } : {})
			})
			.where(eq(sets.sessionExerciseId, occurrence.id));
		await prefillOccurrence(tx, userId, updated);
		return updated;
	});
}

export type ProgramSwapResult =
	| { kind: 'none' }
	| { kind: 'updated'; programId: string }
	| { kind: 'failed'; reason: 'open' | 'changed' | 'invalid' };

/**
 * After a workout ends: carry its "From now on" swaps into the program, as a
 * new version through `saveProgramDraft` (duplicate-on-edit, validated). A
 * failure leaves the program exactly as it was. The session id is the
 * request id, so finishing twice cannot edit twice.
 */
export async function applyProgramSwaps(
	db: Database,
	userId: string,
	sessionId: string
): Promise<ProgramSwapResult> {
	const [session] = await db
		.select()
		.from(sessions)
		.where(
			and(
				eq(sessions.id, sessionId),
				eq(sessions.userId, userId),
				isNotNull(sessions.endedAt),
				isNull(sessions.deletedAt)
			)
		);
	if (!session) return { kind: 'none' };
	const swapped = await db
		.selectDistinct({ dayExerciseId: dayExercises.id, exerciseId: sets.exerciseId })
		.from(sets)
		.innerJoin(prescribedSets, eq(prescribedSets.id, sets.prescribedSetId))
		.innerJoin(dayExercises, eq(dayExercises.id, prescribedSets.dayExerciseId))
		.where(
			and(
				eq(sets.sessionId, sessionId),
				eq(sets.userId, userId),
				ne(sets.exerciseId, dayExercises.exerciseId)
			)
		);
	if (!swapped.length) return { kind: 'none' };
	// Already carried over (the session id is the request id): the same answer.
	const [receipt] = await db
		.select({ programId: programDraftRequests.programId })
		.from(programDraftRequests)
		.where(
			and(eq(programDraftRequests.userId, userId), eq(programDraftRequests.requestId, sessionId))
		);
	if (receipt) return { kind: 'updated', programId: receipt.programId };

	const [program] = await db
		.select()
		.from(programs)
		.where(and(eq(programs.id, session.programId), eq(programs.userId, userId)));
	if (!program || !program.isActive || program.systemKind)
		return { kind: 'failed', reason: 'changed' };
	const [open] = await db
		.select({ id: sessions.id })
		.from(sessions)
		.where(
			and(
				eq(sessions.programId, program.id),
				eq(sessions.userId, userId),
				isNull(sessions.endedAt),
				isNull(sessions.deletedAt)
			)
		)
		.limit(1);
	if (open) return { kind: 'failed', reason: 'open' };

	// Where each planned exercise sits in the draft: days and exercises in order.
	const places = new Map<string, [number, number]>();
	const dayRows = await db
		.select({ id: days.id })
		.from(days)
		.where(eq(days.programId, program.id))
		.orderBy(asc(days.position));
	for (const [d, day] of dayRows.entries()) {
		const rows = await db
			.select({ id: dayExercises.id })
			.from(dayExercises)
			.where(eq(dayExercises.dayId, day.id))
			.orderBy(asc(dayExercises.position));
		for (const [e, row] of rows.entries()) places.set(row.id, [d, e]);
	}
	try {
		const draft = await loadProgramDraft(db, userId, program.id);
		for (const swap of swapped) {
			const place = places.get(swap.dayExerciseId);
			if (!place) return { kind: 'failed', reason: 'changed' };
			const row = draft.days[place[0]].exercises[place[1]];
			row.exerciseId = swap.exerciseId;
			row.newExercise = null;
		}
		const saved = await saveProgramDraft(db, userId, {
			requestId: sessionId,
			sourceProgramId: program.id,
			draft
		});
		return { kind: 'updated', programId: saved.id };
	} catch (e) {
		if (e instanceof z.ZodError) return { kind: 'failed', reason: 'invalid' };
		if (e instanceof Error && /not found|archived|already|conflict/i.test(e.message))
			return { kind: 'failed', reason: 'changed' };
		throw e;
	}
}
