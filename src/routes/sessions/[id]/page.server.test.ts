import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { setupTestDb, resetTestDb, type TestDb } from '$lib/server/test-db';
import { startSessionForDay } from '$lib/server/sessions';
import { createGym, createMachine } from '$lib/server/machines';

const testDb = vi.hoisted(() => ({ db: null as TestDb | null }));
vi.mock('$lib/server/db', async () => {
	const schema = await import('$lib/server/db/schema');
	return {
		get db() {
			return testDb.db;
		},
		...schema
	};
});

import { actions, load } from './+page.server';
import * as s from '$lib/server/db/schema';

let harness: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
	harness = await setupTestDb();
	testDb.db = harness.db;
});
beforeEach(async () => {
	await resetTestDb(harness.client);
});
afterAll(async () => {
	await harness?.end();
});

type ActionEvent = Parameters<(typeof actions)['updateSet']>[0];
const post = (id: string, form: Record<string, string>): ActionEvent => {
	const fd = new FormData();
	for (const [k, v] of Object.entries(form)) fd.append(k, v);
	return {
		request: new Request('http://test.local/', { method: 'POST', body: fd }),
		params: { id }
	} as unknown as ActionEvent;
};

async function startWorkout() {
	const db = testDb.db!;
	const [program] = await db.insert(s.programs).values({ name: 'P' }).returning();
	const [day] = await db
		.insert(s.days)
		.values({ programId: program.id, name: 'D', position: 1 })
		.returning();
	const [exercise] = await db
		.insert(s.exercises)
		.values({ name: 'Press', canonicalMovement: 'chest_press', equipmentType: 'machine-plate' })
		.returning();
	const [dx] = await db
		.insert(s.dayExercises)
		.values({ dayId: day.id, exerciseId: exercise.id, position: 1, tier: 'secondary' })
		.returning();
	await db.insert(s.prescribedSets).values(
		[1, 2].map((position) => ({
			dayExerciseId: dx.id,
			position,
			setRole: 'working' as const,
			targetRepsMin: 8,
			targetRepsMax: 10,
			targetRir: 1,
			initialLoad: 50
		}))
	);
	const started = await startSessionForDay(db, day.id);
	if (!started.ok) throw new Error(started.message);
	const rows = await db
		.select()
		.from(s.sets)
		.where(eq(s.sets.sessionId, started.sessionId))
		.orderBy(asc(s.sets.position));
	return { sessionId: started.sessionId, sets: rows };
}

it('load returns 404 for a session id absent from the database', async () => {
	const thrown = await Promise.resolve(
		load({
			params: { id: randomUUID() },
			url: new URL('http://test.local/')
		} as Parameters<typeof load>[0])
	).catch((e: unknown) => e);
	expect((thrown as { status?: number })?.status).toBe(404);
});

it('updateSet rejects a malformed session id with 400', async () => {
	const result = await actions.updateSet(post('not-a-uuid', { setId: randomUUID() }));
	expect(result).toMatchObject({ status: 400, data: { message: 'Invalid session id' } });
});

it('updateSet rejects a missing setId with 400', async () => {
	const { sessionId } = await startWorkout();
	const result = await actions.updateSet(post(sessionId, {}));
	expect(result).toMatchObject({ status: 400, data: { message: 'Missing setId' } });
});

it('updateSet rejects a malformed setId with 400', async () => {
	const { sessionId } = await startWorkout();
	const result = await actions.updateSet(post(sessionId, { setId: 'bad' }));
	expect(result).toMatchObject({ status: 400, data: { message: 'Invalid setId' } });
});

it('updateSet persists executed values and returns savedSetId', async () => {
	const { sessionId, sets } = await startWorkout();
	const result = await actions.updateSet(
		post(sessionId, {
			setId: sets[0].id,
			executedLoad: '100',
			executedReps: '8',
			executedRir: '1'
		})
	);
	expect(result).toMatchObject({ savedSetId: sets[0].id });
	const [row] = await testDb.db!.select().from(s.sets).where(eq(s.sets.id, sets[0].id));
	expect(row.executedLoad).toBe(100);
	expect(row.executedReps).toBe(8);
	expect(row.executedRir).toBe(1);
});

it('updateSet maps an unknown set id to 404', async () => {
	const { sessionId } = await startWorkout();
	const result = await actions.updateSet(
		post(sessionId, { setId: randomUUID(), executedLoad: '100' })
	);
	expect(result).toMatchObject({ status: 404 });
});

it('appendSet rejects a malformed session id with 400', async () => {
	const result = await actions.appendSet(
		post('nope', {
			sourceSetId: randomUUID(),
			requestId: randomUUID(),
			setRole: 'working'
		})
	);
	expect(result).toMatchObject({ status: 400, data: { message: 'Invalid session id' } });
});

it('appendSet adds an empty set and returns its id', async () => {
	const { sessionId, sets } = await startWorkout();
	const result = await actions.appendSet(
		post(sessionId, {
			sourceSetId: sets[0].id,
			requestId: randomUUID(),
			setRole: 'working'
		})
	);
	expect(result).toMatchObject({ addedSetId: expect.any(String) });
	const addedId = (result as { addedSetId: string }).addedSetId;
	const [row] = await testDb.db!.select().from(s.sets).where(eq(s.sets.id, addedId));
	expect(row).toBeDefined();
	expect(row.executedLoad).toBeNull();
	expect(row.sessionId).toBe(sessionId);
});

it('removeSet rejects a malformed session id with 400', async () => {
	const result = await actions.removeSet(post('nope', { setId: randomUUID() }));
	expect(result).toMatchObject({ status: 400, data: { message: 'Invalid session id' } });
});

it('removeSet removes a freshly appended empty set', async () => {
	const { sessionId, sets } = await startWorkout();
	const appended = await actions.appendSet(
		post(sessionId, {
			sourceSetId: sets[0].id,
			requestId: randomUUID(),
			setRole: 'working'
		})
	);
	const addedId = (appended as { addedSetId: string }).addedSetId;
	const result = await actions.removeSet(post(sessionId, { setId: addedId }));
	expect(result).toEqual({ removed: true });
	const rows = await testDb.db!.select().from(s.sets).where(eq(s.sets.id, addedId));
	expect(rows).toHaveLength(0);
});

it('removeSet refuses a logged set with 400', async () => {
	const { sessionId, sets } = await startWorkout();
	const last = sets[sets.length - 1];
	await actions.updateSet(post(sessionId, { setId: last.id, executedLoad: '100', executedReps: '8' }));
	const result = await actions.removeSet(post(sessionId, { setId: last.id }));
	expect(result).toMatchObject({
		status: 400,
		data: { message: 'Logged sets cannot be removed here.' }
	});
});

it('addExercise rejects a malformed session id with 400', async () => {
	const result = await actions.addExercise(post('nope', {}));
	expect(result).toMatchObject({ status: 400, data: { message: 'Invalid session id' } });
});

it('addExercise maps invalid input to 400', async () => {
	const { sessionId } = await startWorkout();
	const result = await actions.addExercise(post(sessionId, {}));
	expect(result).toMatchObject({ status: 400 });
});

it('addExercise creates an occurrence for a named exercise', async () => {
	const { sessionId } = await startWorkout();
	const result = await actions.addExercise(
		post(sessionId, {
			exerciseName: 'Curl',
			canonicalMovement: 'bicep_curl',
			equipmentType: 'dumbbell',
			setCount: '2',
			repsMin: '8',
			repsMax: '12',
			rir: '2',
			tier: 'isolation',
			progressionPolicy: 'standard',
			loadConvention: 'displayed',
			newGymName: 'Garage',
			newMachineName: 'Dumbbells'
		})
	);
	expect(result).toMatchObject({ addedExerciseId: expect.any(String) });
	const addedId = (result as { addedExerciseId: string }).addedExerciseId;
	const [occurrence] = await testDb.db!
		.select()
		.from(s.sessionExercises)
		.where(eq(s.sessionExercises.id, addedId));
	expect(occurrence).toBeDefined();
	expect(occurrence.sessionId).toBe(sessionId);
});

it('bindMachine rejects a malformed session id with 400', async () => {
	const result = await actions.bindMachine(post('nope', { occurrenceId: randomUUID() }));
	expect(result).toMatchObject({ status: 400, data: { message: 'Invalid session id' } });
});

it('bindMachine maps a malformed occurrence id to 400', async () => {
	const { sessionId } = await startWorkout();
	const result = await actions.bindMachine(post(sessionId, { occurrenceId: 'bad', confirm: 'CHANGE' }));
	expect(result).toMatchObject({ status: 400 });
});

it('bindMachine binds a machine and redirects back to the session', async () => {
	const db = testDb.db!;
	const { sessionId } = await startWorkout();
	const gym = await createGym(db, { name: 'G' });
	const machine = await createMachine(db, {
		gymId: gym.id,
		localLabel: 'Press',
		equipmentType: 'machine-plate'
	});
	const [occurrence] = await db
		.select()
		.from(s.sessionExercises)
		.where(eq(s.sessionExercises.sessionId, sessionId));
	const thrown = await Promise.resolve(
		actions.bindMachine(
			post(sessionId, {
				occurrenceId: occurrence.id,
				gymId: gym.id,
				gymEquipmentId: machine.id,
				loadConvention: 'plates_per_side',
				confirm: 'CHANGE'
			})
		)
	).catch((e: unknown) => e);
	expect((thrown as { status?: number })?.status).toBe(303);
	expect((thrown as { location?: string })?.location).toBe(`/sessions/${sessionId}`);
	const [updated] = await db
		.select()
		.from(s.sessionExercises)
		.where(eq(s.sessionExercises.id, occurrence.id));
	expect(updated.gymEquipmentId).toBe(machine.id);
});
