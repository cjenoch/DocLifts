import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { createTestUser, setupTestDb, resetTestDb, withTwoUsers } from './test-db';
import * as s from './db/schema';
import { blankSetDraft, programDraftSchema, type ProgramDraft } from '../program-draft';
import { saveProgramDraft, loadProgramDraft } from './program-builder';
import { endSession, startSessionForDay } from './sessions';
import { moveSessionExercise } from './live-edit';
import { getLastCompletedSet } from './progression';
import { PLACEHOLDER_MOVEMENT } from './photo-workout';
import {
	programDraftFromWorkout,
	programDraftWithWorkoutDay,
	programsToAddTo,
	WORKOUT_DAY_NAME,
	WorkoutNotFoundError
} from './workout-to-program';

let h: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
	h = await setupTestDb();
});
afterAll(async () => {
	await h?.end();
});
beforeEach(async () => {
	await resetTestDb(h.client);
});

type Row = ProgramDraft['days'][number]['exercises'][number];
const row = (name: string, sets: number, tier: Row['tier'] = 'secondary'): Row => ({
	exerciseId: null,
	newExercise: { name, equipmentType: 'dumbbell', isLowerBody: false },
	tier,
	progressionPolicy: tier === 'isolation' ? 'cautious' : 'standard',
	notes: null,
	sets: Array.from({ length: sets }, (_, i) => ({
		...blankSetDraft(),
		setRole:
			tier === 'main' ? (i === 0 ? ('top' as const) : ('backoff' as const)) : ('working' as const)
	}))
});

/** A five-exercise workout, ended, with the press moved last and the calf raise never done. */
async function finishedWorkout(userId?: string) {
	userId ??= await createTestUser(h.db, 'save-as-program');
	const program = await saveProgramDraft(h.db, userId, {
		requestId: randomUUID(),
		sourceProgramId: null,
		draft: {
			name: 'Source',
			description: null,
			days: [
				{
					name: 'Day',
					notes: null,
					alternateGroupId: null,
					exercises: [
						row('DB press', 4),
						row('DB row', 2),
						row('DB curl', 3, 'isolation'),
						row('DB squat', 3, 'main'),
						row('DB calf', 2)
					]
				}
			]
		}
	});
	const [day] = await h.db.select().from(s.days).where(eq(s.days.programId, program.id));
	const started = await startSessionForDay(h.db, userId, day.id);
	if (!started.ok) throw new Error(started.message);
	const sessionId = started.sessionId;
	const blocks = await h.db
		.select()
		.from(s.sessionExercises)
		.where(eq(s.sessionExercises.sessionId, sessionId));
	const block = (name: string) => blocks.find((b) => b.exerciseName === name)!;
	const log = async (name: string, values: [number, number, string?][]) => {
		const rows = await h.db
			.select()
			.from(s.sets)
			.where(eq(s.sets.sessionExerciseId, block(name).id))
			.orderBy(asc(s.sets.position));
		for (const [i, [load, reps, role]] of values.entries())
			await h.db
				.update(s.sets)
				.set({
					executedLoad: load,
					executedReps: reps,
					executedRir: 2,
					...(role ? { setRole: role as 'warmup' } : {})
				})
				.where(eq(s.sets.id, rows[i].id));
	};
	// Three of four press sets: 10, 9, 8 reps; the fourth stays empty.
	await log('DB press', [
		[50, 10],
		[50, 9],
		[50, 8]
	]);
	await log('DB row', [
		[40, 5],
		[40, 5]
	]);
	// A warm-up of 12, then 10 and 12.
	await log('DB curl', [
		[10, 12, 'warmup'],
		[20, 10],
		[20, 12]
	]);
	await log('DB squat', [
		[100, 5],
		[90, 6],
		[90, 6]
	]);
	await moveSessionExercise(h.db, userId, sessionId, {
		occurrenceId: block('DB press').id,
		direction: 'down'
	});
	await endSession(h.db, userId, sessionId);
	return { userId, sessionId, programId: program.id };
}

async function workoutState(sessionId: string) {
	return {
		blocks: await h.db
			.select()
			.from(s.sessionExercises)
			.where(eq(s.sessionExercises.sessionId, sessionId))
			.orderBy(asc(s.sessionExercises.id)),
		sets: await h.db
			.select()
			.from(s.sets)
			.where(eq(s.sets.sessionId, sessionId))
			.orderBy(asc(s.sets.id)),
		session: await h.db.select().from(s.sessions).where(eq(s.sessions.id, sessionId))
	};
}

describe('a finished workout as a program draft', () => {
	it('follows the table: order as ended, saved sets only, exact reps, roles, tier, RIR 2, no load', async () => {
		const { userId, sessionId } = await finishedWorkout();
		const before = await workoutState(sessionId);
		const draft = await programDraftFromWorkout(h.db, userId, sessionId);
		expect(draft.name).toMatch(/^Workout · /);
		expect(draft.days).toHaveLength(1);
		expect(draft.days[0].name).toBe(WORKOUT_DAY_NAME);
		const library = await h.db.select().from(s.exercises).where(eq(s.exercises.userId, userId));
		const name = (id: string | null) => library.find((e) => e.id === id)?.name;
		const exercises = draft.days[0].exercises;
		// The press was moved down one place; the calf raise has no saved set.
		expect(exercises.map((e) => name(e.exerciseId))).toEqual([
			'DB row',
			'DB press',
			'DB curl',
			'DB squat'
		]);
		const shape = (e: Row) => e.sets.map((x) => [x.setRole, x.targetRepsMin, x.targetRepsMax]);
		expect(shape(exercises[0])).toEqual([
			['working', 5, 5],
			['working', 5, 5]
		]);
		expect(shape(exercises[1])).toEqual([
			['working', 8, 10],
			['working', 8, 10],
			['working', 8, 10]
		]);
		expect(shape(exercises[2])).toEqual([
			['warmup', 12, 12],
			['working', 10, 12],
			['working', 10, 12]
		]);
		expect(shape(exercises[3])).toEqual([
			['top', 5, 6],
			['backoff', 5, 6],
			['backoff', 5, 6]
		]);
		expect(exercises.map((e) => [e.tier, e.progressionPolicy])).toEqual([
			['secondary', 'standard'],
			['secondary', 'standard'],
			['isolation', 'cautious'],
			['main', 'standard']
		]);
		for (const set of exercises.flatMap((e) => e.sets)) {
			expect(set.targetRir).toBe(2);
			expect(set.initialLoad).toBeNull();
			expect(set.notes).toBeNull();
		}
		expect(JSON.stringify(draft)).not.toMatch(/gymEquipmentId|machine/i);
		expect(programDraftSchema.safeParse(draft).success).toBe(true);
		// Only read: the workout is unchanged, and nothing was created.
		expect(await workoutState(sessionId)).toEqual(before);
		expect(await h.db.select().from(s.programs).where(eq(s.programs.userId, userId))).toHaveLength(
			1
		);
	});

	it('saved, its day starts with the same exercises and last time’s numbers', async () => {
		const { userId, sessionId } = await finishedWorkout();
		const draft = await programDraftFromWorkout(h.db, userId, sessionId);
		const saved = await saveProgramDraft(h.db, userId, {
			requestId: randomUUID(),
			sourceProgramId: null,
			draft
		});
		const [day] = await h.db.select().from(s.days).where(eq(s.days.programId, saved.id));
		const next = await startSessionForDay(h.db, userId, day.id);
		if (!next.ok) throw new Error(next.message);
		const blocks = await h.db
			.select()
			.from(s.sessionExercises)
			.where(eq(s.sessionExercises.sessionId, next.sessionId))
			.orderBy(asc(s.sessionExercises.position));
		expect(blocks.map((b) => b.exerciseName)).toEqual([
			'DB row',
			'DB press',
			'DB curl',
			'DB squat'
		]);
		const press = await h.db
			.select()
			.from(s.sets)
			.where(eq(s.sets.sessionExerciseId, blocks[1].id))
			.orderBy(asc(s.sets.position));
		const last = await Promise.all(
			press.map((x) =>
				getLastCompletedSet(h.db, userId, x.exerciseId, x.setRole, x.position, next.sessionId)
			)
		);
		expect(last.map((x) => [x?.executedLoad, x?.executedReps])).toEqual([
			[50, 10],
			[50, 9],
			[50, 8]
		]);
		expect(press.map((x) => x.prescribedLoad)).toEqual([50, 50, 50]);
	});

	it('a block still on "Unidentified machine" must be named before the draft can be saved', async () => {
		const { userId, sessionId } = await finishedWorkout();
		const [placeholder] = await h.db
			.insert(s.exercises)
			.values({
				userId,
				name: 'Unidentified machine',
				equipmentType: 'machine-stack',
				canonicalMovement: PLACEHOLDER_MOVEMENT
			})
			.returning();
		const [block] = await h.db
			.insert(s.sessionExercises)
			.values({
				sessionId,
				exerciseId: placeholder.id,
				position: 99,
				exerciseName: placeholder.name,
				equipmentType: 'machine-stack',
				tier: 'secondary',
				progressionPolicy: 'standard'
			})
			.returning();
		await h.db.insert(s.sets).values({
			userId,
			sessionId,
			sessionExerciseId: block.id,
			exerciseId: placeholder.id,
			position: 1,
			setRole: 'working',
			executedLoad: 70,
			executedReps: 10
		});
		const draft = await programDraftFromWorkout(h.db, userId, sessionId);
		const last = draft.days[0].exercises.at(-1)!;
		expect(last).toMatchObject({ exerciseId: null, newExercise: null });
		expect(programDraftSchema.safeParse(draft).success).toBe(false);
		await expect(
			saveProgramDraft(h.db, userId, { requestId: randomUUID(), sourceProgramId: null, draft })
		).rejects.toThrow();
		// Named in the editor, it saves.
		last.newExercise = { name: 'Chest press', equipmentType: 'machine-stack', isLowerBody: false };
		expect(programDraftSchema.safeParse(draft).success).toBe(true);
	});

	it('adds the workout as the last day of an existing program, its edit draft', async () => {
		const { userId, sessionId, programId } = await finishedWorkout();
		const before = await loadProgramDraft(h.db, userId, programId);
		const draft = await programDraftWithWorkoutDay(h.db, userId, programId, sessionId);
		expect(draft.days.slice(0, -1)).toEqual(before.days);
		expect(draft.days.at(-1)!.name).toBe(WORKOUT_DAY_NAME);
		expect(draft.days.at(-1)!.exercises).toHaveLength(4);
		// Nothing changes until the edit draft is saved, as a new version.
		expect(await loadProgramDraft(h.db, userId, programId)).toEqual(before);
		const saved = await saveProgramDraft(h.db, userId, {
			requestId: randomUUID(),
			sourceProgramId: programId,
			draft
		});
		const again = await programDraftWithWorkoutDay(h.db, userId, saved.id, sessionId);
		expect(again.days.map((d) => d.name)).toEqual(['Day', 'Workout', 'Workout 2']);
		expect((await programsToAddTo(h.db, userId)).map((p) => p.id)).toEqual([saved.id]);
	});

	it('uses only the owner’s own ended workouts', async () => {
		const { alice, bob } = await withTwoUsers(h.db);
		const { sessionId } = await finishedWorkout(alice);
		// Positive first.
		expect((await programDraftFromWorkout(h.db, alice, sessionId)).days[0].exercises).toHaveLength(
			4
		);
		await expect(programDraftFromWorkout(h.db, bob, sessionId)).rejects.toBeInstanceOf(
			WorkoutNotFoundError
		);
		await expect(programDraftFromWorkout(h.db, alice, 'not-a-uuid')).rejects.toBeInstanceOf(
			WorkoutNotFoundError
		);
		await h.db
			.update(s.sessions)
			.set({ deletedAt: new Date() })
			.where(eq(s.sessions.id, sessionId));
		await expect(programDraftFromWorkout(h.db, alice, sessionId)).rejects.toBeInstanceOf(
			WorkoutNotFoundError
		);
		// An open workout is not finished.
		const { sessionId: other, programId } = await finishedWorkout(alice);
		await h.db.update(s.sessions).set({ endedAt: null }).where(eq(s.sessions.id, other));
		await expect(programDraftFromWorkout(h.db, alice, other)).rejects.toBeInstanceOf(
			WorkoutNotFoundError
		);
		expect(programId).toBeTruthy();
		expect(await programsToAddTo(h.db, bob)).toEqual([]);
	});
});
