import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { setupTestDb, resetTestDbWithUsers, type TestDb } from './test-db';
import * as s from './db/schema';
import {
	autoIdentifyRepeatVisit,
	identifySessionExercise,
	machinesToName,
	namedPhotoBlocks,
	undoPhotoIdentify,
	openPhotoBlock,
	photoBlocksForSession,
	photoTimeLabel,
	PLACEHOLDER_MOVEMENT
} from './photo-workout';
import { startQuickSession } from './quick-workouts';
import { addSessionExercise, createGym, createMachine } from './machines';
import { endSession } from './sessions';
import { FIXTURE_CANDIDATE } from './photos/test-fixtures';
import { workoutUi } from '../workout-ui';

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
let ilRow: typeof s.equipmentModels.$inferSelect;

beforeEach(async () => {
	[{ id: alice }, { id: bob }] = await resetTestDbWithUsers(db, handle.client, 2, 'photo-block');
	gymId = (await createGym(db, alice, { name: 'Corner gym' })).id;
	[ilRow] = await db
		.insert(s.equipmentModels)
		.values({
			manufacturer: 'Hammer Strength',
			productLine: 'Plate Loaded',
			code: 'IL-ROW',
			name: 'Iso-Lateral Row',
			loadingType: 'machine-plate',
			confidence: 'manufacturer_page'
		})
		.returning();
});

async function openSession(userId = alice, gym = gymId): Promise<string> {
	const started = await startQuickSession(db, userId, gym);
	if (!started.ok) throw new Error(started.message);
	return started.sessionId;
}

async function photo(userId = alice, gym = gymId, status: 'uploaded' | 'analyzed' = 'uploaded') {
	const id = randomUUID();
	const [row] = await db
		.insert(s.equipmentPhotos)
		.values({
			id,
			userId,
			gymId: gym,
			storageKey: `users/${userId}/equipment-photos/${id}.jpg`,
			contentType: 'image/jpeg',
			bytes: 1000,
			width: 1200,
			height: 1600,
			sha256: 'x'.repeat(64),
			status,
			candidate: status === 'analyzed' ? FIXTURE_CANDIDATE : null
		})
		.returning();
	return row;
}

const setsOf = (occurrenceId: string) =>
	db
		.select()
		.from(s.sets)
		.where(eq(s.sets.sessionExerciseId, occurrenceId))
		.orderBy(s.sets.position);

describe('openPhotoBlock (a photo opens a block at once)', () => {
	it('adds a block on a placeholder machine and exercise, with sets ready to log', async () => {
		const sessionId = await openSession();
		const p = await photo();
		const block = await openPhotoBlock(db, alice, sessionId, p.id, { timeLabel: '2:32 PM' });

		expect(block.exerciseName).toBe(workoutUi.placeholderExerciseName);
		expect(block.machineLabel).toBe(workoutUi.photoMachineLabel('2:32 PM'));
		expect(block.loadConvention).toBe('unknown');
		const [machine] = await db
			.select()
			.from(s.gymEquipment)
			.where(eq(s.gymEquipment.id, block.gymEquipmentId!));
		expect(machine).toMatchObject({ gymId, equipmentModelId: null });
		expect(await setsOf(block.id)).toHaveLength(workoutUi.photoBlockSets);
		const [linked] = await db
			.select()
			.from(s.equipmentPhotos)
			.where(eq(s.equipmentPhotos.id, p.id));
		expect(linked.sessionExerciseId).toBe(block.id);
		expect(linked.status).toBe('uploaded');
	});

	it('is idempotent per photo, and reuses one placeholder exercise per user', async () => {
		const sessionId = await openSession();
		const p = await photo();
		const first = await openPhotoBlock(db, alice, sessionId, p.id);
		const again = await openPhotoBlock(db, alice, sessionId, p.id);
		expect(again.id).toBe(first.id);
		const second = await openPhotoBlock(db, alice, sessionId, (await photo()).id);
		expect(second.exerciseId).toBe(first.exerciseId);
		const placeholders = await db
			.select()
			.from(s.exercises)
			.where(
				and(eq(s.exercises.userId, alice), eq(s.exercises.canonicalMovement, PLACEHOLDER_MOVEMENT))
			);
		expect(placeholders).toHaveLength(1);
	});

	it('another user can use neither the session nor the photo, and nothing is written', async () => {
		const sessionId = await openSession();
		const p = await photo();
		// Positive first: the owner can.
		const bobGym = (await createGym(db, bob, { name: 'Bob gym' })).id;
		const bobSession = await openSession(bob, bobGym);
		await expect(openPhotoBlock(db, bob, sessionId, p.id)).rejects.toThrow('Session not found');
		await expect(openPhotoBlock(db, bob, bobSession, p.id)).rejects.toThrow('Photo not found');
		const [untouched] = await db
			.select()
			.from(s.equipmentPhotos)
			.where(eq(s.equipmentPhotos.id, p.id));
		expect(untouched.sessionExerciseId).toBeNull();
		expect(await openPhotoBlock(db, alice, sessionId, p.id)).toBeTruthy();
	});

	it('refuses a finished workout', async () => {
		const sessionId = await openSession();
		await endSession(db, alice, sessionId);
		await expect(openPhotoBlock(db, alice, sessionId, (await photo()).id)).rejects.toThrow(
			'Session has ended'
		);
	});
});

describe('identifySessionExercise ("Use this")', () => {
	it('sets the model on the placeholder machine and never touches a saved value', async () => {
		const sessionId = await openSession();
		const p = await photo();
		const block = await openPhotoBlock(db, alice, sessionId, p.id);
		const [first] = await setsOf(block.id);
		await db
			.update(s.sets)
			.set({ executedLoad: 45, executedReps: 10, executedRir: 2, notes: 'seat 4' })
			.where(eq(s.sets.id, first.id));
		const before = await setsOf(block.id);

		const result = await identifySessionExercise(db, alice, sessionId, block.id, {
			modelId: ilRow.id,
			exerciseName: '',
			loadConvention: ''
		});
		expect(result?.merged).toBe(false);
		expect(result?.occurrence).toMatchObject({
			exerciseName: 'Iso-Lateral Row',
			equipmentType: 'machine-plate',
			loadConvention: workoutUi.photoConvention['machine-plate'],
			modelName: 'Hammer Strength Iso-Lateral Row'
		});
		const [machine] = await db
			.select()
			.from(s.gymEquipment)
			.where(eq(s.gymEquipment.id, block.gymEquipmentId!));
		expect(machine).toMatchObject({ equipmentModelId: ilRow.id, equipmentType: 'machine-plate' });

		const after = await setsOf(block.id);
		const values = (r: (typeof after)[number]) => ({
			id: r.id,
			executedLoad: r.executedLoad,
			executedReps: r.executedReps,
			executedRir: r.executedRir,
			notes: r.notes,
			prescribedLoad: r.prescribedLoad,
			prescribedRepsMin: r.prescribedRepsMin,
			prescribedRepsMax: r.prescribedRepsMax,
			prescribedRir: r.prescribedRir
		});
		expect(after.map(values)).toEqual(before.map(values));
		expect(after.every((r) => r.exerciseId === result!.occurrence.exerciseId)).toBe(true);
		const [confirmed] = await db
			.select()
			.from(s.equipmentPhotos)
			.where(eq(s.equipmentPhotos.id, p.id));
		expect(confirmed).toMatchObject({
			status: 'confirmed',
			matchedModelId: ilRow.id,
			gymEquipmentId: machine.id
		});
	});

	it('merges into the machine the gym already has: every set and every photo kept, placeholder gone, last time prefilled', async () => {
		// Last visit: the gym's own IL-ROW, a set of 90 x 10 on "Row".
		const existing = await createMachine(db, alice, {
			gymId,
			equipmentType: 'machine-plate',
			equipmentModelId: ilRow.id
		});
		const lastTime = await openSession();
		const row = await addSessionExercise(db, alice, lastTime, {
			exerciseName: 'Row',
			equipmentType: 'machine-plate',
			gymId,
			gymEquipmentId: existing.id,
			loadConvention: 'plates_per_side',
			setCount: 1,
			repsMin: 8,
			repsMax: 12,
			rir: 2,
			tier: 'secondary',
			progressionPolicy: 'standard'
		});
		await db
			.update(s.sets)
			.set({ executedLoad: 90, executedReps: 10, executedRir: 2 })
			.where(eq(s.sets.sessionExerciseId, row.id));
		await endSession(db, alice, lastTime);

		// Today: a photo of the same machine, identified before anything is logged.
		const today = await openSession();
		const p = await photo();
		const block = await openPhotoBlock(db, alice, today, p.id);
		const placeholderId = block.gymEquipmentId!;
		const result = await identifySessionExercise(db, alice, today, block.id, {
			modelId: ilRow.id,
			exerciseName: 'Row',
			loadConvention: 'plates_per_side'
		});
		expect(result?.merged).toBe(true);
		expect(result?.machineId).toBe(existing.id);
		const after = await setsOf(block.id);
		expect(after).toHaveLength(workoutUi.photoBlockSets);
		expect(after.every((r) => r.gymEquipmentId === existing.id)).toBe(true);
		expect(after[0].prescribedLoad, 'last time’s numbers').toBe(90);
		const [moved] = await db.select().from(s.equipmentPhotos).where(eq(s.equipmentPhotos.id, p.id));
		expect(moved.gymEquipmentId).toBe(existing.id);
		expect(moved.sessionExerciseId).toBe(block.id);
		expect(
			await db.select().from(s.gymEquipment).where(eq(s.gymEquipment.id, placeholderId))
		).toEqual([]);
	});

	it('names it later: works on a finished workout', async () => {
		const sessionId = await openSession();
		const block = await openPhotoBlock(db, alice, sessionId, (await photo()).id);
		await endSession(db, alice, sessionId);
		const result = await identifySessionExercise(db, alice, sessionId, block.id, {
			modelId: ilRow.id
		});
		expect(result?.occurrence.exerciseName).toBe('Iso-Lateral Row');
	});

	it('reuses an exercise the user already has on that model', async () => {
		const sessionId = await openSession();
		const existing = await createMachine(db, alice, {
			gymId,
			equipmentType: 'machine-plate',
			equipmentModelId: ilRow.id
		});
		await addSessionExercise(db, alice, sessionId, {
			exerciseName: 'Chest-supported row',
			equipmentType: 'machine-plate',
			gymId,
			gymEquipmentId: existing.id,
			loadConvention: 'plates_per_side',
			setCount: 1,
			repsMin: 8,
			repsMax: 12,
			rir: 2,
			tier: 'secondary',
			progressionPolicy: 'standard'
		});
		const block = await openPhotoBlock(db, alice, sessionId, (await photo()).id);
		const result = await identifySessionExercise(db, alice, sessionId, block.id, {
			modelId: ilRow.id
		});
		expect(result?.occurrence.exerciseName).toBe('Chest-supported row');
	});

	it('touches only photo blocks: a block added by hand is refused, and so is another user', async () => {
		const sessionId = await openSession();
		const block = await openPhotoBlock(db, alice, sessionId, (await photo()).id);
		const machine = await createMachine(db, alice, {
			gymId,
			localLabel: 'Bench',
			equipmentType: 'barbell'
		});
		const byHand = await addSessionExercise(db, alice, sessionId, {
			exerciseName: 'Bench',
			equipmentType: 'barbell',
			gymId,
			gymEquipmentId: machine.id,
			loadConvention: 'displayed',
			setCount: 1,
			repsMin: 5,
			repsMax: 5,
			rir: 1,
			tier: 'main',
			progressionPolicy: 'standard'
		});
		expect(
			await identifySessionExercise(db, alice, sessionId, byHand.id, { modelId: ilRow.id })
		).toBeNull();
		expect(
			await identifySessionExercise(db, bob, sessionId, block.id, { modelId: ilRow.id })
		).toBeNull();
		const [still] = await db
			.select()
			.from(s.sessionExercises)
			.where(eq(s.sessionExercises.id, block.id));
		expect(still.exerciseName).toBe(workoutUi.placeholderExerciseName);
		// Positive: the owner can.
		expect(
			await identifySessionExercise(db, alice, sessionId, block.id, { modelId: ilRow.id })
		).toBeTruthy();
	});
});

describe('photoBlocksForSession and machinesToName', () => {
	it('reading, matched and unmatched blocks, and the count to name, for the owner only', async () => {
		const sessionId = await openSession();
		const reading = await openPhotoBlock(db, alice, sessionId, (await photo()).id);
		const matchedPhoto = await photo(alice, gymId, 'analyzed');
		const matched = await openPhotoBlock(db, alice, sessionId, matchedPhoto.id);
		const unmatchedPhoto = await photo(alice, gymId, 'analyzed');
		await db
			.update(s.equipmentPhotos)
			.set({ candidate: { ...FIXTURE_CANDIDATE, model_code: 'NOPE-1', name: 'Nothing like it' } })
			.where(eq(s.equipmentPhotos.id, unmatchedPhoto.id));
		const unmatched = await openPhotoBlock(db, alice, sessionId, unmatchedPhoto.id);

		const blocks = await photoBlocksForSession(db, alice, sessionId);
		expect(blocks[reading.id]?.kind).toBe('reading');
		expect(blocks[matched.id]).toMatchObject({
			kind: 'match',
			modelId: ilRow.id,
			exerciseName: 'Iso-Lateral Row'
		});
		expect(blocks[unmatched.id]?.kind).toBe('none');
		expect(await machinesToName(db, alice)).toEqual({ count: 3, latestSessionId: sessionId });
		expect(await photoBlocksForSession(db, bob, sessionId)).toEqual({});
		expect(await machinesToName(db, bob)).toEqual({ count: 0, latestSessionId: null });

		await identifySessionExercise(db, alice, sessionId, matched.id, { modelId: ilRow.id });
		expect((await machinesToName(db, alice)).count).toBe(2);
		expect((await photoBlocksForSession(db, alice, sessionId))[matched.id]).toBeUndefined();
	});
});

describe('photoTimeLabel', () => {
	it('takes the phone’s plain local time, else falls back to UTC', () => {
		expect(photoTimeLabel('2:32 PM')).toBe('2:32 PM');
		expect(photoTimeLabel('14:05')).toBe('14:05');
		const noon = new Date(Date.UTC(2026, 9, 2, 12, 5));
		expect(photoTimeLabel('<script>', noon)).toBe('12:05 PM');
		expect(photoTimeLabel(undefined, noon)).toBe('12:05 PM');
	});
});

describe('repeat visits and undo (0.6.1)', () => {
	/** Last visit: the gym's own IL-ROW, "Row", plates per side, 3 sets of 90 x 10. */
	async function lastVisit() {
		const machine = await createMachine(db, alice, {
			gymId,
			equipmentType: 'machine-plate',
			equipmentModelId: ilRow.id
		});
		const sessionId = await openSession();
		const row = await addSessionExercise(db, alice, sessionId, {
			exerciseName: 'Row',
			equipmentType: 'machine-plate',
			gymId,
			gymEquipmentId: machine.id,
			loadConvention: 'plates_per_side',
			setCount: 3,
			repsMin: 8,
			repsMax: 12,
			rir: 2,
			tier: 'secondary',
			progressionPolicy: 'standard'
		});
		await db
			.update(s.sets)
			.set({ executedLoad: 90, executedReps: 10, executedRir: 2 })
			.where(eq(s.sets.sessionExerciseId, row.id));
		await endSession(db, alice, sessionId);
		return machine;
	}

	/** Today: a photo of it opens a block; set 1 is logged before the read returns. */
	async function today(candidate = FIXTURE_CANDIDATE) {
		const sessionId = await openSession();
		const p = await photo(alice, gymId, 'analyzed');
		await db.update(s.equipmentPhotos).set({ candidate }).where(eq(s.equipmentPhotos.id, p.id));
		const block = await openPhotoBlock(db, alice, sessionId, p.id);
		const [first] = await setsOf(block.id);
		await db
			.update(s.sets)
			.set({ executedLoad: 80, executedReps: 8 })
			.where(eq(s.sets.id, first.id));
		return { sessionId, photoId: p.id, block };
	}

	it('names itself: last exercise and weight format, the same machine, last time’s numbers in untouched sets only', async () => {
		const machine = await lastVisit();
		const { sessionId, photoId, block } = await today();
		const named = await autoIdentifyRepeatVisit(db, alice, sessionId, photoId);
		expect(named).toMatchObject({
			exerciseName: 'Row',
			loadConvention: 'plates_per_side',
			gymEquipmentId: machine.id
		});
		const [first, second, third] = await setsOf(block.id);
		// The set logged before the read keeps everything, its target included.
		expect(first).toMatchObject({ executedLoad: 80, executedReps: 8, prescribedLoad: null });
		// Untouched sets get last time's numbers, with their reasoning.
		expect(second.prescribedLoad).not.toBeNull();
		expect(third.prescribedLoad).not.toBeNull();
		expect(second.suggestionReasoning).toBeTruthy();
		expect((await namedPhotoBlocks(db, alice, sessionId))[block.id]).toMatchObject({ photoId });
		expect(await namedPhotoBlocks(db, bob, sessionId)).toEqual({});
	});

	it('does not name itself without a logged visit, on a non-exact code, or when the names disagree', async () => {
		// A machine of that model, on a finished workout, but no set ever logged.
		const unused = await createMachine(db, alice, {
			gymId,
			equipmentType: 'machine-plate',
			equipmentModelId: ilRow.id
		});
		const empty = await openSession();
		await addSessionExercise(db, alice, empty, {
			exerciseName: 'Seated row',
			equipmentType: 'machine-plate',
			gymId,
			gymEquipmentId: unused.id,
			loadConvention: 'plates_per_side',
			setCount: 2,
			repsMin: 8,
			repsMax: 12,
			rir: 2,
			tier: 'secondary',
			progressionPolicy: 'standard'
		});
		await endSession(db, alice, empty);
		const first = await today();
		expect(await autoIdentifyRepeatVisit(db, alice, first.sessionId, first.photoId)).toBeNull();
		await endSession(db, alice, first.sessionId);

		await lastVisit();
		const prefix = await today({ ...FIXTURE_CANDIDATE, model_code: 'IL-RO' });
		expect(await autoIdentifyRepeatVisit(db, alice, prefix.sessionId, prefix.photoId)).toBeNull();
		await endSession(db, alice, prefix.sessionId);
		const guard = await today({ ...FIXTURE_CANDIDATE, name: 'Leg Curl' });
		expect(await autoIdentifyRepeatVisit(db, alice, guard.sessionId, guard.photoId)).toBeNull();
		const [still] = await db
			.select()
			.from(s.sessionExercises)
			.where(eq(s.sessionExercises.id, guard.block.id));
		expect(still.exerciseName).toBe(workoutUi.placeholderExerciseName);
	});

	it('undo puts the block back: saved values kept, prefill cleared, the match offered again, no machine deleted', async () => {
		const machine = await lastVisit();
		const { sessionId, photoId, block } = await today();
		await autoIdentifyRepeatVisit(db, alice, sessionId, photoId);

		// Another user cannot undo it; nothing changes.
		expect(await undoPhotoIdentify(db, bob, sessionId, block.id)).toBeNull();
		expect((await namedPhotoBlocks(db, alice, sessionId))[block.id]).toBeTruthy();

		const reverted = await undoPhotoIdentify(db, alice, sessionId, block.id, {
			timeLabel: '6:05 PM'
		});
		expect(reverted).toMatchObject({
			exerciseName: workoutUi.placeholderExerciseName,
			machineLabel: workoutUi.photoMachineLabel('6:05 PM'),
			loadConvention: 'unknown',
			modelName: null
		});
		expect(reverted!.gymEquipmentId).not.toBe(machine.id);
		const [first, second] = await setsOf(block.id);
		expect(first).toMatchObject({ executedLoad: 80, executedReps: 8 });
		expect(second.prescribedLoad).toBeNull();
		expect((await photoBlocksForSession(db, alice, sessionId))[block.id]).toMatchObject({
			kind: 'match',
			photoId
		});
		expect(
			await db.select().from(s.gymEquipment).where(eq(s.gymEquipment.id, machine.id))
		).toHaveLength(1);
	});

	it('undo is refused on a finished workout and on a block added by hand', async () => {
		await lastVisit();
		const { sessionId, photoId, block } = await today();
		await autoIdentifyRepeatVisit(db, alice, sessionId, photoId);
		await endSession(db, alice, sessionId);
		expect(await undoPhotoIdentify(db, alice, sessionId, block.id)).toBeNull();
	});
});
