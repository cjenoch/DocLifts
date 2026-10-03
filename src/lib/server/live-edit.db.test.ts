import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { createTestUser, setupTestDb, resetTestDb, withTwoUsers } from './test-db';
import * as s from './db/schema';
import { blankSetDraft, type ProgramDraft } from '../program-draft';
import { loadProgramDraft, saveProgramDraft } from './program-builder';
import { endSession, loadSessionSets, startSessionForDay } from './sessions';
import { computeConsecutiveBackwards } from './progression';
import {
	applyProgramSwaps,
	moveSessionExercise,
	removeSessionExercise,
	skipRestOfExercise,
	swapSessionExercise,
	WorkoutEditError
} from './live-edit';

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

const STALE = 'Please reload and try again.';

/** A one-day program: press 3 sets, row 2 sets, curl 2 sets, all dumbbell. */
async function fixture(userId?: string) {
	const db = h.db;
	userId ??= await createTestUser(db, 'live-edit');
	const set = () => ({ ...blankSetDraft(), targetRepsMin: 8, targetRepsMax: 12, targetRir: 2 });
	const ex = (name: string, count: number): ProgramDraft['days'][number]['exercises'][number] => ({
		exerciseId: null,
		newExercise: { name, equipmentType: 'dumbbell', isLowerBody: false },
		tier: 'secondary',
		progressionPolicy: 'standard',
		notes: null,
		sets: Array.from({ length: count }, set)
	});
	const saved = await saveProgramDraft(db, userId, {
		requestId: randomUUID(),
		sourceProgramId: null,
		draft: {
			name: 'Upper',
			description: null,
			days: [
				{
					name: 'Day',
					notes: null,
					alternateGroupId: null,
					exercises: [ex('DB press', 3), ex('DB row', 2), ex('DB curl', 2)]
				}
			]
		}
	});
	const [day] = await db.select().from(s.days).where(eq(s.days.programId, saved.id));
	const [fly] = await db
		.insert(s.exercises)
		.values({ name: 'DB fly', equipmentType: 'dumbbell', userId })
		.returning();
	return { db, userId, programId: saved.id, dayId: day.id, fly };
}

async function start(userId: string, dayId: string) {
	const started = await startSessionForDay(h.db, userId, dayId);
	if (!started.ok) throw new Error(started.message);
	return started.sessionId;
}
async function occurrences(sessionId: string) {
	return h.db
		.select()
		.from(s.sessionExercises)
		.where(eq(s.sessionExercises.sessionId, sessionId))
		.orderBy(asc(s.sessionExercises.position));
}
const occurrenceNamed = async (sessionId: string, name: string) =>
	(await occurrences(sessionId)).find((o) => o.exerciseName === name)!;
async function setsOf(occurrenceId: string) {
	return h.db
		.select()
		.from(s.sets)
		.where(eq(s.sets.sessionExerciseId, occurrenceId))
		.orderBy(asc(s.sets.position));
}
async function log(occurrenceId: string, load: number, reps: number, only?: number[]) {
	for (const row of await setsOf(occurrenceId))
		if (!only || only.includes(row.position))
			await h.db
				.update(s.sets)
				.set({ executedLoad: load, executedReps: reps, executedRir: 2 })
				.where(eq(s.sets.id, row.id));
}

describe('reorder', () => {
	it('moves an exercise up and down; positions stay unique and survive a reload', async () => {
		const { userId, dayId } = await fixture();
		const sessionId = await start(userId, dayId);
		const row = await occurrenceNamed(sessionId, 'DB row');
		await moveSessionExercise(h.db, userId, sessionId, { occurrenceId: row.id, direction: 'up' });
		expect((await occurrences(sessionId)).map((o) => o.exerciseName)).toEqual([
			'DB row',
			'DB press',
			'DB curl'
		]);
		await moveSessionExercise(h.db, userId, sessionId, { occurrenceId: row.id, direction: 'down' });
		await moveSessionExercise(h.db, userId, sessionId, { occurrenceId: row.id, direction: 'down' });
		const after = await occurrences(sessionId);
		expect(after.map((o) => o.exerciseName)).toEqual(['DB press', 'DB curl', 'DB row']);
		expect(new Set(after.map((o) => o.position)).size).toBe(3);
		// What the page reads after a reload, in its order.
		const page = await loadSessionSets(h.db, userId, sessionId);
		const order = [...new Map(page.map((x) => [x.sessionExerciseId, x])).values()]
			.sort((a, b) => a.occurrencePosition! - b.occurrencePosition!)
			.map((x) => x.exerciseName);
		expect(order).toEqual(['DB press', 'DB curl', 'DB row']);
		// The last cannot go further down.
		await expect(
			moveSessionExercise(h.db, userId, sessionId, { occurrenceId: row.id, direction: 'down' })
		).rejects.toThrow(STALE);
	});
});

describe('remove and skip', () => {
	it('removes an untouched planned exercise from today only; the program still lists it', async () => {
		const { userId, dayId, programId } = await fixture();
		const before = await loadProgramDraft(h.db, userId, programId);
		const sessionId = await start(userId, dayId);
		const curl = await occurrenceNamed(sessionId, 'DB curl');
		expect(await removeSessionExercise(h.db, userId, sessionId, { occurrenceId: curl.id })).toEqual(
			{ removedSets: 2, removedLogged: 0 }
		);
		expect((await occurrences(sessionId)).map((o) => o.exerciseName)).toEqual([
			'DB press',
			'DB row'
		]);
		expect(await setsOf(curl.id)).toEqual([]);
		expect(await loadProgramDraft(h.db, userId, programId)).toEqual(before);
		await endSession(h.db, userId, sessionId);
		const tomorrow = await start(userId, dayId);
		expect((await occurrences(tomorrow)).map((o) => o.exerciseName)).toContain('DB curl');
	});

	it('removing logged sets needs their count; a stale count is refused', async () => {
		const { userId, dayId } = await fixture();
		const sessionId = await start(userId, dayId);
		const press = await occurrenceNamed(sessionId, 'DB press');
		await log(press.id, 50, 10, [1, 2]);
		await expect(
			removeSessionExercise(h.db, userId, sessionId, { occurrenceId: press.id })
		).rejects.toThrow(STALE);
		await expect(
			removeSessionExercise(h.db, userId, sessionId, { occurrenceId: press.id, loggedCount: '1' })
		).rejects.toThrow(STALE);
		expect(await setsOf(press.id)).toHaveLength(3);
		expect(
			await removeSessionExercise(h.db, userId, sessionId, {
				occurrenceId: press.id,
				loggedCount: '2'
			})
		).toEqual({ removedSets: 3, removedLogged: 2 });
		expect(await setsOf(press.id)).toEqual([]);
	});

	it('skip the rest removes only the empty sets', async () => {
		const { userId, dayId } = await fixture();
		const sessionId = await start(userId, dayId);
		const press = await occurrenceNamed(sessionId, 'DB press');
		// Nothing logged: skip is not offered (remove is).
		await expect(
			skipRestOfExercise(h.db, userId, sessionId, { occurrenceId: press.id })
		).rejects.toThrow(STALE);
		await log(press.id, 50, 10, [1]);
		expect(await skipRestOfExercise(h.db, userId, sessionId, { occurrenceId: press.id })).toEqual({
			removedSets: 2
		});
		const left = await setsOf(press.id);
		expect(left.map((x) => [x.position, x.executedLoad])).toEqual([[1, 50]]);
		// All logged now: nothing left to skip.
		await expect(
			skipRestOfExercise(h.db, userId, sessionId, { occurrenceId: press.id })
		).rejects.toThrow(STALE);
	});
});

describe('the progression engine ignores a removed or skipped exercise', () => {
	async function clearedLastTime() {
		const f = await fixture();
		const first = await start(f.userId, f.dayId);
		await log((await occurrenceNamed(first, 'DB press')).id, 100, 12);
		await endSession(h.db, f.userId, first);
		return f;
	}
	const loads = async (sessionId: string) =>
		(await setsOf((await occurrenceNamed(sessionId, 'DB press')).id)).map((x) => x.prescribedLoad);

	it('a removed exercise leaves no evidence: the next workout prescribes what this one did', async () => {
		const { userId, dayId } = await clearedLastTime();
		const second = await start(userId, dayId);
		const prescribed = await loads(second);
		expect(prescribed).toEqual([105, 105, 105]);
		await removeSessionExercise(h.db, userId, second, {
			occurrenceId: (await occurrenceNamed(second, 'DB press')).id
		});
		await endSession(h.db, userId, second);
		expect(await loads(await start(userId, dayId))).toEqual(prescribed);
	});

	it('a skipped exercise is not a failed session: no backwards streak, no lower load', async () => {
		const { userId, dayId } = await clearedLastTime();
		const second = await start(userId, dayId);
		const press = await occurrenceNamed(second, 'DB press');
		await log(press.id, 105, 12, [1]);
		await skipRestOfExercise(h.db, userId, second, { occurrenceId: press.id });
		await endSession(h.db, userId, second);
		for (const position of [1, 2, 3])
			expect(
				await computeConsecutiveBackwards(h.db, userId, press.exerciseId, 'working', position)
			).toBe(0);
		const third = await start(userId, dayId);
		const next = await setsOf((await occurrenceNamed(third, 'DB press')).id);
		for (const row of next) {
			expect(row.prescribedLoad).toBeGreaterThanOrEqual(105);
			expect(row.suggestionReasoning ?? '').not.toMatch(/deload|backwards/i);
		}
	});
});

describe('swap', () => {
	/** Fly history: an ended workout with three working sets of 40 x 10. */
	async function flyHistory(userId: string, dayId: string, programId: string, flyId: string) {
		const [old] = await h.db
			.insert(s.sessions)
			.values({
				userId,
				dayId,
				programId,
				startedAt: new Date(Date.now() - 86_400_000),
				endedAt: new Date()
			})
			.returning();
		await h.db.insert(s.sets).values(
			[1, 2, 3].map((position) => ({
				userId,
				sessionId: old.id,
				exerciseId: flyId,
				position,
				setRole: 'working' as const,
				prescribedRepsMin: 8,
				prescribedRepsMax: 12,
				prescribedRir: 2,
				executedLoad: 40,
				executedReps: 10,
				executedRir: 2
			}))
		);
	}

	it('just today: the new exercise, its own last numbers, targets kept, the program link dropped', async () => {
		const { userId, dayId, programId, fly } = await fixture();
		await flyHistory(userId, dayId, programId, fly.id);
		const sessionId = await start(userId, dayId);
		const press = await occurrenceNamed(sessionId, 'DB press');
		const before = await setsOf(press.id);
		const swapped = await swapSessionExercise(h.db, userId, sessionId, {
			occurrenceId: press.id,
			exerciseId: fly.id,
			scope: 'today'
		});
		expect(swapped).toMatchObject({
			id: press.id,
			exerciseName: 'DB fly',
			position: press.position
		});
		const after = await setsOf(press.id);
		expect(
			after.map((x) => [
				x.position,
				x.setRole,
				x.prescribedRepsMin,
				x.prescribedRepsMax,
				x.prescribedRir
			])
		).toEqual(
			before.map((x) => [
				x.position,
				x.setRole,
				x.prescribedRepsMin,
				x.prescribedRepsMax,
				x.prescribedRir
			])
		);
		for (const row of after) {
			expect(row.exerciseId).toBe(fly.id);
			expect(row.prescribedSetId).toBeNull();
			expect(row.prescribedLoad).toBe(40);
		}
		await endSession(h.db, userId, sessionId);
		expect(await applyProgramSwaps(h.db, userId, sessionId)).toEqual({ kind: 'none' });
		const draft = await loadProgramDraft(h.db, userId, programId);
		expect(draft.days[0].exercises[0].exerciseId).toBe(press.exerciseId);
	});

	it('is refused once a set has a saved value, and says why', async () => {
		const { userId, dayId, fly } = await fixture();
		const sessionId = await start(userId, dayId);
		const press = await occurrenceNamed(sessionId, 'DB press');
		await log(press.id, 50, 10, [2]);
		await expect(
			swapSessionExercise(h.db, userId, sessionId, { occurrenceId: press.id, exerciseId: fly.id })
		).rejects.toThrow(/logged sets/);
		expect((await setsOf(press.id)).every((x) => x.exerciseId === press.exerciseId)).toBe(true);
	});

	it('from now on: the program changes only when the workout ends, as a new version', async () => {
		const { userId, dayId, programId, fly } = await fixture();
		const sessionId = await start(userId, dayId);
		const row = await occurrenceNamed(sessionId, 'DB row');
		await swapSessionExercise(h.db, userId, sessionId, {
			occurrenceId: row.id,
			exerciseId: fly.id,
			scope: 'program'
		});
		// Still open: the program is untouched.
		expect((await loadProgramDraft(h.db, userId, programId)).days[0].exercises[1].exerciseId).toBe(
			row.exerciseId
		);
		expect((await setsOf(row.id)).every((x) => x.prescribedSetId != null)).toBe(true);
		await log(row.id, 30, 10);
		await endSession(h.db, userId, sessionId);
		const result = await applyProgramSwaps(h.db, userId, sessionId);
		expect(result.kind).toBe('updated');
		if (result.kind !== 'updated') return;
		const next = await loadProgramDraft(h.db, userId, result.programId);
		expect(next.days[0].exercises.map((e) => e.exerciseId)).toEqual([
			(await occurrenceNamed(sessionId, 'DB press')).exerciseId,
			fly.id,
			(await occurrenceNamed(sessionId, 'DB curl')).exerciseId
		]);
		const [old] = await h.db.select().from(s.programs).where(eq(s.programs.id, programId));
		expect(old.isActive).toBe(false);
		// Finishing twice cannot edit twice; the source workout is unchanged.
		expect(await applyProgramSwaps(h.db, userId, sessionId)).toEqual(result);
		expect((await setsOf(row.id)).map((x) => [x.exerciseId, x.executedLoad])).toEqual([
			[fly.id, 30],
			[fly.id, 30]
		]);
		// The new version's day starts with the fly in that place.
		const [newDay] = await h.db.select().from(s.days).where(eq(s.days.programId, result.programId));
		const tomorrow = await start(userId, newDay.id);
		expect((await occurrences(tomorrow)).map((o) => o.exerciseName)).toEqual([
			'DB press',
			'DB fly',
			'DB curl'
		]);
	});

	it('from now on fails safe while another workout of the program is open', async () => {
		const { userId, dayId, programId, fly } = await fixture();
		const [otherDay] = await h.db
			.insert(s.days)
			.values({ programId, name: 'Other', position: 2 })
			.returning();
		const sessionId = await start(userId, dayId);
		await start(userId, otherDay.id);
		const row = await occurrenceNamed(sessionId, 'DB row');
		await swapSessionExercise(h.db, userId, sessionId, {
			occurrenceId: row.id,
			exerciseId: fly.id,
			scope: 'program'
		});
		await endSession(h.db, userId, sessionId);
		const before = await loadProgramDraft(h.db, userId, programId);
		expect(await applyProgramSwaps(h.db, userId, sessionId)).toEqual({
			kind: 'failed',
			reason: 'open'
		});
		expect(await loadProgramDraft(h.db, userId, programId)).toEqual(before);
		const [program] = await h.db.select().from(s.programs).where(eq(s.programs.id, programId));
		expect(program.isActive).toBe(true);
	});

	it('an added exercise is not planned, so "From now on" is refused for it', async () => {
		const { userId, dayId, fly } = await fixture();
		const sessionId = await start(userId, dayId);
		const curl = await occurrenceNamed(sessionId, 'DB curl');
		await h.db
			.update(s.sets)
			.set({ prescribedSetId: null })
			.where(eq(s.sets.sessionExerciseId, curl.id));
		await expect(
			swapSessionExercise(h.db, userId, sessionId, {
				occurrenceId: curl.id,
				exerciseId: fly.id,
				scope: 'program'
			})
		).rejects.toThrow(STALE);
	});
});

describe('rules', () => {
	it('every action is refused once the workout has ended', async () => {
		const { userId, dayId, fly } = await fixture();
		const sessionId = await start(userId, dayId);
		const press = await occurrenceNamed(sessionId, 'DB press');
		await log(press.id, 50, 10, [1]);
		await endSession(h.db, userId, sessionId);
		const id = press.id;
		for (const attempt of [
			() => removeSessionExercise(h.db, userId, sessionId, { occurrenceId: id, loggedCount: '1' }),
			() => skipRestOfExercise(h.db, userId, sessionId, { occurrenceId: id }),
			() => moveSessionExercise(h.db, userId, sessionId, { occurrenceId: id, direction: 'down' }),
			() => swapSessionExercise(h.db, userId, sessionId, { occurrenceId: id, exerciseId: fly.id })
		])
			await expect(attempt()).rejects.toThrow('Session has ended');
		expect(await occurrences(sessionId)).toHaveLength(3);
	});

	it("works for the owner, and another user cannot touch the owner's workout", async () => {
		const { alice, bob } = await withTwoUsers(h.db);
		const { dayId, fly } = await fixture(alice);
		const sessionId = await start(alice, dayId);
		const row = await occurrenceNamed(sessionId, 'DB row');
		const curl = await occurrenceNamed(sessionId, 'DB curl');
		// Positive first.
		await moveSessionExercise(h.db, alice, sessionId, { occurrenceId: curl.id, direction: 'up' });
		expect((await occurrences(sessionId)).map((o) => o.exerciseName)).toEqual([
			'DB press',
			'DB curl',
			'DB row'
		]);
		const [bobsFly] = await h.db
			.insert(s.exercises)
			.values({ name: 'DB fly', equipmentType: 'dumbbell', userId: bob })
			.returning();
		for (const attempt of [
			() => removeSessionExercise(h.db, bob, sessionId, { occurrenceId: row.id }),
			() => moveSessionExercise(h.db, bob, sessionId, { occurrenceId: row.id, direction: 'up' }),
			() =>
				swapSessionExercise(h.db, bob, sessionId, { occurrenceId: row.id, exerciseId: bobsFly.id })
		])
			await expect(attempt()).rejects.toThrow('Session not found');
		// Alice cannot swap in Bob's exercise either.
		await expect(
			swapSessionExercise(h.db, alice, sessionId, { occurrenceId: row.id, exerciseId: bobsFly.id })
		).rejects.toThrow(STALE);
		expect((await occurrences(sessionId)).map((o) => o.exerciseName)).toEqual([
			'DB press',
			'DB curl',
			'DB row'
		]);
		expect(fly.userId).toBe(alice);
		const ended = await h.db
			.select()
			.from(s.sessions)
			.where(and(eq(s.sessions.id, sessionId)));
		expect(ended[0].endedAt).toBeNull();
		expect(WorkoutEditError).toBeDefined();
	});
});
