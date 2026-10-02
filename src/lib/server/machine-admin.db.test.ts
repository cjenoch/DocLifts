import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { setupTestDb, resetTestDbWithUsers, type TestDb } from './test-db';
import * as s from './db/schema';
import {
	applyStandardStack,
	archivedRows,
	changeMachineModel,
	FINISH_WORKOUT_FIRST,
	gymRemovalPlan,
	machineRemovalPlan,
	mergeCandidates,
	mergeMachines,
	mergePreview,
	removeGym,
	removeMachine,
	replaceMachine,
	restoreGym,
	restoreMachine,
	undoableMergeInto,
	undoMerge
} from './machine-admin';
import { addSessionExercise, createGym, createMachine, machineChoices } from './machines';
import { quickStartChoices, startQuickSession } from './quick-workouts';
import { endSession } from './sessions';
import { instancesOfModel } from './catalog';
import { getLastCompletedSet } from './progression';

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
let gymId: string;
let stackModel: typeof s.equipmentModels.$inferSelect;
let otherStackModel: typeof s.equipmentModels.$inferSelect;
let plateModel: typeof s.equipmentModels.$inferSelect;

const model = async (code: string, name: string, loadingType: string, standardStackLb?: number) =>
	(
		await db
			.insert(s.equipmentModels)
			.values({
				manufacturer: 'Life Fitness',
				code,
				name,
				loadingType,
				standardStackLb,
				confidence: 'manufacturer_page'
			})
			.returning()
	)[0];

beforeEach(async () => {
	[{ id: alice }, { id: bob }] = await resetTestDbWithUsers(db, handle.client, 2, 'machine-admin');
	gymId = (await createGym(db, alice, { name: 'Main gym' })).id;
	stackModel = await model('LC-1', 'Leg Curl', 'machine-stack', 200);
	otherStackModel = await model('LE-1', 'Leg Extension', 'machine-stack', 300);
	plateModel = await model('LP-1', 'Leg Press', 'machine-plate');
});

const machine = (opts: { label?: string; type?: string; modelId?: string; gym?: string } = {}) =>
	createMachine(db, alice, {
		gymId: opts.gym ?? gymId,
		localLabel: opts.label,
		equipmentType: opts.type ?? 'machine-stack',
		equipmentModelId: opts.modelId
	});

/** A finished workout with one exercise on `machineId`: sets of `load` x 10. */
async function logOn(machineId: string, load = 100, exerciseName = 'Leg curl', end = true) {
	const started = await startQuickSession(db, alice, gymId);
	if (!started.ok) throw new Error(started.message);
	const [ex] = await db
		.select()
		.from(s.exercises)
		.where(eq(s.exercises.name, exerciseName))
		.limit(1);
	const occurrence = await addSessionExercise(db, alice, started.sessionId, {
		...(ex && ex.userId === alice ? { exerciseId: ex.id } : { exerciseName }),
		equipmentType: 'machine-stack',
		gymId,
		gymEquipmentId: machineId,
		loadConvention: 'displayed',
		setCount: 2,
		repsMin: 8,
		repsMax: 12,
		rir: 2,
		tier: 'secondary',
		progressionPolicy: 'standard'
	});
	await db
		.update(s.sets)
		.set({ executedLoad: load, executedReps: 10, executedRir: 2 })
		.where(eq(s.sets.sessionExerciseId, occurrence.id));
	if (end) await endSession(db, alice, started.sessionId);
	return { sessionId: started.sessionId, occurrence };
}

const machineRow = async (id: string) =>
	(await db.select().from(s.gymEquipment).where(eq(s.gymEquipment.id, id)))[0];

describe('Part G: remove and restore', () => {
	it('a machine nothing points at is deleted', async () => {
		const m = await machine({ label: 'Mistake' });
		expect(await machineRemovalPlan(db, alice, gymId, m.id)).toEqual({
			outcome: 'delete',
			blocked: false
		});
		expect(await removeMachine(db, alice, gymId, m.id)).toEqual({ outcome: 'deleted' });
		expect(await machineRow(m.id)).toBeUndefined();
	});

	it('a machine with history is archived: gone from every chooser, kept in history, restored unchanged', async () => {
		const m = await machine({ modelId: stackModel.id });
		const { sessionId } = await logOn(m.id, 100);
		expect((await machineRemovalPlan(db, alice, gymId, m.id))?.outcome).toBe('archive');
		expect(await removeMachine(db, alice, gymId, m.id)).toEqual({ outcome: 'archived' });

		expect((await machineRow(m.id)).archivedAt).not.toBeNull();
		expect((await machineChoices(db, alice)).machines.map((x) => x.id)).not.toContain(m.id);
		expect(await instancesOfModel(db, alice, stackModel.id)).toEqual([]);
		expect((await archivedRows(db, alice)).machines.map((x) => x.id)).toEqual([m.id]);
		// The past workout still points at it.
		const [past] = await db
			.select()
			.from(s.sessionExercises)
			.where(eq(s.sessionExercises.sessionId, sessionId));
		expect(past.gymEquipmentId).toBe(m.id);
		// A workout cannot choose it.
		const next = await startQuickSession(db, alice, gymId);
		if (!next.ok) throw new Error(next.message);
		await expect(
			addSessionExercise(db, alice, next.sessionId, {
				exerciseName: 'Another curl',
				equipmentType: 'machine-stack',
				gymId,
				gymEquipmentId: m.id,
				loadConvention: 'displayed',
				setCount: 1,
				repsMin: 8,
				repsMax: 12,
				rir: 2,
				tier: 'secondary',
				progressionPolicy: 'standard'
			})
		).rejects.toThrow('Machine not found in selected gym');
		await endSession(db, alice, next.sessionId);

		const restored = await restoreMachine(db, alice, gymId, m.id);
		expect(restored?.archivedAt).toBeNull();
		expect((await machineChoices(db, alice)).machines.map((x) => x.id)).toContain(m.id);
		const [set] = await db.select().from(s.sets).where(eq(s.sets.sessionId, sessionId)).limit(1);
		const last = await getLastCompletedSet(db, alice, set.exerciseId, 'working', 1, randomUUID(), {
			gymEquipmentId: m.id,
			loadConvention: 'displayed'
		});
		expect(last?.executedLoad).toBe(100);
	});

	it('is refused while an open workout uses the machine or the gym', async () => {
		const m = await machine({ label: 'In use' });
		await logOn(m.id, 50, 'Leg curl', false);
		expect((await machineRemovalPlan(db, alice, gymId, m.id))?.blocked).toBe(true);
		await expect(removeMachine(db, alice, gymId, m.id)).rejects.toThrow(FINISH_WORKOUT_FIRST);
		await expect(removeGym(db, alice, gymId)).rejects.toThrow(FINISH_WORKOUT_FIRST);
		expect((await machineRow(m.id)).archivedAt).toBeNull();
	});

	it('a gym: deleted when unused, else archived with its machines hidden; restore brings back all but a machine archived on its own', async () => {
		const empty = await createGym(db, alice, { name: 'Never used' });
		expect((await gymRemovalPlan(db, alice, empty.id))?.outcome).toBe('delete');
		expect(await removeGym(db, alice, empty.id)).toEqual({ outcome: 'deleted' });
		expect(await db.select().from(s.gyms).where(eq(s.gyms.id, empty.id))).toEqual([]);

		const kept = await machine({ label: 'Stays with the gym' });
		const own = await machine({ label: 'Archived on its own' });
		await logOn(own.id);
		await removeMachine(db, alice, gymId, own.id);
		expect(await removeGym(db, alice, gymId)).toEqual({ outcome: 'archived' });
		const choices = await machineChoices(db, alice);
		expect(choices.gyms.map((g) => g.id)).not.toContain(gymId);
		expect(choices.machines.map((x) => x.id)).not.toContain(kept.id);
		expect((await quickStartChoices(db, alice)).gyms).toEqual([]);
		expect((await startQuickSession(db, alice, gymId)).ok).toBe(false);
		expect((await archivedRows(db, alice)).gyms.map((g) => g.id)).toEqual([gymId]);

		await restoreGym(db, alice, gymId);
		const back = (await machineChoices(db, alice)).machines.map((x) => x.id);
		expect(back).toContain(kept.id);
		expect(back).not.toContain(own.id);
	});

	it('another user can neither see, remove nor restore the rows', async () => {
		const m = await machine({ label: 'Alice only' });
		await logOn(m.id);
		// Positive first.
		expect(await machineRemovalPlan(db, alice, gymId, m.id)).not.toBeNull();
		expect(await machineRemovalPlan(db, bob, gymId, m.id)).toBeNull();
		expect(await removeMachine(db, bob, gymId, m.id)).toBeNull();
		expect(await removeGym(db, bob, gymId)).toBeNull();
		expect((await machineRow(m.id)).archivedAt).toBeNull();
		await removeMachine(db, alice, gymId, m.id);
		expect(await restoreMachine(db, bob, gymId, m.id)).toBeNull();
		expect(await restoreGym(db, bob, gymId)).toBeNull();
		expect((await archivedRows(db, bob)).machines).toEqual([]);
		expect((await machineRow(m.id)).archivedAt).not.toBeNull();
	});
});

describe('Part H: change a machine model', () => {
	it('same type changes in place: same id and history, default label follows, typed label stays, map pairs added, stack only offered', async () => {
		const m = await machine({ modelId: stackModel.id });
		expect(m.localLabel).toBe('Life Fitness Leg Curl (LC-1)');
		const { occurrence } = await logOn(m.id);
		const change = await changeMachineModel(db, alice, gymId, m.id, {
			modelId: otherStackModel.id
		});
		expect(change).toEqual({ outcome: 'changed', stackOffer: 300 });
		const after = await machineRow(m.id);
		expect(after).toMatchObject({
			equipmentModelId: otherStackModel.id,
			localLabel: 'Life Fitness Leg Extension (LE-1)',
			stackLb: 200
		});
		const pairs = await db
			.select()
			.from(s.exerciseEquipmentMap)
			.where(eq(s.exerciseEquipmentMap.exerciseId, occurrence.exerciseId));
		expect(pairs.map((p) => p.equipmentModelId).sort()).toEqual(
			[stackModel.id, otherStackModel.id].sort()
		);
		expect((await applyStandardStack(db, alice, gymId, m.id))?.stackLb).toBe(300);

		const typed = await machine({ label: 'Curl by the window', modelId: stackModel.id });
		await changeMachineModel(db, alice, gymId, typed.id, { modelId: otherStackModel.id });
		expect((await machineRow(typed.id)).localLabel).toBe('Curl by the window');
		await changeMachineModel(db, alice, gymId, typed.id, { modelId: '' });
		expect((await machineRow(typed.id)).equipmentModelId).toBeNull();
	});

	it('another type is never changed in place: Replace archives the old machine and makes a new one', async () => {
		const m = await machine({ modelId: stackModel.id });
		await logOn(m.id);
		expect(
			await changeMachineModel(db, alice, gymId, m.id, { modelId: plateModel.id })
		).toMatchObject({
			outcome: 'replace',
			modelId: plateModel.id
		});
		expect((await machineRow(m.id)).equipmentModelId).toBe(stackModel.id);
		const replaced = await replaceMachine(db, alice, gymId, m.id, { modelId: plateModel.id });
		expect(replaced?.old).toBe('archived');
		expect(replaced?.machine).toMatchObject({
			equipmentType: 'machine-plate',
			equipmentModelId: plateModel.id
		});
		expect((await machineRow(m.id)).archivedAt).not.toBeNull();
	});

	it('is refused during an open workout, on a model the user cannot see, and to another user', async () => {
		const m = await machine({ modelId: stackModel.id });
		const [bobsModel] = await db
			.insert(s.equipmentModels)
			.values({
				manufacturer: 'Bob',
				name: 'Own curl',
				loadingType: 'machine-stack',
				ownerUserId: bob,
				confidence: 'user'
			})
			.returning();
		await expect(
			changeMachineModel(db, alice, gymId, m.id, { modelId: bobsModel.id })
		).rejects.toThrow('Model not found');
		expect(
			await changeMachineModel(db, bob, gymId, m.id, { modelId: otherStackModel.id })
		).toBeNull();
		await logOn(m.id, 80, 'Leg curl', false);
		await expect(
			changeMachineModel(db, alice, gymId, m.id, { modelId: otherStackModel.id })
		).rejects.toThrow(FINISH_WORKOUT_FIRST);
		expect((await machineRow(m.id)).equipmentModelId).toBe(stackModel.id);
	});
});

describe('Part K: merge two machines', () => {
	it('moves every set, session exercise and photo; the merge lists them; undo puts back exactly those, and sets logged after stay', async () => {
		const keep = await machine({ modelId: stackModel.id });
		const drop = await machine({ label: 'Photo 2:18 PM' });
		expect((await mergeCandidates(db, alice, gymId, keep.id)).map((x) => x.id)).toEqual([drop.id]);
		const before = await logOn(drop.id, 90);
		const [photo] = await db
			.insert(s.equipmentPhotos)
			.values({
				userId: alice,
				gymId,
				storageKey: `k/${randomUUID()}`,
				contentType: 'image/jpeg',
				bytes: 1,
				width: 1,
				height: 1,
				sha256: 'x',
				status: 'confirmed',
				gymEquipmentId: drop.id
			})
			.returning();
		const preview = await mergePreview(db, alice, gymId, keep.id, drop.id);
		expect(preview).toMatchObject({
			sets: 2,
			workouts: 1,
			photos: 1,
			formatsDiffer: false,
			suggestedKeptId: keep.id
		});

		const merge = await mergeMachines(db, alice, gymId, { keptId: keep.id, droppedId: drop.id });
		expect(merge?.moved.sets).toHaveLength(2);
		expect(merge?.moved.sessionExercises).toEqual([before.occurrence.id]);
		expect(merge?.moved.photos).toEqual([photo.id]);
		const moved = await db.select().from(s.sets).where(inArray(s.sets.id, merge!.moved.sets));
		expect(moved.every((r) => r.gymEquipmentId === keep.id)).toBe(true);
		// The workout keeps the label it recorded.
		const [occ] = await db
			.select()
			.from(s.sessionExercises)
			.where(eq(s.sessionExercises.id, before.occurrence.id));
		expect(occ).toMatchObject({ gymEquipmentId: keep.id, machineLabel: 'Photo 2:18 PM' });
		expect(await machineRow(drop.id)).toMatchObject({ mergedIntoId: keep.id });
		expect((await machineRow(drop.id)).archivedAt).not.toBeNull();
		await expect(restoreMachine(db, alice, gymId, drop.id)).rejects.toThrow('Undo the merge');

		// A set logged on the kept machine after the merge.
		const later = await logOn(keep.id, 95);
		expect((await undoableMergeInto(db, alice, keep.id))?.merge.id).toBe(merge!.id);
		expect(await undoMerge(db, bob, merge!.id)).toBeNull();
		const undone = await undoMerge(db, alice, merge!.id);
		expect(undone?.undoneAt).not.toBeNull();
		const back = await db.select().from(s.sets).where(inArray(s.sets.id, merge!.moved.sets));
		expect(back.every((r) => r.gymEquipmentId === drop.id)).toBe(true);
		const stayed = await db
			.select()
			.from(s.sets)
			.where(eq(s.sets.sessionExerciseId, later.occurrence.id));
		expect(stayed.every((r) => r.gymEquipmentId === keep.id)).toBe(true);
		expect(await machineRow(drop.id)).toMatchObject({ archivedAt: null, mergedIntoId: null });
		expect(await undoMerge(db, alice, merge!.id)).toBeNull();
	});

	it('is refused across gyms or types, during an open workout, and for another user', async () => {
		const keep = await machine({ label: 'A' });
		const otherType = await machine({ label: 'Plates', type: 'machine-plate' });
		const otherGym = (await createGym(db, alice, { name: 'Other gym' })).id;
		const elsewhere = await machine({ label: 'Elsewhere', gym: otherGym });
		await expect(
			mergeMachines(db, alice, gymId, { keptId: keep.id, droppedId: otherType.id })
		).rejects.toThrow('same type');
		expect(
			await mergeMachines(db, alice, gymId, { keptId: keep.id, droppedId: elsewhere.id })
		).toBeNull();
		const drop = await machine({ label: 'B' });
		expect(await mergeMachines(db, bob, gymId, { keptId: keep.id, droppedId: drop.id })).toBeNull();
		await logOn(drop.id, 40, 'Leg curl', false);
		await expect(
			mergeMachines(db, alice, gymId, { keptId: keep.id, droppedId: drop.id })
		).rejects.toThrow(FINISH_WORKOUT_FIRST);
		expect((await machineRow(drop.id)).archivedAt).toBeNull();
	});
});
