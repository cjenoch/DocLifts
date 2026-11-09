/**
 * Server guards for controls the workout page hides (plan 2026-11-08, Phase 2):
 * a photo block cannot be swapped or have its machine changed (2a), and a free
 * weight has no machine to bind (2b). Each refusal happens under the session
 * lock, before any write, so the block and its sets are exactly as they were.
 *
 * Owner review P2 (2026-11-08): a placeholder block whose photo was discarded
 * is no longer a photo block, for the page and the server alike, so Swap and
 * Change machine work on it and its "Photo" placeholder machine goes.
 *
 * Discard leaves the photo's object `delete_pending` until it is erased.
 * 0022's write fence refused any UPDATE of that photo row (23514), including
 * the ON DELETE SET NULL Postgres runs when the block is deleted; since 0024 it
 * lets a pending photo lose its links (`session_exercise_id` and
 * `gym_equipment_id` to null) and nothing else. The photos here carry their
 * `photo_objects` row as the upload route leaves it, so Discard really leaves
 * them pending: swap, remove and permanent delete succeed, and the placeholder
 * goes at swap or remove time. The one leftover: a photo erased while its block
 * is still on the placeholder (see the last describe).
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
	PHOTO_BLOCK_REFUSAL,
	updateMachine
} from './machines';
import { mergeMachines, mergePreview, undoMerge } from './machine-admin';
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
import { erasePhotoObject, requestPhotoDeletion, runDeletion } from './privacy/lifecycle';
import type { Ledger } from './privacy/ledger';
import { startQuickSession } from './quick-workouts';
import { endSession, hardDeleteSession, softDeleteEndedSession } from './sessions';

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

/**
 * A stored photo at the gym, as the upload route leaves it: the row and its
 * `photo_objects` inventory row in state `stored`. Without the inventory row
 * Discard has nothing to mark `delete_pending`, and the write fence that broke
 * the swap in CI never fires.
 */
async function photo(userId: string, gymId: string) {
	const id = randomUUID();
	const storageKey = `users/${userId}/equipment-photos/${id}.jpg`;
	const [row] = await db
		.insert(s.equipmentPhotos)
		.values({
			id,
			userId,
			gymId,
			storageKey,
			contentType: 'image/jpeg',
			bytes: 1000,
			width: 1200,
			height: 1600,
			sha256: 'x'.repeat(64),
			status: 'uploaded'
		})
		.returning();
	await db.insert(s.photoObjects).values({ storageKey, userId, photoId: id, state: 'stored' });
	return row;
}

/** The photo's object state, or undefined once erased. */
async function objectState(photoId: string) {
	const [row] = await db
		.select({ state: s.photoObjects.state })
		.from(s.photoObjects)
		.where(eq(s.photoObjects.photoId, photoId));
	return row?.state;
}

/** A journal that acknowledges every append, as the broker does. */
const ledger: Ledger = { append: async () => {} };

/** The retention sweep's erasure of one discarded photo (removal not enabled). */
async function erase(userId: string, p: { storageKey: string }) {
	return erasePhotoObject(db, userId, p.storageKey, new MemoryPhotoStore(), false, ledger);
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
	it('page data and server guards agree; swap then works, and the placeholder goes when the photo is erased', async () => {
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
		expect(await objectState(goneP.id)).toBe('delete_pending');

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
		// 0024: the pending photo is unlinked and the placeholder goes at swap time.
		expect(await objectState(goneP.id)).toBe('delete_pending');
		expect(await machineRow(placeholderId)).toBeUndefined();
		expect(await photoRow(goneP.id)).toMatchObject({
			status: 'discarded',
			gymEquipmentId: null,
			sessionExerciseId: orphan.id
		});
		expect(await erase(userId, goneP)).toBe(true);
		expect(await photoRow(goneP.id)).toBeUndefined();

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

	it('with a logged set, swap is still refused for logged sets and the placeholder stays as history', async () => {
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
	});

	// Removing the block sets the pending photo's session_exercise_id to null
	// (ON DELETE SET NULL), which is an UPDATE of that photo row; 0022's write
	// fence refused it (23514). 0024 allows exactly that unlink.
	it('Remove after Discard, while the photo is still pending erasure, succeeds and drops the placeholder', async () => {
		const { userId, gymId, sessionId } = await setup('p2-remove-pending');
		const p = await photo(userId, gymId);
		const block = await openPhotoBlock(db, userId, sessionId, p.id);
		const placeholderId = block.gymEquipmentId!;
		expect(await discardPhoto(db, userId, p.id, new MemoryPhotoStore())).toBe(true);
		expect(await objectState(p.id)).toBe('delete_pending');
		const [first] = (await snapshot(block.id)).rows;
		await db
			.update(s.sets)
			.set({ executedLoad: 50, executedReps: 10 })
			.where(eq(s.sets.id, first.id));

		const removed = await removeSessionExercise(db, userId, sessionId, {
			occurrenceId: block.id,
			loggedCount: 1
		});
		expect(removed.removedLogged).toBe(1);
		expect((await snapshot(block.id)).block).toBeUndefined();
		// Both links cleared on the still-pending photo, and the placeholder gone now.
		expect(await objectState(p.id)).toBe('delete_pending');
		expect(await photoRow(p.id)).toMatchObject({
			status: 'discarded',
			sessionExerciseId: null,
			gymEquipmentId: null
		});
		expect(await machineRow(placeholderId)).toBeUndefined();
		expect(await erase(userId, p)).toBe(true);
		expect(await photoRow(p.id)).toBeUndefined();
	});

	it('permanently deleting a trashed workout whose block holds a photo pending removal succeeds and unlinks the photo', async () => {
		const { userId, gymId, sessionId } = await setup('p2-hard-delete-pending');
		const p = await photo(userId, gymId);
		const block = await openPhotoBlock(db, userId, sessionId, p.id);
		expect(await discardPhoto(db, userId, p.id, new MemoryPhotoStore())).toBe(true);
		expect(await objectState(p.id)).toBe('delete_pending');
		expect((await endSession(db, userId, sessionId)).updated).toBe(true);
		expect(await softDeleteEndedSession(db, userId, sessionId)).toEqual({ ok: true });

		// sessions -> CASCADE session_exercises -> SET NULL on the pending photo.
		expect(await hardDeleteSession(db, userId, sessionId)).toEqual({ ok: true });
		const [gone] = await db.select().from(s.sessions).where(eq(s.sessions.id, sessionId));
		expect(gone).toBeUndefined();
		expect((await snapshot(block.id)).block).toBeUndefined();
		expect(await photoRow(p.id)).toMatchObject({ status: 'discarded', sessionExerciseId: null });
		expect(await objectState(p.id)).toBe('delete_pending');
	});
});

describe('0024 write fence on a photo pending removal', () => {
	/** The SQLSTATE and message of a refused write, or 'ok'. */
	async function outcome(write: Promise<unknown>) {
		try {
			await write;
			return 'ok';
		} catch (err) {
			const cause = (err as { cause?: { code?: string; message?: string } }).cause;
			return `${cause?.code}: ${cause?.message}`;
		}
	}
	const PENDING = '23514: Photo removal pending';

	/** A pending (discarded) photo linked to a block and its placeholder, plus another block and machine. */
	async function pendingPhoto(label: string) {
		const { userId, gymId, sessionId } = await setup(label);
		const p = await photo(userId, gymId);
		const block = await openPhotoBlock(db, userId, sessionId, p.id);
		const other = await openPhotoBlock(db, userId, sessionId, (await photo(userId, gymId)).id);
		expect(await discardPhoto(db, userId, p.id, new MemoryPhotoStore())).toBe(true);
		expect(await objectState(p.id)).toBe('delete_pending');
		return { userId, p, block, other };
	}
	const update = (id: string, set: Partial<typeof s.equipmentPhotos.$inferInsert>) =>
		db.update(s.equipmentPhotos).set(set).where(eq(s.equipmentPhotos.id, id));

	it('allows only the links going to null; refuses status, candidate and re-pointing a link', async () => {
		const { p, block, other } = await pendingPhoto('fence-0024');
		const before = await photoRow(p.id);
		expect(before).toMatchObject({
			sessionExerciseId: block.id,
			gymEquipmentId: block.gymEquipmentId
		});

		// Refused: anything but unlinking, the links included when they move elsewhere.
		expect(await outcome(update(p.id, { status: 'analyzed' }))).toBe(PENDING);
		expect(await outcome(update(p.id, { candidate: { late: 'result' } }))).toBe(PENDING);
		expect(await outcome(update(p.id, { sessionExerciseId: other.id }))).toBe(PENDING);
		expect(await outcome(update(p.id, { gymEquipmentId: other.gymEquipmentId }))).toBe(PENDING);
		expect(await outcome(update(p.id, { gymEquipmentId: null, status: 'confirmed' }))).toBe(
			PENDING
		);
		expect(await photoRow(p.id)).toEqual(before);

		// Positive: unlinking one, then the other, succeeds and changes nothing else.
		expect(await outcome(update(p.id, { gymEquipmentId: null }))).toBe('ok');
		expect(await outcome(update(p.id, { sessionExerciseId: null }))).toBe('ok');
		expect(await photoRow(p.id)).toEqual({
			...before,
			sessionExerciseId: null,
			gymEquipmentId: null
		});
		// Once unlinked, a link cannot come back.
		expect(await outcome(update(p.id, { sessionExerciseId: block.id }))).toBe(PENDING);
	});

	it('still refuses a fenced account (deletion requested), even for the unlinking update', async () => {
		const { userId, p } = await pendingPhoto('fence-0024-account');
		// Positive first: the same account, still active, may unlink.
		expect(await outcome(update(p.id, { sessionExerciseId: null }))).toBe('ok');
		await db
			.update(s.authUsers)
			.set({ deletionRequestedAt: new Date() })
			.where(eq(s.authUsers.id, userId));
		expect(await outcome(update(p.id, { gymEquipmentId: null }))).toBe(
			'23514: Account unavailable'
		);
		expect((await photoRow(p.id)).gymEquipmentId).not.toBeNull();
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

		// Positive first: binding the orphan block away succeeds, and the placeholder
		// openPhotoBlock made for it goes with it (0024: the pending photo is unlinked).
		const onFinish = await bindSessionMachine(
			db,
			userId,
			sessionId,
			block.id,
			changeTo(gymId, finish.id)
		);
		expect(onFinish.gymEquipmentId).toBe(finish.id);
		expect(await machineRow(placeholderId)).toBeUndefined();
		expect(await erase(userId, p)).toBe(true);

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

describe('Discard, then swap: the write fence never fails the edit, and erasure removes the placeholder (CI 42536152112)', () => {
	it('removal enabled (requestPhotoDeletion), erasure pending: swap succeeds, then runDeletion removes the placeholder', async () => {
		const { userId, gymId, sessionId } = await setup('p2-request-pending');
		const [pulldown] = await db
			.insert(s.exercises)
			.values({ name: 'Lat pulldown', equipmentType: 'machine-stack', userId })
			.returning();
		const p = await photo(userId, gymId);
		const block = await openPhotoBlock(db, userId, sessionId, p.id);
		const placeholderId = block.gymEquipmentId!;
		const job = await requestPhotoDeletion(db, userId, p.id, ledger);
		expect(job).not.toBeNull();
		expect(await objectState(p.id)).toBe('delete_pending');
		expect(await isPhotoBlock(db, userId, block.id)).toBe(false);

		// The review page's runDeletion did not finish (storage failure): the
		// photo row stays, pending. Swap must still succeed.
		const swapped = await swapSessionExercise(db, userId, sessionId, {
			occurrenceId: block.id,
			exerciseId: pulldown.id
		});
		expect(swapped).toMatchObject({ exerciseId: pulldown.id, gymEquipmentId: null });
		expect((await snapshot(block.id)).block).toMatchObject({
			exerciseId: pulldown.id,
			gymEquipmentId: null
		});
		// 0024: the pending photo is unlinked, so the placeholder goes with the swap.
		expect(await machineRow(placeholderId)).toBeUndefined();
		expect((await photoRow(p.id)).gymEquipmentId).toBeNull();

		expect((await runDeletion(db, userId, job!.id, new MemoryPhotoStore(), ledger, 1)).state).toBe(
			'completed'
		);
		expect(await photoRow(p.id)).toBeUndefined();
	});

	it('erased while the block is still on the placeholder: kept (referenced), and the later swap finds no evidence and keeps it', async () => {
		const { userId, gymId, sessionId } = await setup('p2-erased-first');
		const [pulldown] = await db
			.insert(s.exercises)
			.values({ name: 'Lat pulldown', equipmentType: 'machine-stack', userId })
			.returning();
		const p = await photo(userId, gymId);
		const block = await openPhotoBlock(db, userId, sessionId, p.id);
		const placeholderId = block.gymEquipmentId!;
		// The review page with removal enabled: request, then run at once.
		const job = await requestPhotoDeletion(db, userId, p.id, ledger);
		expect((await runDeletion(db, userId, job!.id, new MemoryPhotoStore(), ledger, 1)).state).toBe(
			'completed'
		);
		expect(await photoRow(p.id)).toBeUndefined();
		expect(await machineRow(placeholderId)).toBeDefined();

		const swapped = await swapSessionExercise(db, userId, sessionId, {
			occurrenceId: block.id,
			exerciseId: pulldown.id
		});
		expect(swapped.exerciseId).toBe(pulldown.id);
		expect(await machineRow(placeholderId)).toBeDefined();
	});

	it("erasure deletes an evidence photo's placeholder, never a machine a confirmed photo points at", async () => {
		const { userId, gymId, sessionId } = await setup('p2-confirmed');
		// Positive first: a discarded evidence photo's unused placeholder goes.
		const p = await photo(userId, gymId);
		const block = await openPhotoBlock(db, userId, sessionId, p.id);
		const placeholderId = block.gymEquipmentId!;
		const job = await requestPhotoDeletion(db, userId, p.id, ledger);
		// Since 0024 the swap-time cleanup removes the placeholder itself; erasure is
		// the backstop for one it kept (locked, or still referenced then). Leave the
		// machine directly, so the photo still points at an unused placeholder.
		await db
			.update(s.sets)
			.set({ gymEquipmentId: null })
			.where(eq(s.sets.sessionExerciseId, block.id));
		await db
			.update(s.sessionExercises)
			.set({ gymEquipmentId: null })
			.where(eq(s.sessionExercises.id, block.id));
		expect((await photoRow(p.id)).gymEquipmentId).toBe(placeholderId);
		expect((await runDeletion(db, userId, job!.id, new MemoryPhotoStore(), ledger, 1)).state).toBe(
			'completed'
		);
		expect(await machineRow(placeholderId)).toBeUndefined();

		// A confirmed photo on a machine of the very same shape (no model, the
		// placeholder type, nothing else pointing at it): removal keeps it.
		const named = await createMachine(db, userId, {
			gymId,
			localLabel: 'Press by the door',
			equipmentType: 'machine-stack'
		});
		const c = await photo(userId, gymId);
		await db
			.update(s.equipmentPhotos)
			.set({ status: 'confirmed', gymEquipmentId: named.id })
			.where(eq(s.equipmentPhotos.id, c.id));
		const removal = await requestPhotoDeletion(db, userId, c.id, ledger);
		expect(
			(await runDeletion(db, userId, removal!.id, new MemoryPhotoStore(), ledger, 1)).state
		).toBe('completed');
		expect(await photoRow(c.id)).toBeUndefined();
		expect(await machineRow(named.id)).toBeDefined();
	});

	it('removing a confirmed photo drops its machine link at once; an unconfirmed one keeps its evidence', async () => {
		const { userId, gymId, sessionId } = await setup('p2-confirmed-link');
		// Positive first: a workout photo's placeholder evidence survives the request.
		const p = await photo(userId, gymId);
		const block = await openPhotoBlock(db, userId, sessionId, p.id);
		await requestPhotoDeletion(db, userId, p.id, ledger);
		expect((await photoRow(p.id)).gymEquipmentId).toBe(block.gymEquipmentId);
		// A confirmed photo: the link goes in the same step that hides it.
		const named = await createMachine(db, userId, {
			gymId,
			localLabel: 'Row by the window',
			equipmentType: 'machine-stack'
		});
		const c = await photo(userId, gymId);
		await db
			.update(s.equipmentPhotos)
			.set({ status: 'confirmed', gymEquipmentId: named.id })
			.where(eq(s.equipmentPhotos.id, c.id));
		await requestPhotoDeletion(db, userId, c.id, ledger);
		expect(await photoRow(c.id)).toMatchObject({ status: 'discarded', gymEquipmentId: null });
		expect(await machineRow(named.id)).toBeDefined();
	});
});

/**
 * Owner review P2 (2026-11-08, at d4ac8af): the cleanup deleted a placeholder
 * the owner had made his own. The photo link proves the app created it; it
 * does not prove nobody edited it since. `untouchedPhotoPlaceholder` is the
 * rule, read on the row locked for the delete: label still the generated
 * "Photo <time>", no stack, no increment, no model, the placeholder type.
 */
describe('a placeholder the owner customized is never deleted (owner review P2, d4ac8af)', () => {
	/** The owner's repro: a photo block whose machine he renamed and set up on the machine page. */
	async function customized(userId: string, gymId: string, sessionId: string) {
		const p = await photo(userId, gymId);
		const block = await openPhotoBlock(db, userId, sessionId, p.id);
		const machineId = block.gymEquipmentId!;
		const edited = await updateMachine(db, userId, gymId, machineId, {
			localLabel: 'West stack',
			stackLb: 200,
			incrementLb: 10
		});
		expect(edited).toMatchObject({ localLabel: 'West stack', stackLb: 200, incrementLb: 10 });
		return { p, block, machineId };
	}
	const westStack = {
		localLabel: 'West stack',
		stackLb: 200,
		incrementLb: 10,
		equipmentModelId: null,
		archivedAt: null,
		mergedIntoId: null
	};

	it('Remove: the untouched placeholder goes, the renamed one with stack 200 and increment 10 stays', async () => {
		const { userId, gymId, sessionId } = await setup('p2-custom-remove');
		// Positive first: an untouched placeholder still goes with its block.
		const plain = await photo(userId, gymId);
		const plainBlock = await openPhotoBlock(db, userId, sessionId, plain.id);
		expect(await discardPhoto(db, userId, plain.id, new MemoryPhotoStore())).toBe(true);
		await removeSessionExercise(db, userId, sessionId, { occurrenceId: plainBlock.id });
		expect(await machineRow(plainBlock.gymEquipmentId!)).toBeUndefined();

		const { p, block, machineId } = await customized(userId, gymId, sessionId);
		expect(await discardPhoto(db, userId, p.id, new MemoryPhotoStore())).toBe(true);
		await removeSessionExercise(db, userId, sessionId, { occurrenceId: block.id });
		expect((await snapshot(block.id)).block).toBeUndefined();
		expect(await machineRow(machineId)).toMatchObject(westStack);
		// The pending photo is not unlinked by a cleanup that did not run.
		expect(await photoRow(p.id)).toMatchObject({ status: 'discarded', gymEquipmentId: machineId });
	});

	it('Swap and Change machine keep a customized placeholder', async () => {
		const { userId, gymId, sessionId } = await setup('p2-custom-swap-bind');
		const [pulldown] = await db
			.insert(s.exercises)
			.values({ name: 'Lat pulldown', equipmentType: 'machine-stack', userId })
			.returning();
		const door = await createMachine(db, userId, {
			gymId,
			localLabel: 'Press by the door',
			equipmentType: 'machine-stack'
		});
		// Positive first: an untouched one goes on bind.
		const plain = await photo(userId, gymId);
		const plainBlock = await openPhotoBlock(db, userId, sessionId, plain.id);
		expect(await discardPhoto(db, userId, plain.id, new MemoryPhotoStore())).toBe(true);
		await bindSessionMachine(db, userId, sessionId, plainBlock.id, changeTo(gymId, door.id));
		expect(await machineRow(plainBlock.gymEquipmentId!)).toBeUndefined();

		const swapCase = await customized(userId, gymId, sessionId);
		expect(await discardPhoto(db, userId, swapCase.p.id, new MemoryPhotoStore())).toBe(true);
		const swapped = await swapSessionExercise(db, userId, sessionId, {
			occurrenceId: swapCase.block.id,
			exerciseId: pulldown.id
		});
		expect(swapped).toMatchObject({ exerciseId: pulldown.id, gymEquipmentId: null });
		expect(await machineRow(swapCase.machineId)).toMatchObject(westStack);

		const bindCase = await customized(userId, gymId, sessionId);
		expect(await discardPhoto(db, userId, bindCase.p.id, new MemoryPhotoStore())).toBe(true);
		const bound = await bindSessionMachine(
			db,
			userId,
			sessionId,
			bindCase.block.id,
			changeTo(gymId, door.id)
		);
		expect(bound.gymEquipmentId).toBe(door.id);
		expect(await machineRow(bindCase.machineId)).toMatchObject(westStack);
	});

	it.each([
		['the label alone', { localLabel: 'West stack' }],
		['the stack alone', { stackLb: 200 }],
		['the increment alone', { incrementLb: 10 }]
	])('each editable column counts: %s keeps it', async (_, edit) => {
		const { userId, gymId, sessionId } = await setup('p2-custom-one-column');
		const p = await photo(userId, gymId);
		const block = await openPhotoBlock(db, userId, sessionId, p.id);
		const machineId = block.gymEquipmentId!;
		const label = (await machineRow(machineId)).localLabel;
		// updateMachine sets all three; the ones not edited keep their insert value.
		await updateMachine(db, userId, gymId, machineId, { localLabel: label, ...edit });
		expect(await discardPhoto(db, userId, p.id, new MemoryPhotoStore())).toBe(true);
		await removeSessionExercise(db, userId, sessionId, { occurrenceId: block.id });
		expect(await machineRow(machineId)).toMatchObject(edit);
	});

	it('erasure keeps a customized placeholder, and still removes an untouched one', async () => {
		const { userId, gymId, sessionId } = await setup('p2-custom-erase');
		/** Leave the machine directly, as when the swap-time cleanup kept it, so erasure decides. */
		async function leaveMachine(blockId: string) {
			await db
				.update(s.sets)
				.set({ gymEquipmentId: null })
				.where(eq(s.sets.sessionExerciseId, blockId));
			await db
				.update(s.sessionExercises)
				.set({ gymEquipmentId: null })
				.where(eq(s.sessionExercises.id, blockId));
		}
		// Positive first: the untouched placeholder goes with its erased photo.
		const plain = await photo(userId, gymId);
		const plainBlock = await openPhotoBlock(db, userId, sessionId, plain.id);
		const plainJob = await requestPhotoDeletion(db, userId, plain.id, ledger);
		await leaveMachine(plainBlock.id);
		expect(
			(await runDeletion(db, userId, plainJob!.id, new MemoryPhotoStore(), ledger, 1)).state
		).toBe('completed');
		expect(await machineRow(plainBlock.gymEquipmentId!)).toBeUndefined();

		const { p, block, machineId } = await customized(userId, gymId, sessionId);
		const job = await requestPhotoDeletion(db, userId, p.id, ledger);
		await leaveMachine(block.id);
		expect((await photoRow(p.id)).gymEquipmentId).toBe(machineId);
		expect((await runDeletion(db, userId, job!.id, new MemoryPhotoStore(), ledger, 1)).state).toBe(
			'completed'
		);
		expect(await photoRow(p.id)).toBeUndefined();
		expect(await machineRow(machineId)).toMatchObject(westStack);
	});
});

/**
 * Owner review P2 (2026-11-08, at d4ac8af): Merge and Undo answered 500 when a
 * photo on the machine was pending removal, because they re-pointed it and
 * 0024's fence lets such a photo lose its link and nothing else. Now a pending
 * photo is unlinked (null), never moved, and left out of the merge's `moved`
 * list (`relinkMachinePhotos`). Everything else moves as before.
 */
describe('Merge and Undo with a photo pending removal (owner review P2, d4ac8af)', () => {
	/** A finished workout with one logged set on a photo block's placeholder, and another stack machine. */
	async function finishedPhotoBlock(label: string) {
		const { userId, gymId, sessionId } = await setup(label);
		const p = await photo(userId, gymId);
		const block = await openPhotoBlock(db, userId, sessionId, p.id);
		const placeholderId = block.gymEquipmentId!;
		const [first] = (await snapshot(block.id)).rows;
		await db
			.update(s.sets)
			.set({ executedLoad: 50, executedReps: 10 })
			.where(eq(s.sets.id, first.id));
		expect((await endSession(db, userId, sessionId)).updated).toBe(true);
		const other = await createMachine(db, userId, {
			gymId,
			localLabel: 'Press by the door',
			equipmentType: 'machine-stack'
		});
		const setIds = (await snapshot(block.id)).rows.map((r) => r.id).sort();
		return { userId, gymId, p, block, placeholderId, other, setIds };
	}
	/** Where the block and its sets point now. */
	async function machinesOf(blockId: string) {
		const { block, rows } = await snapshot(blockId);
		return { block: block.gymEquipmentId, sets: [...new Set(rows.map((r) => r.gymEquipmentId))] };
	}

	it('discard, then merge, then undo: both commit, the pending photo is unlinked and never moved', async () => {
		const f = await finishedPhotoBlock('p2-merge-pending');
		// Positive first: before Discard the preview counts the photo it would move.
		expect(await mergePreview(db, f.userId, f.gymId, f.other.id, f.placeholderId)).toMatchObject({
			sets: f.setIds.length,
			workouts: 1,
			photos: 1
		});
		expect(await discardPhoto(db, f.userId, f.p.id, new MemoryPhotoStore())).toBe(true);
		expect(await objectState(f.p.id)).toBe('delete_pending');
		// The preview stays truthful: the pending photo will not move.
		expect(await mergePreview(db, f.userId, f.gymId, f.other.id, f.placeholderId)).toMatchObject({
			sets: f.setIds.length,
			photos: 0
		});

		const merge = await mergeMachines(db, f.userId, f.gymId, {
			keptId: f.other.id,
			droppedId: f.placeholderId
		});
		expect(merge).not.toBeNull();
		expect({ ...merge!.moved, sets: [...merge!.moved.sets].sort() }).toEqual({
			sets: f.setIds,
			sessionExercises: [f.block.id],
			photos: []
		});
		expect(await machinesOf(f.block.id)).toEqual({ block: f.other.id, sets: [f.other.id] });
		expect(await machineRow(f.placeholderId)).toMatchObject({ mergedIntoId: f.other.id });
		expect(await photoRow(f.p.id)).toMatchObject({ status: 'discarded', gymEquipmentId: null });
		expect(await objectState(f.p.id)).toBe('delete_pending');

		const undone = await undoMerge(db, f.userId, merge!.id);
		expect(undone?.undoneAt).toBeInstanceOf(Date);
		expect(await machinesOf(f.block.id)).toEqual({
			block: f.placeholderId,
			sets: [f.placeholderId]
		});
		expect(await machineRow(f.placeholderId)).toMatchObject({
			archivedAt: null,
			mergedIntoId: null
		});
		expect(await photoRow(f.p.id)).toMatchObject({ status: 'discarded', gymEquipmentId: null });
	});

	it('merge, then discard, then undo: undo commits and unlinks the photo instead of moving it back', async () => {
		const f = await finishedPhotoBlock('p2-undo-pending');
		const merge = await mergeMachines(db, f.userId, f.gymId, {
			keptId: f.other.id,
			droppedId: f.placeholderId
		});
		// Positive first: a photo not pending moves, and is listed for undo.
		expect(merge!.moved.photos).toEqual([f.p.id]);
		expect((await photoRow(f.p.id)).gymEquipmentId).toBe(f.other.id);

		expect(await discardPhoto(db, f.userId, f.p.id, new MemoryPhotoStore())).toBe(true);
		expect(await objectState(f.p.id)).toBe('delete_pending');
		const undone = await undoMerge(db, f.userId, merge!.id);
		expect(undone?.undoneAt).toBeInstanceOf(Date);
		const [row] = await db.select().from(s.machineMerges).where(eq(s.machineMerges.id, merge!.id));
		expect(row.undoneAt).not.toBeNull();
		expect(await machinesOf(f.block.id)).toEqual({
			block: f.placeholderId,
			sets: [f.placeholderId]
		});
		expect(await machineRow(f.placeholderId)).toMatchObject({
			archivedAt: null,
			mergedIntoId: null
		});
		expect(await photoRow(f.p.id)).toMatchObject({ status: 'discarded', gymEquipmentId: null });
		expect(await objectState(f.p.id)).toBe('delete_pending');
	});

	it('naming a photo block into an existing machine unlinks a pending photo on its placeholder, and commits', async () => {
		const { userId, gymId, sessionId } = await setup('p2-identify-pending');
		const [model] = await db
			.insert(s.equipmentModels)
			.values({
				manufacturer: 'Life Fitness',
				name: 'Chest Press',
				loadingType: 'machine-stack',
				confidence: 'user',
				ownerUserId: userId
			})
			.returning();
		const existing = await createMachine(db, userId, {
			gymId,
			equipmentType: 'machine-stack',
			equipmentModelId: model.id
		});
		// Two photo blocks on two placeholders in a finished workout; the first
		// placeholder is merged into the second, so its photo now points there.
		const p1 = await photo(userId, gymId);
		const b1 = await openPhotoBlock(db, userId, sessionId, p1.id);
		const p2 = await photo(userId, gymId);
		const b2 = await openPhotoBlock(db, userId, sessionId, p2.id);
		expect((await endSession(db, userId, sessionId)).updated).toBe(true);
		const merge = await mergeMachines(db, userId, gymId, {
			keptId: b2.gymEquipmentId!,
			droppedId: b1.gymEquipmentId!
		});
		expect(merge!.moved.photos).toEqual([p1.id]);
		// Then the first photo is discarded: pending, still on the second placeholder.
		expect(await discardPhoto(db, userId, p1.id, new MemoryPhotoStore())).toBe(true);
		expect(await photoRow(p1.id)).toMatchObject({ gymEquipmentId: b2.gymEquipmentId });

		const named = await identifySessionExercise(db, userId, sessionId, b2.id, {
			modelId: model.id,
			exerciseName: 'Chest press'
		});
		expect(named).toMatchObject({ machineId: existing.id, merged: true });
		expect((await snapshot(b2.id)).block.gymEquipmentId).toBe(existing.id);
		expect(await photoRow(p2.id)).toMatchObject({
			status: 'confirmed',
			gymEquipmentId: existing.id
		});
		expect(await photoRow(p1.id)).toMatchObject({ status: 'discarded', gymEquipmentId: null });
		// The second placeholder still holds the first block and the merge record: kept.
		expect(await machineRow(b2.gymEquipmentId!)).toBeDefined();
		expect((await snapshot(b1.id)).block.gymEquipmentId).toBe(b2.gymEquipmentId);
	});
});

describe('naming a photo into an existing machine keeps a placeholder the owner set up (owner review, 2026-11-08)', () => {
	it('drops an untouched placeholder, but keeps "West stack" with its settings', async () => {
		const { userId, gymId, sessionId } = await setup('p2-identify-west');
		const [model] = await db
			.insert(s.equipmentModels)
			.values({
				manufacturer: 'Life Fitness',
				name: 'Chest Press',
				loadingType: 'machine-stack',
				confidence: 'user',
				ownerUserId: userId
			})
			.returning();
		const existing = await createMachine(db, userId, {
			gymId,
			equipmentType: 'machine-stack',
			equipmentModelId: model.id
		});
		// Positive first: an untouched placeholder goes when its block joins the machine.
		const p1 = await photo(userId, gymId);
		const b1 = await openPhotoBlock(db, userId, sessionId, p1.id);
		expect(
			await identifySessionExercise(db, userId, sessionId, b1.id, {
				modelId: model.id,
				exerciseName: 'Chest press'
			})
		).toMatchObject({ machineId: existing.id, merged: true });
		expect(await machineRow(b1.gymEquipmentId!)).toBeUndefined();

		// The owner's repro: rename the placeholder and set it up, then name the photo.
		const p2 = await photo(userId, gymId);
		const b2 = await openPhotoBlock(db, userId, sessionId, p2.id);
		await db
			.update(s.gymEquipment)
			.set({ localLabel: 'West stack', stackLb: 200, incrementLb: 10 })
			.where(eq(s.gymEquipment.id, b2.gymEquipmentId!));
		expect(
			await identifySessionExercise(db, userId, sessionId, b2.id, {
				modelId: model.id,
				exerciseName: 'Chest press'
			})
		).toMatchObject({ machineId: existing.id, merged: true });
		expect((await snapshot(b2.id)).block.gymEquipmentId).toBe(existing.id);
		expect(await machineRow(b2.gymEquipmentId!)).toMatchObject({
			localLabel: 'West stack',
			stackLb: 200,
			incrementLb: 10,
			archivedAt: null
		});
	});
});
