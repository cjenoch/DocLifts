import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { setupTestDb, resetTestDb } from './test-db';
import * as s from './db/schema';
import { appendWorkoutSet, removeEmptyLastSet } from './workout-sets';
import { addSessionExercise } from './machines';
let handle: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
	handle = await setupTestDb();
});
beforeEach(async () => {
	await resetTestDb(handle.client);
});
afterAll(async () => {
	await handle?.end();
});
async function fixture() {
	const db = handle.db;
	const [program] = await db.insert(s.programs).values({ name: 'Test' }).returning();
	const [day] = await db
		.insert(s.days)
		.values({ programId: program.id, name: 'Push', position: 1 })
		.returning();
	const [exercise] = await db
		.insert(s.exercises)
		.values({ name: 'DB press', equipmentType: 'dumbbell' })
		.returning();
	const [session] = await db
		.insert(s.sessions)
		.values({ programId: program.id, dayId: day.id })
		.returning();
	const [source] = await db
		.insert(s.sets)
		.values({
			sessionId: session.id,
			exerciseId: exercise.id,
			position: 2,
			setRole: 'working',
			targetMetric: 'seconds',
			executedLoad: 30,
			executedReps: 12,
			prescribedLoad: 25,
			prescribedRepsMin: 8,
			prescribedRepsMax: 12,
			prescribedRir: 1
		})
		.returning();
	return { db, session, source, exercise };
}
it('appends to legacy groups without changing saved data and deduplicates concurrent retries', async () => {
	const { db, session, source } = await fixture();
	const input = { sourceSetId: source.id, requestId: randomUUID(), setRole: 'working' };
	const [a, b] = await Promise.all([
		appendWorkoutSet(db, session.id, input),
		appendWorkoutSet(db, session.id, input)
	]);
	expect(a.id).toBe(b.id);
	expect(a).toMatchObject({
		position: 3,
		sessionExerciseId: null,
		loadConvention: 'legacy',
		prescribedLoad: 30,
		executedLoad: null,
		executedReps: null,
		targetMetric: 'seconds'
	});
	expect((await db.select().from(s.sets).where(eq(s.sets.id, source.id)))[0]).toEqual(source);
	expect(await db.select().from(s.sets)).toHaveLength(2);
});
it('rejects cross-workout sources and ended workouts', async () => {
	const { db, session, source } = await fixture();
	await expect(
		appendWorkoutSet(db, session.id, {
			sourceSetId: randomUUID(),
			requestId: randomUUID(),
			setRole: 'working'
		})
	).rejects.toThrow('Exercise not found');
	await db
		.update(s.sessions)
		.set({ endedAt: new Date(Date.now() + 1000) })
		.where(eq(s.sessions.id, session.id));
	await expect(
		appendWorkoutSet(db, session.id, {
			sourceSetId: source.id,
			requestId: randomUUID(),
			setRole: 'working'
		})
	).rejects.toThrow('no longer active');
});
it('removes only the last unlogged set without renumbering or deleting logged data', async () => {
	const { db, session, source } = await fixture();
	const added = await appendWorkoutSet(db, session.id, {
		sourceSetId: source.id,
		requestId: randomUUID(),
		setRole: 'working'
	});
	await expect(removeEmptyLastSet(db, session.id, source.id)).rejects.toThrow('Logged sets');
	await removeEmptyLastSet(db, session.id, added.id);
	expect(await db.select().from(s.sets)).toEqual([source]);
});
it('creates equipment inline atomically and retains machine identity on added sets', async () => {
	const { db, session, exercise } = await fixture();
	const input = {
		requestId: randomUUID(),
		exerciseId: exercise.id,
		equipmentType: 'dumbbell',
		newGymName: 'Home',
		newMachineName: 'Dumbbells',
		loadConvention: 'per_arm',
		setCount: 2,
		repsMin: 8,
		repsMax: 12,
		rir: 1,
		tier: 'secondary',
		progressionPolicy: 'standard'
	};
	const occurrence = await addSessionExercise(db, session.id, input);
	const retry = await addSessionExercise(db, session.id, input);
	expect(retry.id).toBe(occurrence.id);
	expect(await db.select().from(s.gyms)).toHaveLength(1);
	const [source] = await db
		.select()
		.from(s.sets)
		.where(eq(s.sets.sessionExerciseId, occurrence.id));
	const added = await appendWorkoutSet(db, session.id, {
		sourceSetId: source.id,
		requestId: randomUUID(),
		setRole: 'warmup'
	});
	expect(added).toMatchObject({
		sessionExerciseId: occurrence.id,
		gymEquipmentId: occurrence.gymEquipmentId,
		loadConvention: 'per_arm',
		position: 3,
		prescribedLoad: null,
		executedLoad: null
	});
	await expect(
		addSessionExercise(db, session.id, {
			...input,
			requestId: randomUUID(),
			equipmentType: 'barbell',
			newGymName: 'Rollback gym'
		})
	).rejects.toThrow('type mismatch');
	expect(await db.select().from(s.gyms)).toHaveLength(1);
});
