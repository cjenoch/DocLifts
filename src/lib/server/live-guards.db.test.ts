/**
 * Server guards for controls the workout page hides (plan 2026-11-08, Phase 2):
 * a photo block cannot be swapped or have its machine changed (2a), and a free
 * weight has no machine to bind (2b). Each refusal happens under the session
 * lock, before any write, so the block and its sets are exactly as they were.
 *
 * Owner review P2 (2026-11-08): a placeholder block whose photo was discarded
 * is no longer a photo block, for the page and the server alike, so Swap and
 * Change machine work on it and its "Photo" placeholder machine goes.
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
import { removeSessionExercise, swapSessionExercise, WorkoutEditError } from './live-edit';
import {
	identifySessionExercise,
	isPhotoBlock,
	machinesToName,
	openPhotoBlock,
	photoBlocksForSession,
	PLACEHOLDER_MOVEMENT
} from './photo-workout';
import { discardPhoto } from './photos/confirm';
import { MemoryPhotoStore } from './photos/store';
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

/** The machine row by id, or undefined once deleted. */
async function machineRow(id: string) {
	const [row] = await db.select().from(s.gymEquipment).where(eq(s.gymEquipment.id, id));
	return row;
}

describe('a placeholder block whose photo is discarded is an ordinary block (P2)', () => {
	it('page data and server guards agree; swap then works and the placeholder machine goes', async () => {
		const { userId, gymId, sessionId } = await setup('p2-swap');
		const [pulldown] = await db
			.insert(s.exercises)
			.values({ name: 'Lat pulldown', equipmentType: 'machine-stack', userId })
			.returning();
		const livePhoto = await photo(userId, gymId);
		const live = await openPhotoBlock(db, userId, sessionId, livePhoto.id);
		const goneP = await photo(userId, gymId);
		const orphan = await openPhotoBlock(db, userId, sessionId, goneP.id);
		const placeholderId = orphan.gymEquipmentId!;

		// Positive first: both are photo blocks, on the page and on the server.
		expect(Object.keys(await photoBlocksForSession(db, userId, sessionId)).sort()).toEqual(
			[live.id, orphan.id].sort()
		);
		expect(await isPhotoBlock(db, userId, orphan.id)).toBe(true);
		await expect(
			swapSessionExercise(db, userId, sessionId, {
				occurrenceId: orphan.id,
				exerciseId: pulldown.id
			})
		).rejects.toThrow(PHOTO_BLOCK_REFUSAL);

		// "Discard this photo" on the review page (deletion not enabled).
		expect(await discardPhoto(db, userId, goneP.id, new MemoryPhotoStore())).toBe(true);

		// One rule: the page drops the block, the server stops refusing it, Home stops counting it.
		const blocks = await photoBlocksForSession(db, userId, sessionId);
		expect(Object.keys(blocks)).toEqual([live.id]);
		expect(await isPhotoBlock(db, userId, orphan.id)).toBe(false);
		expect(await isPhotoBlock(db, userId, live.id)).toBe(true);
		expect((await machinesToName(db, userId)).count).toBe(1);
		// Nothing names it from a discarded photo, and the photo stays discarded.
		expect(
			await identifySessionExercise(db, userId, sessionId, orphan.id, { modelId: randomUUID() })
		).toBeNull();
		const [still] = await db
			.select()
			.from(s.equipmentPhotos)
			.where(eq(s.equipmentPhotos.id, goneP.id));
		expect(still.status).toBe('discarded');

		const swapped = await swapSessionExercise(db, userId, sessionId, {
			occurrenceId: orphan.id,
			exerciseId: pulldown.id
		});
		expect(swapped.exerciseId).toBe(pulldown.id);
		expect(swapped.gymEquipmentId).toBeNull();
		const after = await snapshot(orphan.id);
		expect(after.rows.every((r) => r.exerciseId === pulldown.id && r.gymEquipmentId === null)).toBe(
			true
		);
		expect(await machineRow(placeholderId)).toBeUndefined();

		// The block with a live photo is still refused, and keeps its placeholder.
		const stack = await createMachine(db, userId, {
			gymId,
			localLabel: 'Pulldown by the door',
			equipmentType: 'machine-stack'
		});
		const before = await snapshot(live.id);
		await expect(
			swapSessionExercise(db, userId, sessionId, { occurrenceId: live.id, exerciseId: pulldown.id })
		).rejects.toThrow(PHOTO_BLOCK_REFUSAL);
		await expect(
			bindSessionMachine(db, userId, sessionId, live.id, {
				gymId,
				gymEquipmentId: stack.id,
				loadConvention: 'displayed',
				confirm: 'CHANGE'
			})
		).rejects.toThrow(PHOTO_BLOCK_REFUSAL);
		expect(await snapshot(live.id)).toEqual(before);
		expect(await machineRow(live.gymEquipmentId!)).toBeDefined();
	});

	it('change machine works on it under bind rules, also when the photo row is erased; then its placeholder stays', async () => {
		const { userId, gymId, sessionId } = await setup('p2-bind');
		const stack = await createMachine(db, userId, {
			gymId,
			localLabel: 'Extension by the mirror',
			equipmentType: 'machine-stack'
		});
		const p = await photo(userId, gymId);
		const block = await openPhotoBlock(db, userId, sessionId, p.id);
		const placeholderId = block.gymEquipmentId!;
		// Positive first: refused while the photo is there.
		await expect(
			bindSessionMachine(db, userId, sessionId, block.id, {
				gymId,
				gymEquipmentId: stack.id,
				loadConvention: 'displayed',
				confirm: 'CHANGE'
			})
		).rejects.toThrow(PHOTO_BLOCK_REFUSAL);
		// Erased, as the privacy path leaves it after the object is gone.
		await db.delete(s.equipmentPhotos).where(eq(s.equipmentPhotos.id, p.id));

		const bound = await bindSessionMachine(db, userId, sessionId, block.id, {
			gymId,
			gymEquipmentId: stack.id,
			loadConvention: 'displayed',
			confirm: 'CHANGE'
		});
		expect(bound.gymEquipmentId).toBe(stack.id);
		// The erased row was the only evidence the app made that machine for this
		// block, so it is kept; the user can remove it from the gym page.
		expect(await machineRow(placeholderId)).toBeDefined();
		// The machine it moved to is the user's own: changing again keeps it.
		const other = await createMachine(db, userId, {
			gymId,
			localLabel: 'Extension by the door',
			equipmentType: 'machine-stack'
		});
		await bindSessionMachine(db, userId, sessionId, block.id, {
			gymId,
			gymEquipmentId: other.id,
			loadConvention: 'displayed',
			confirm: 'CHANGE'
		});
		expect(await machineRow(stack.id)).toBeDefined();
	});

	it('with a logged set, swap is still refused for logged sets and the placeholder stays as history; remove drops it', async () => {
		const { userId, gymId, sessionId } = await setup('p2-touched');
		const [pulldown] = await db
			.insert(s.exercises)
			.values({ name: 'Lat pulldown', equipmentType: 'machine-stack', userId })
			.returning();
		const p = await photo(userId, gymId);
		const block = await openPhotoBlock(db, userId, sessionId, p.id);
		const placeholderId = block.gymEquipmentId!;
		expect(await discardPhoto(db, userId, p.id, new MemoryPhotoStore())).toBe(true);
		const [first] = (await snapshot(block.id)).rows;
		await db
			.update(s.sets)
			.set({ executedLoad: 50, executedReps: 10 })
			.where(eq(s.sets.id, first.id));

		await expect(
			swapSessionExercise(db, userId, sessionId, {
				occurrenceId: block.id,
				exerciseId: pulldown.id
			})
		).rejects.toThrow('This exercise has logged sets');
		expect(await machineRow(placeholderId)).toBeDefined();

		const removed = await removeSessionExercise(db, userId, sessionId, {
			occurrenceId: block.id,
			loggedCount: 1
		});
		expect(removed.removedLogged).toBe(1);
		expect(await machineRow(placeholderId)).toBeUndefined();
	});
});

/** The photo row by id. */
async function photoRow(id: string) {
	const [row] = await db.select().from(s.equipmentPhotos).where(eq(s.equipmentPhotos.id, id));
	return row;
}

const changeTo = (gymId: string, gymEquipmentId: string) => ({
	gymId,
	gymEquipmentId,
	loadConvention: 'displayed',
	confirm: 'CHANGE'
});

describe('the placeholder cleanup needs evidence, and never fails the edit (owner review P2)', () => {
	it('a machine the user named "Photo Finish" is never deleted; only the placeholder made for the block is', async () => {
		const { userId, gymId, sessionId } = await setup('p2-photo-finish');
		const finish = await createMachine(db, userId, {
			gymId,
			localLabel: 'Photo Finish',
			equipmentType: 'machine-stack',
			incrementLb: 10
		});
		const door = await createMachine(db, userId, {
			gymId,
			localLabel: 'Press by the door',
			equipmentType: 'machine-stack'
		});
		const p = await photo(userId, gymId);
		const block = await openPhotoBlock(db, userId, sessionId, p.id);
		const placeholderId = block.gymEquipmentId!;
		expect((await photoRow(p.id)).gymEquipmentId).toBe(placeholderId);
		expect(await discardPhoto(db, userId, p.id, new MemoryPhotoStore())).toBe(true);

		// Positive first: binding the orphan block away drops the placeholder
		// openPhotoBlock made for it, and unlinks the discarded photo from it.
		const onFinish = await bindSessionMachine(
			db,
			userId,
			sessionId,
			block.id,
			changeTo(gymId, finish.id)
		);
		expect(onFinish.gymEquipmentId).toBe(finish.id);
		expect(await machineRow(placeholderId)).toBeUndefined();
		expect((await photoRow(p.id)).gymEquipmentId).toBeNull();

		// The block is still on the placeholder exercise and its label starts
		// "Photo ", but nothing says the app made Photo Finish for it: kept.
		const onDoor = await bindSessionMachine(
			db,
			userId,
			sessionId,
			block.id,
			changeTo(gymId, door.id)
		);
		expect(onDoor.gymEquipmentId).toBe(door.id);
		expect(await machineRow(finish.id)).toMatchObject({
			localLabel: 'Photo Finish',
			equipmentType: 'machine-stack',
			incrementLb: 10,
			archivedAt: null
		});
	});

	it('a reference another transaction has not committed keeps the placeholder, and the rebind still succeeds without waiting', async () => {
		const { userId, gymId, sessionId } = await setup('p2-concurrent');
		const target = await createMachine(db, userId, {
			gymId,
			localLabel: 'Press by the window',
			equipmentType: 'machine-stack'
		});
		const p = await photo(userId, gymId);
		const block = await openPhotoBlock(db, userId, sessionId, p.id);
		const placeholderId = block.gymEquipmentId!;
		expect(await discardPhoto(db, userId, p.id, new MemoryPhotoStore())).toBe(true);

		// Connection A: a photo confirmed onto the placeholder (as linkPhoto
		// writes it), held uncommitted. Its FK check holds FOR KEY SHARE on the
		// machine row until A ends.
		const claimId = randomUUID();
		let releaseA!: () => void;
		const gateA = new Promise<void>((resolve) => (releaseA = resolve));
		let claimedA!: () => void;
		const claimed = new Promise<void>((resolve) => (claimedA = resolve));
		const txA = db.transaction(async (tx) => {
			await tx.insert(s.equipmentPhotos).values({
				id: claimId,
				userId,
				gymId,
				storageKey: `users/${userId}/equipment-photos/${claimId}.jpg`,
				contentType: 'image/jpeg',
				bytes: 1000,
				width: 1200,
				height: 1600,
				sha256: 'y'.repeat(64),
				status: 'confirmed',
				gymEquipmentId: placeholderId
			});
			claimedA();
			await gateA;
		});
		// If A fails before signalling, unblock the wait below instead of hanging.
		txA.catch(() => claimedA());

		let bindB: Promise<unknown> | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await claimed;
			// Connection B: rebind the block off the placeholder, raced against a
			// timer while A is still open. A cleanup that waits on A loses.
			bindB = bindSessionMachine(db, userId, sessionId, block.id, changeTo(gymId, target.id)).then(
				(value) => ({ value }),
				(error: unknown) => ({ error })
			);
			const waited = new Promise<'waited for A'>((resolve) => {
				timer = setTimeout(() => resolve('waited for A'), 1500);
			});
			const outcome = await Promise.race([bindB, waited]);
			expect(outcome).toMatchObject({ value: { id: block.id, gymEquipmentId: target.id } });
		} finally {
			if (timer) clearTimeout(timer);
			releaseA();
			await txA.catch(() => undefined);
			await bindB;
		}

		// A committed, nothing failed: its photo points at the kept placeholder,
		// and B's rebind persisted.
		expect(await machineRow(placeholderId)).toBeDefined();
		expect((await photoRow(claimId)).gymEquipmentId).toBe(placeholderId);
		const after = await snapshot(block.id);
		expect(after.block.gymEquipmentId).toBe(target.id);
		expect(after.rows.every((r) => r.gymEquipmentId === target.id)).toBe(true);
	});
});
