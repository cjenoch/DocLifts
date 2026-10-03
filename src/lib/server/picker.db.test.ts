import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { setupTestDb, resetTestDbWithUsers, type TestDb } from './test-db';
import * as s from './db/schema';
import { pickerData } from './picker';
import { addSessionExercise, createGym, createMachine } from './machines';
import { startQuickSession } from './quick-workouts';
import { endSession } from './sessions';
import { removeMachine } from './machine-admin';
import {
	exercisesForPage,
	hideExercise,
	renameExercise,
	restoreExercise,
	setExerciseRegion
} from './exercise-admin';
import { ensurePlaceholderExercise } from './photo-workout';

let db: TestDb;
let handle: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
	handle = await setupTestDb();
	db = handle.db;
});
afterAll(async () => {
	await handle?.end();
});

let alice: string;
let bob: string;
let home: string;
let away: string;
beforeEach(async () => {
	[{ id: alice }, { id: bob }] = await resetTestDbWithUsers(db, handle.client, 2, 'picker');
	home = (await createGym(db, alice, { name: 'Home gym' })).id;
	away = (await createGym(db, alice, { name: 'Hotel gym' })).id;
	// Test users skip the sign-up hook, so give Alice the starter rows these use.
	await db.insert(s.exercises).values([
		{ userId: alice, name: 'Dumbbell curl', equipmentType: 'dumbbell', bodyRegion: 'arms' },
		{
			userId: alice,
			name: 'Leg press',
			equipmentType: 'machine-plate',
			isLowerBody: true,
			bodyRegion: 'legs'
		},
		{
			userId: alice,
			name: 'Leg curl',
			equipmentType: 'machine-stack',
			isLowerBody: true,
			bodyRegion: 'legs'
		}
	]);
});

const base = {
	loadConvention: 'per_arm',
	setCount: 2,
	repsMin: 8,
	repsMax: 12,
	rir: 2,
	tier: 'secondary',
	progressionPolicy: 'standard'
} as const;

async function workout(gymId: string, user = alice) {
	const started = await startQuickSession(db, user, gymId);
	if (!started.ok) throw new Error(started.message);
	return started.sessionId;
}
const logAll = (occurrenceId: string, load: number) =>
	db
		.update(s.sets)
		.set({ executedLoad: load, executedReps: 10, executedRir: 2 })
		.where(eq(s.sets.sessionExerciseId, occurrenceId));
const setsOf = (occurrenceId: string) =>
	db
		.select()
		.from(s.sets)
		.where(eq(s.sets.sessionExerciseId, occurrenceId))
		.orderBy(s.sets.position);
async function starter(name: string, user = alice) {
	const [row] = await db
		.select()
		.from(s.exercises)
		.where(and(eq(s.exercises.userId, user), eq(s.exercises.name, name)));
	return row;
}

describe('free weights (machines spec Part J)', () => {
	it('are added with no gym and no equipment, and the next workout at another gym shows last time', async () => {
		const curl = await starter('Dumbbell curl');
		const first = await workout(home);
		const block = await addSessionExercise(db, alice, first, {
			...base,
			exerciseId: curl.id,
			equipmentType: 'dumbbell'
		});
		expect(block).toMatchObject({ gymEquipmentId: null, machineLabel: null, gymName: 'Home gym' });
		expect((await setsOf(block.id)).every((r) => r.gymEquipmentId === null)).toBe(true);
		await logAll(block.id, 30);
		await endSession(db, alice, first);

		const second = await workout(away);
		const again = await addSessionExercise(db, alice, second, {
			...base,
			exerciseId: curl.id,
			equipmentType: 'dumbbell'
		});
		expect((await setsOf(again.id))[0].prescribedLoad).not.toBeNull();
	});

	it('old sets logged on an equipment row such as "Dumbbells" still count', async () => {
		const curl = await starter('Dumbbell curl');
		const rack = await createMachine(db, alice, {
			gymId: home,
			localLabel: 'Dumbbells',
			equipmentType: 'dumbbell'
		});
		const old = await workout(home);
		const onRow = await addSessionExercise(db, alice, old, {
			...base,
			exerciseId: curl.id,
			equipmentType: 'dumbbell',
			gymId: home,
			gymEquipmentId: rack.id
		});
		await logAll(onRow.id, 25);
		await endSession(db, alice, old);
		// The row stays, but it is not a machine to pick.
		expect((await pickerData(db, alice, home)).machines.map((m) => m.id)).not.toContain(rack.id);

		const now = await workout(away);
		const free = await addSessionExercise(db, alice, now, {
			...base,
			exerciseId: curl.id,
			equipmentType: 'dumbbell'
		});
		const [first] = await setsOf(free.id);
		expect(first.prescribedLoad).not.toBeNull();
		expect(first.gymEquipmentId).toBeNull();
	});

	it('a machine-type exercise is still refused without a machine', async () => {
		const press = await starter('Leg press');
		const id = await workout(home);
		await expect(
			addSessionExercise(db, alice, id, {
				...base,
				loadConvention: 'plates_per_side',
				exerciseId: press.id,
				equipmentType: 'machine-plate'
			})
		).rejects.toThrow('Choose or name your gym and equipment.');
	});
});

describe('pickerData (machines spec Parts I and J)', () => {
	it('machines with last use and exercises, recents, remembered formats; archived rows never; nothing of another user', async () => {
		const curl = await starter('Leg curl');
		const db1 = await starter('Dumbbell curl');
		const machine = await createMachine(db, alice, {
			gymId: home,
			localLabel: 'Curl by the door',
			equipmentType: 'machine-stack'
		});
		const gone = await createMachine(db, alice, {
			gymId: home,
			localLabel: 'Archived curl',
			equipmentType: 'machine-stack'
		});
		const id = await workout(home);
		const onMachine = await addSessionExercise(db, alice, id, {
			...base,
			loadConvention: 'displayed',
			exerciseId: curl.id,
			equipmentType: 'machine-stack',
			gymId: home,
			gymEquipmentId: machine.id
		});
		await logAll(onMachine.id, 110);
		const archivedUse = await addSessionExercise(db, alice, id, {
			...base,
			loadConvention: 'displayed',
			exerciseId: curl.id,
			equipmentType: 'machine-stack',
			gymId: home,
			gymEquipmentId: gone.id
		});
		await logAll(archivedUse.id, 90);
		const free = await addSessionExercise(db, alice, id, {
			...base,
			exerciseId: db1.id,
			equipmentType: 'dumbbell'
		});
		await logAll(free.id, 30);
		await endSession(db, alice, id);
		await removeMachine(db, alice, home, gone.id);

		const data = await pickerData(db, alice, home);
		expect(data.gymId).toBe(home);
		expect(data.gyms.map((g) => g.name)).toEqual(['Home gym', 'Hotel gym']);
		expect(data.machines.map((m) => m.label)).toEqual(['Curl by the door']);
		expect(data.machines[0]).toMatchObject({
			lastExerciseId: curl.id,
			lastTop: { load: 110, reps: 10 },
			exerciseIds: [curl.id]
		});
		expect(data.recentMachineIds[home]).toEqual([machine.id]);
		expect(data.recentExerciseIds.slice().sort()).toEqual([curl.id, db1.id].sort());
		expect(data.conventions[`${curl.id}|${machine.id}`]).toBe('displayed');
		expect(data.conventions[`${db1.id}|`]).toBe('per_arm');
		expect(data.lastMachineAt[`${curl.id}|${home}`]).toBeTruthy();
		expect(data.exercises.find((e) => e.id === curl.id)?.bodyRegion).toBe('legs');

		// Bob sees his own gym list and none of Alice's rows.
		const bobs = await pickerData(db, bob, home);
		expect(bobs.gyms).toEqual([]);
		expect(bobs.machines).toEqual([]);
		expect(bobs.gymId).toBeNull();
		expect(bobs.exercises.every((e) => e.id !== curl.id)).toBe(true);
	});
});

describe('the Exercises page (machines spec Part J)', () => {
	it('rename, region, hide and restore: past workouts keep their name, hidden leaves the picker only, another user cannot', async () => {
		const curl = await starter('Dumbbell curl');
		const id = await workout(home);
		const block = await addSessionExercise(db, alice, id, {
			...base,
			exerciseId: curl.id,
			equipmentType: 'dumbbell'
		});
		await logAll(block.id, 30);
		await endSession(db, alice, id);

		// Positive first, then the other user.
		expect(await renameExercise(db, alice, curl.id, { name: 'Hammer curl' })).toMatchObject({
			name: 'Hammer curl'
		});
		expect(await renameExercise(db, bob, curl.id, { name: 'Stolen' })).toBeNull();
		await expect(renameExercise(db, alice, curl.id, { name: 'Leg curl' })).rejects.toThrow(
			'You already have an exercise named "Leg curl"'
		);
		const [past] = await db
			.select()
			.from(s.sessionExercises)
			.where(eq(s.sessionExercises.id, block.id));
		expect(past.exerciseName).toBe('Dumbbell curl');

		expect((await setExerciseRegion(db, alice, curl.id, { bodyRegion: 'arms' }))?.bodyRegion).toBe(
			'arms'
		);
		expect(
			(await setExerciseRegion(db, alice, curl.id, { bodyRegion: '' }))?.bodyRegion
		).toBeNull();
		expect(await setExerciseRegion(db, bob, curl.id, { bodyRegion: 'legs' })).toBeNull();

		expect(await hideExercise(db, bob, curl.id)).toBeNull();
		expect((await hideExercise(db, alice, curl.id))?.archivedAt).not.toBeNull();
		expect((await pickerData(db, alice, home)).exercises.map((e) => e.id)).not.toContain(curl.id);
		expect((await exercisesForPage(db, alice)).hidden.map((e) => e.id)).toEqual([curl.id]);
		expect(await setsOf(block.id)).toHaveLength(2);
		expect(await restoreExercise(db, bob, curl.id)).toBeNull();
		expect((await restoreExercise(db, alice, curl.id))?.archivedAt).toBeNull();
		expect((await pickerData(db, alice, home)).exercises.map((e) => e.id)).toContain(curl.id);
	});

	it('never lists or changes the photo placeholder exercise', async () => {
		const placeholder = await ensurePlaceholderExercise(db, alice);
		const page = await exercisesForPage(db, alice);
		expect([...page.shown, ...page.hidden].map((e) => e.id)).not.toContain(placeholder.id);
		expect(await renameExercise(db, alice, placeholder.id, { name: 'Sneaky' })).toBeNull();
		expect(await hideExercise(db, alice, placeholder.id)).toBeNull();
	});
});
