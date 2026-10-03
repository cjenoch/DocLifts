/**
 * Save a finished workout as a program (editor spec, Part M). A finished
 * workout becomes a program draft that the user reviews in the editor and
 * saves through `saveProgramDraft`, like any other draft. Nothing is created
 * here, and the workout is only read.
 *
 * The draft, from the spec's table:
 * - exercises in the order they ended up (block position), each with only
 *   the sets that have a saved value; an exercise with none is left out;
 * - set roles as recorded (a warm-up stays a warm-up);
 * - the rep range is the exact reps performed, lowest to highest across that
 *   exercise's working (non-warm-up) sets; warm-ups get their own range;
 * - reps in reserve is the program default (2), rest the editor's default;
 * - tier and progression policy from the workout's block;
 * - no starting load and no machine.
 * - A block still on the photo placeholder ("Unidentified machine") is left
 *   with no exercise chosen, so the draft cannot be saved until it is named.
 */
import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { exercises, programs, sessionExercises, sessions, sets } from './db/schema';
import { blankSetDraft, type ProgramDraft } from '../program-draft';
import { PLACEHOLDER_MOVEMENT } from './photo-workout';
import { loadProgramDraft, ProgramNotFoundError } from './program-builder';
import type { Database } from './progression';

type DayDraft = ProgramDraft['days'][number];
type ExerciseDraft = DayDraft['exercises'][number];
type SetRow = typeof sets.$inferSelect;

export class WorkoutNotFoundError extends Error {
	constructor() {
		super('Workout not found');
		this.name = 'WorkoutNotFoundError';
	}
}

export const WORKOUT_DAY_NAME = 'Workout';
export const workoutProgramName = (startedAt: Date) =>
	`Workout · ${startedAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}`;

const saved = (r: SetRow) =>
	r.executedLoad != null || r.executedReps != null || r.executedRir != null;

/** One day built from an ended workout of this owner. */
export async function workoutDay(
	db: Database,
	userId: string,
	sessionId: string
): Promise<{ day: DayDraft; startedAt: Date }> {
	if (!z.string().uuid().safeParse(sessionId).success) throw new WorkoutNotFoundError();
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
	if (!session) throw new WorkoutNotFoundError();
	const blocks = await db
		.select({ block: sessionExercises, movement: exercises.canonicalMovement })
		.from(sessionExercises)
		.innerJoin(exercises, eq(exercises.id, sessionExercises.exerciseId))
		.where(and(eq(sessionExercises.sessionId, session.id), eq(exercises.userId, userId)))
		.orderBy(asc(sessionExercises.position));
	const rows = await db
		.select()
		.from(sets)
		.where(and(eq(sets.sessionId, session.id), eq(sets.userId, userId)))
		.orderBy(asc(sets.position));
	const draftExercises: ExerciseDraft[] = [];
	for (const { block, movement } of blocks) {
		const done = rows.filter((r) => r.sessionExerciseId === block.id && saved(r));
		if (!done.length) continue;
		const range = (list: SetRow[]): [number, number] => {
			const reps = list.map((r) => r.executedReps).filter((n): n is number => n != null && n > 0);
			if (reps.length) return [Math.min(...reps), Math.max(...reps)];
			// Load only, no reps: keep what was prescribed, else the default.
			const fallback = list.find((r) => r.prescribedRepsMin != null && r.prescribedRepsMax != null);
			return fallback
				? [fallback.prescribedRepsMin!, fallback.prescribedRepsMax!]
				: [blankSetDraft().targetRepsMin, blankSetDraft().targetRepsMax];
		};
		const work = range(done.filter((r) => r.setRole !== 'warmup'));
		const warm = range(done.filter((r) => r.setRole === 'warmup'));
		const placeholder = movement === PLACEHOLDER_MOVEMENT;
		draftExercises.push({
			exerciseId: placeholder ? null : block.exerciseId,
			newExercise: null,
			tier: block.tier,
			progressionPolicy: block.progressionPolicy,
			notes: null,
			sets: done.map((r) => {
				const [min, max] = r.setRole === 'warmup' ? warm : work;
				return {
					...blankSetDraft(),
					setRole: r.setRole,
					targetMetric: r.targetMetric,
					targetRepsMin: min,
					targetRepsMax: max
				};
			})
		});
	}
	return {
		day: { name: WORKOUT_DAY_NAME, notes: null, alternateGroupId: null, exercises: draftExercises },
		startedAt: session.startedAt
	};
}

/** A new program of one day, from a finished workout. */
export async function programDraftFromWorkout(
	db: Database,
	userId: string,
	sessionId: string
): Promise<ProgramDraft> {
	const { day, startedAt } = await workoutDay(db, userId, sessionId);
	return { name: workoutProgramName(startedAt), description: null, days: [day] };
}

/** An existing program's edit draft, with the workout added as its last day. */
export async function programDraftWithWorkoutDay(
	db: Database,
	userId: string,
	programId: string,
	sessionId: string
): Promise<ProgramDraft> {
	const draft = await loadProgramDraft(db, userId, programId);
	const { day } = await workoutDay(db, userId, sessionId);
	const names = new Set(draft.days.map((d) => d.name));
	let name = day.name;
	for (let n = 2; names.has(name); n++) name = `${day.name} ${n}`;
	draft.days.push({ ...day, name });
	return draft;
}

/** The programs a workout can be added to as a day: the owner's active ones. */
export async function programsToAddTo(db: Database, userId: string) {
	return db
		.select({ id: programs.id, name: programs.name })
		.from(programs)
		.where(
			and(eq(programs.userId, userId), eq(programs.isActive, true), isNull(programs.systemKind))
		)
		.orderBy(asc(programs.name));
}

export { ProgramNotFoundError };
