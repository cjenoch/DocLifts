/**
 * Server guards for controls the workout page hides (plan 2026-11-08, Phase 2):
 * a photo block cannot be swapped or have its machine changed (2a), and a free
 * weight has no machine to bind (2b). Each refusal happens under the session
 * lock, before any write, so the block and its sets are exactly as they were.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { createTestUser, resetTestDb, setupTestDb, type TestDb } from './test-db';
import * as s from './db/schema';
import {
	addSessionExercise,
	bindSessionMachine,
	createGym,
	createMachine,
	FREE_WEIGHT_BIND_REFUSAL,
	MachineInputError,
	PHOTO_BLOCK_REFUSAL
} from './machines';
import { swapSessionExercise, WorkoutEditError } from './live-edit';
import { openPhotoBlock, PLACEHOLDER_MOVEMENT } from './photo-workout';
import { startQuickSession } from './quick-workouts';

let db: TestDb;
let handle: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
	handle = await setupTestDb();
	db = handle.db;
});
afterAll(async () => {
	await handle?.end();
});
beforeEach(async () => {
	await resetTestDb(handle.client);
});

/** A fresh user with an open quick workout at their own gym. One per test. */
async function setup(label: string) {
	const userId = await createTestUser(db, label);
	const gym = await createGym(db, userId, { name: 'Corner gym' });
	const started = await startQuickSession(db, userId, gym.id);
	if (!started.ok) throw new Error(started.message);
	return { userId, gymId: gym.id, sessionId: started.sessionId };
}

/** A stored photo at the gym, as the upload route leaves it. */
async function photo(userId: string, gymId: string) {
	const id = randomUUID();
	const [row] = await db
		.insert(s.equipmentPhotos)
		.values({
			id,
			userId,
			gymId,
			storageKey: `users/${userId}/equipment-photos/${id}.jpg`,
			contentType: 'image/jpeg',
			bytes: 1000,
			width: 1200,
			height: 1600,
			sha256: 'x'.repeat(64),
			status: 'uploaded'
		})
		.returning();
	return row;
}

/** The block and its sets, to compare before and after a refused call. */
async function snapshot(occurrenceId: string) {
	const [block] = await db
		.select()
		.from(s.sessionExercises)
		.where(eq(s.sessionExercises.id, occurrenceId));
	const rows = await db
		.select()
		.from(s.sets)
		.where(eq(s.sets.sessionExerciseId, occurrenceId))
		.orderBy(asc(s.sets.position));
	return { block, rows };
}

const stackBlock = (exerciseName: string, gymId: string, machineName: string) => ({
	exerciseName,
	equipmentType: 'machine-stack',
	gymId,
	newMachineName: machineName,
	loadConvention: 'displayed',
	setCount: 2,
	repsMin: 8,
	repsMax: 12,
	rir: 2,
	tier: 'secondary',
	progressionPolicy: 'standard'
});

describe('a photo block is named from its photo, never swapped or rebound (2a)', () => {
	it('refuses swapSessionExercise and bindSessionMachine on a photo block, and writes nothing', async () => {
		const { userId, gymId, sessionId } = await setup('guard-photo');
		// Positive first: on an ordinary block in the same workout both work.
		const ordinary = await addSessionExercise(
			db,
			userId,
			sessionId,
			stackBlock('Chest press', gymId, 'Press by the window')
		);
		const otherStack = await createMachine(db, userId, {
			gymId,
			localLabel: 'Press by the door',
			equipmentType: 'machine-stack'
		});
		const rebound = await bindSessionMachine(db, userId, sessionId, ordinary.id, {
			gymId,
			gymEquipmentId: otherStack.id,
			loadConvention: 'displayed',
			confirm: 'CHANGE'
		});
		expect(rebound.gymEquipmentId).toBe(otherStack.id);
		const [pulldown] = await db
			.insert(s.exercises)
			.values({ name: 'Lat pulldown', equipmentType: 'machine-stack', userId })
			.returning();
		const swapped = await swapSessionExercise(db, userId, sessionId, {
			occurrenceId: ordinary.id,
			exerciseId: pulldown.id
		});
		expect(swapped.exerciseId).toBe(pulldown.id);

		// The photo block: on the placeholder exercise, nothing logged.
		const block = await openPhotoBlock(db, userId, sessionId, (await photo(userId, gymId)).id);
		const [placeholder] = await db
			.select()
			.from(s.exercises)
			.where(eq(s.exercises.id, block.exerciseId));
		expect(placeholder.canonicalMovement).toBe(PLACEHOLDER_MOVEMENT);
		expect(block.equipmentType).toBe(otherStack.equipmentType);
		const before = await snapshot(block.id);

		const swap = swapSessionExercise(db, userId, sessionId, {
			occurrenceId: block.id,
			exerciseId: pulldown.id
		});
		await expect(swap).rejects.toThrow(WorkoutEditError);
		await expect(swap).rejects.toThrow(PHOTO_BLOCK_REFUSAL);
		expect(await snapshot(block.id)).toEqual(before);

		const bind = bindSessionMachine(db, userId, sessionId, block.id, {
			gymId,
			gymEquipmentId: otherStack.id,
			loadConvention: 'displayed',
			confirm: 'CHANGE'
		});
		await expect(bind).rejects.toThrow(MachineInputError);
		await expect(bind).rejects.toThrow(PHOTO_BLOCK_REFUSAL);
		expect(await snapshot(block.id)).toEqual(before);
		expect(before.block.gymEquipmentId).not.toBe(otherStack.id);
	});
});

describe('a free weight has no machine to bind (2b)', () => {
	it('refuses bindSessionMachine on a barbell block, even to a barbell machine row, and writes nothing', async () => {
		const { userId, gymId, sessionId } = await setup('guard-free');
		// Positive first: a machine block binds to a machine of its type.
		const ordinary = await addSessionExercise(
			db,
			userId,
			sessionId,
			stackBlock('Leg extension', gymId, 'Extension by the wall')
		);
		const otherStack = await createMachine(db, userId, {
			gymId,
			localLabel: 'Extension by the mirror',
			equipmentType: 'machine-stack'
		});
		expect(
			(
				await bindSessionMachine(db, userId, sessionId, ordinary.id, {
					gymId,
					gymEquipmentId: otherStack.id,
					loadConvention: 'displayed',
					confirm: 'CHANGE'
				})
			).gymEquipmentId
		).toBe(otherStack.id);

		// A free-weight block (0.8.0: no gym equipment), and a machine row of
		// the same type, which the schema permits.
		const squat = await addSessionExercise(db, userId, sessionId, {
			exerciseName: 'Back squat',
			equipmentType: 'barbell',
			loadConvention: 'total_plates',
			setCount: 2,
			repsMin: 5,
			repsMax: 5,
			rir: 2,
			tier: 'main',
			progressionPolicy: 'standard',
			isLowerBody: '1'
		});
		expect(squat.gymEquipmentId).toBeNull();
		const rack = await createMachine(db, userId, {
			gymId,
			localLabel: 'Rack 2',
			equipmentType: 'barbell'
		});
		const before = await snapshot(squat.id);

		const bind = bindSessionMachine(db, userId, sessionId, squat.id, {
			gymId,
			gymEquipmentId: rack.id,
			loadConvention: 'total_plates',
			confirm: 'CHANGE'
		});
		await expect(bind).rejects.toThrow(MachineInputError);
		await expect(bind).rejects.toThrow(FREE_WEIGHT_BIND_REFUSAL);
		expect(await snapshot(squat.id)).toEqual(before);
		expect(before.block.gymEquipmentId).toBeNull();
	});
});
