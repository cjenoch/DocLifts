import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createTestUser, setupTestDb, resetTestDb } from './test-db';
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

// appendWorkoutSet stamps the row it creates (f0), so this checks production
// writes rather than fixture hygiene for that path.
afterEach(async () => {});
afterAll(async () => {
	await handle?.end();
});
async function fixture() {
	const db = handle.db;
	// One owner for the whole fixture. addSessionExercise is T3-scoped, so the
	// session and the exercise must carry the owner or lockActive() reports
	// 'Session not found' — sessions.ts does not set it until T4.
	const userId = await createTestUser(db, 'workout-sets');
	const [program] = await db.insert(s.programs).values({ name: 'Test', userId }).returning();
	const [day] = await db
		.insert(s.days)
		.values({ programId: program.id, name: 'Push', position: 1 })
		.returning();
	const [exercise] = await db
		.insert(s.exercises)
		.values({ name: 'DB press', equipmentType: 'dumbbell', userId })
		.returning();
	const [session] = await db
		.insert(s.sessions)
		.values({ programId: program.id, dayId: day.id, userId })
		.returning();
	const [source] = await db
		.insert(s.sets)
		.values({
			userId,
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
	return { db, userId, session, source, exercise };
}
it('appends to legacy groups without changing saved data and deduplicates concurrent retries', async () => {
	const { db, userId, session, source } = await fixture();
	const input = { sourceSetId: source.id, requestId: randomUUID(), setRole: 'working' };
	const [a, b] = await Promise.all([
		appendWorkoutSet(db, userId, session.id, input),
		appendWorkoutSet(db, userId, session.id, input)
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
	const { db, userId, session, source } = await fixture();
	await expect(
		appendWorkoutSet(db, userId, session.id, {
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
		appendWorkoutSet(db, userId, session.id, {
			sourceSetId: source.id,
			requestId: randomUUID(),
			setRole: 'working'
		})
	).rejects.toThrow('no longer active');
});
it('removes only the last unlogged set without renumbering or deleting logged data', async () => {
	const { db, userId, session, source } = await fixture();
	const added = await appendWorkoutSet(db, userId, session.id, {
		sourceSetId: source.id,
		requestId: randomUUID(),
		setRole: 'working'
	});
	await expect(removeEmptyLastSet(db, userId, session.id, source.id)).rejects.toThrow(
		'Logged sets'
	);
	await removeEmptyLastSet(db, userId, session.id, added.id);
	expect(await db.select().from(s.sets)).toEqual([source]);
});
it('creates equipment inline atomically and retains machine identity on added sets', async () => {
	const { db, userId, session, exercise } = await fixture();
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
	const occurrence = await addSessionExercise(db, userId, session.id, input);
	const retry = await addSessionExercise(db, userId, session.id, input);
	expect(retry.id).toBe(occurrence.id);
	expect(await db.select().from(s.gyms)).toHaveLength(1);
	const [source] = await db
		.select()
		.from(s.sets)
		.where(eq(s.sets.sessionExerciseId, occurrence.id));
	const added = await appendWorkoutSet(db, userId, session.id, {
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
		addSessionExercise(db, userId, session.id, {
			...input,
			requestId: randomUUID(),
			equipmentType: 'barbell',
			newGymName: 'Rollback gym'
		})
	).rejects.toThrow('type mismatch');
	expect(await db.select().from(s.gyms)).toHaveLength(1);
});

// Cross-tenant: the session lookup carries eq(sessions.userId, userId) in the
// same query, so another user's session reads as absent and the refusal is
// identical to an unknown id — 'This workout is no longer active.' — with no
// sets row written.
it("refuses to append to another user's session and writes nothing", async () => {
	const f = await fixture();
	const bob = await createTestUser(f.db, 'workout-sets-bob');
	const before = await f.db.select().from(s.sets);
	await expect(
		appendWorkoutSet(f.db, bob, f.session.id, {
			sourceSetId: f.source.id,
			requestId: crypto.randomUUID(),
			setRole: 'working'
		})
	).rejects.toThrow('This workout is no longer active.');
	const after = await f.db.select().from(s.sets);
	expect(after.length).toBe(before.length);
});

// The swap detector: a sessionId where another user's belongs is refused the
// same way, and Bob's own call against his own session still works. Without
// this the first test could pass for the wrong reason.
it('a session id belonging to another user is refused, not adopted', async () => {
	const f = await fixture();
	const bob = await createTestUser(f.db, 'workout-sets-bob');
	// Bob needs his own program and day: a second open session on Alice's day
	// violates the one-open-session-per-day constraint, and Bob touching her
	// day is not a legal setup anyway.
	const [bobsProgram] = await f.db
		.insert(s.programs)
		.values({ name: 'Bob Test', userId: bob })
		.returning();
	const [bobsDay] = await f.db
		.insert(s.days)
		.values({ programId: bobsProgram.id, name: 'Bob Push', position: 1 })
		.returning();
	const [bobsSession] = await f.db
		.insert(s.sessions)
		.values({ programId: bobsProgram.id, dayId: bobsDay.id, userId: bob })
		.returning();
	const [bobsSource] = await f.db
		.insert(s.sets)
		.values({
			userId: bob,
			sessionId: bobsSession.id,
			exerciseId: f.exercise.id,
			position: 2,
			setRole: 'working',
			targetMetric: 'seconds',
			executedLoad: 30,
			executedReps: 12
		})
		.returning();
	// Bob may append to his own session.
	const added = await appendWorkoutSet(f.db, bob, bobsSession.id, {
		sourceSetId: bobsSource.id,
		requestId: crypto.randomUUID(),
		setRole: 'working'
	});
	expect(added.userId).toBe(bob);
	// But not to Alice's, even with his own source set id.
	await expect(
		appendWorkoutSet(f.db, bob, f.session.id, {
			sourceSetId: bobsSource.id,
			requestId: crypto.randomUUID(),
			setRole: 'working'
		})
	).rejects.toThrow('This workout is no longer active.');
});

// Cross-tenant for removeEmptyLastSet. Same shape as the appendWorkoutSet pair:
// the positive case first, so the negative cannot pass for the wrong reason.
it('lets a user remove the last empty set from their own session', async () => {
	const f = await fixture();
	const bob = await createTestUser(f.db, 'workout-sets-remove-bob');
	const [bobsProgram] = await f.db
		.insert(s.programs)
		.values({ name: 'Bob Remove', userId: bob })
		.returning();
	const [bobsDay] = await f.db
		.insert(s.days)
		.values({ programId: bobsProgram.id, name: 'Bob Remove Day', position: 1 })
		.returning();
	const [bobsSession] = await f.db
		.insert(s.sessions)
		.values({ programId: bobsProgram.id, dayId: bobsDay.id, userId: bob })
		.returning();
	const rows = await f.db
		.insert(s.sets)
		.values([
			{
				userId: bob,
				sessionId: bobsSession.id,
				exerciseId: f.exercise.id,
				position: 1,
				setRole: 'working',
				targetMetric: 'reps'
			},
			{
				userId: bob,
				sessionId: bobsSession.id,
				exerciseId: f.exercise.id,
				position: 2,
				setRole: 'working',
				targetMetric: 'reps'
			}
		])
		.returning();
	// Position 2 is last, so removing it is legal.
	await removeEmptyLastSet(f.db, bob, bobsSession.id, rows[1].id);
	const left = await f.db.select().from(s.sets).where(eq(s.sets.sessionId, bobsSession.id));
	expect(left.map((r) => r.id)).toEqual([rows[0].id]);
});

it("refuses to remove a set from another user's session and leaves the row intact", async () => {
	const f = await fixture();
	const bob = await createTestUser(f.db, 'workout-sets-remove-bob');
	// Add a second empty set so position 2 is last and would be removable if
	// the owner predicate were missing. Only the owner check stands between
	// this call and a cross-tenant delete.
	const [empty] = await f.db
		.insert(s.sets)
		.values({
			userId: f.userId,
			sessionId: f.session.id,
			exerciseId: f.exercise.id,
			position: 3,
			setRole: 'working',
			targetMetric: 'seconds'
		})
		.returning();
	await expect(removeEmptyLastSet(f.db, bob, f.session.id, empty.id)).rejects.toThrow(
		'This workout is no longer active.'
	);
	const still = await f.db.select().from(s.sets).where(eq(s.sets.id, empty.id));
	expect(still.length).toBe(1);
});
