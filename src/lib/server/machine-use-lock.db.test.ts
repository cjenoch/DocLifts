/**
 * The machine-use lock (owner review P2, 2026-11-08, at d4ac8af):
 * `lockMachineForUse` in machines.ts, taken by every path that attaches a
 * machine to a workout (add, change machine, naming a photo block into an
 * existing machine, appending a copied set).
 *
 * The race it closes: an archive (`archiveLegacyPhotoPlaceholders`,
 * `removeMachine`, `mergeMachines`) locks the machine `FOR UPDATE`, checks that
 * no open workout uses it, and archives it. An attach that only READ the
 * machine saw it before that archive committed, and the block's foreign key
 * waits only for the row to exist, so both succeeded and an open workout
 * pointed at an archived machine. With `FOR SHARE` the attach waits, re-reads
 * the archived row and refuses; an archive that comes second skips the row
 * (SKIP LOCKED) or sees the new block.
 *
 * Two connections per test: the holder is a real archive run inside a
 * transaction kept open (its own transaction becomes a savepoint, so its locks
 * last until the holder ends). Every wait is bounded and every holder is
 * released in `finally`.
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
	lockMachineForUse,
	MACHINE_NOT_FOUND
} from './machines';
import {
	archiveLegacyPhotoPlaceholders,
	FINISH_WORKOUT_FIRST,
	legacyPhotoPlaceholders,
	mergeMachines,
	removeMachine
} from './machine-admin';
import { identifySessionExercise, openPhotoBlock } from './photo-workout';
import { appendWorkoutSet } from './workout-sets';
import { startQuickSession } from './quick-workouts';
import type { Database } from './progression';

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

/** A machine exactly as a legacy photo placeholder: unused, "Photo <time>", nothing set. */
const legacyPlaceholder = (userId: string, gymId: string) =>
	createMachine(db, userId, {
		gymId,
		localLabel: 'Photo 2:32 PM',
		equipmentType: 'machine-stack'
	});

const stackBlock = (gymId: string, gymEquipmentId: string, exerciseName = 'Chest press') => ({
	exerciseName,
	equipmentType: 'machine-stack',
	gymId,
	gymEquipmentId,
	loadConvention: 'displayed',
	setCount: 2,
	repsMin: 8,
	repsMax: 12,
	rir: 2,
	tier: 'secondary',
	progressionPolicy: 'standard'
});

/**
 * Run `work` in a transaction on its own connection and keep it open until
 * `release()`. `held` resolves once `work` is done (or failed: `done` rejects).
 */
function hold<T>(work: (tx: Database) => Promise<T>) {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => (release = resolve));
	let ready!: () => void;
	const held = new Promise<void>((resolve) => (ready = resolve));
	let result: T | undefined;
	const done = db.transaction(async (tx) => {
		result = await work(tx as unknown as Database);
		ready();
		await gate;
		return result;
	});
	done.catch(() => ready());
	return { held, release, done, result: () => result };
}

/** The outcome of `p` if it settles within `ms`, else 'still waiting'. */
async function within<T>(p: Promise<T>, ms: number) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const settled = p.then(
		(value) => ({ value }),
		(error: unknown) => ({ error })
	);
	try {
		return await Promise.race([
			settled,
			new Promise<'still waiting'>((resolve) => {
				timer = setTimeout(() => resolve('still waiting'), ms);
			})
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** The session's blocks and sets, to show a refused attach wrote nothing. */
async function workout(sessionId: string) {
	const blocks = await db
		.select()
		.from(s.sessionExercises)
		.where(eq(s.sessionExercises.sessionId, sessionId))
		.orderBy(asc(s.sessionExercises.position));
	const rows = await db
		.select()
		.from(s.sets)
		.where(eq(s.sets.sessionId, sessionId))
		.orderBy(asc(s.sets.id));
	return { blocks, rows };
}

const machineRow = async (id: string) =>
	(await db.select().from(s.gymEquipment).where(eq(s.gymEquipment.id, id)))[0];

/**
 * The archive holds its lock past its rechecks; the attach must wait, then
 * refuse on the archived row, and leave the workout as it was.
 */
async function attachWaitsThenRefuses(opts: {
	sessionId: string;
	machineId: string;
	archive: (tx: Database) => Promise<unknown>;
	attach: () => Promise<unknown>;
	refusal: string;
}) {
	const before = await workout(opts.sessionId);
	const holder = hold(opts.archive);
	let attach: Promise<unknown> | undefined;
	try {
		await holder.held;
		attach = opts.attach();
		expect(await within(attach, 750)).toBe('still waiting');
	} finally {
		holder.release();
		await holder.done.catch(() => undefined);
	}
	expect(await within(attach!, 5000)).toMatchObject({
		error: expect.objectContaining({ message: opts.refusal })
	});
	expect((await machineRow(opts.machineId))?.archivedAt ?? 'deleted').not.toBeNull();
	expect(await workout(opts.sessionId)).toEqual(before);
}

describe('an attach waits for an archive that holds the machine, then refuses (a)', () => {
	it('add an exercise on a machine the legacy cleanup is archiving', async () => {
		const { userId, gymId, sessionId } = await setup('use-lock-add');
		// Positive first: the same add on another machine of the same shape works.
		const free = await legacyPlaceholder(userId, gymId);
		const added = await addSessionExercise(db, userId, sessionId, {
			...stackBlock(gymId, free.id, 'Row'),
			requestId: randomUUID()
		});
		expect(added.gymEquipmentId).toBe(free.id);

		const m = await legacyPlaceholder(userId, gymId);
		await attachWaitsThenRefuses({
			sessionId,
			machineId: m.id,
			archive: async (tx) =>
				expect(await archiveLegacyPhotoPlaceholders(tx, userId, [m.id])).toEqual({
					archived: [m.id],
					skipped: []
				}),
			attach: () => addSessionExercise(db, userId, sessionId, stackBlock(gymId, m.id)),
			refusal: MACHINE_NOT_FOUND
		});
	});

	it('change machine to one the legacy cleanup is archiving', async () => {
		const { userId, gymId, sessionId } = await setup('use-lock-bind');
		const door = await createMachine(db, userId, {
			gymId,
			localLabel: 'Press by the door',
			equipmentType: 'machine-stack'
		});
		const block = await addSessionExercise(db, userId, sessionId, stackBlock(gymId, door.id));
		const m = await legacyPlaceholder(userId, gymId);
		const change = { gymId, gymEquipmentId: m.id, loadConvention: 'displayed', confirm: 'CHANGE' };
		await attachWaitsThenRefuses({
			sessionId,
			machineId: m.id,
			archive: async (tx) =>
				expect((await archiveLegacyPhotoPlaceholders(tx, userId, [m.id])).archived).toEqual([m.id]),
			attach: () => bindSessionMachine(db, userId, sessionId, block.id, change),
			refusal: MACHINE_NOT_FOUND
		});
		// Positive after: with the archive gone, a live machine still binds.
		const window = await createMachine(db, userId, {
			gymId,
			localLabel: 'Press by the window',
			equipmentType: 'machine-stack'
		});
		const rebound = await bindSessionMachine(db, userId, sessionId, block.id, {
			...change,
			gymEquipmentId: window.id
		});
		expect(rebound.gymEquipmentId).toBe(window.id);
	});

	it('name a photo block into the existing machine that Remove is archiving', async () => {
		const { userId, gymId, sessionId } = await setup('use-lock-identify');
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
		// A confirmed photo points at it, so Remove archives it (history) rather than deleting it.
		const confirmedId = randomUUID();
		await db.insert(s.equipmentPhotos).values({
			id: confirmedId,
			userId,
			gymId,
			storageKey: `users/${userId}/equipment-photos/${confirmedId}.jpg`,
			contentType: 'image/jpeg',
			bytes: 1000,
			width: 1200,
			height: 1600,
			sha256: 'c'.repeat(64),
			status: 'confirmed',
			gymEquipmentId: existing.id
		});
		const photoId = randomUUID();
		await db.insert(s.equipmentPhotos).values({
			id: photoId,
			userId,
			gymId,
			storageKey: `users/${userId}/equipment-photos/${photoId}.jpg`,
			contentType: 'image/jpeg',
			bytes: 1000,
			width: 1200,
			height: 1600,
			sha256: 'x'.repeat(64),
			status: 'uploaded'
		});
		const block = await openPhotoBlock(db, userId, sessionId, photoId);
		await attachWaitsThenRefuses({
			sessionId,
			machineId: existing.id,
			archive: async (tx) =>
				expect(await removeMachine(tx, userId, gymId, existing.id)).toEqual({
					outcome: 'archived'
				}),
			attach: () =>
				identifySessionExercise(db, userId, sessionId, block.id, {
					modelId: model.id,
					exerciseName: 'Chest press'
				}),
			refusal: 'Machine not found'
		});
		const [p] = await db.select().from(s.equipmentPhotos).where(eq(s.equipmentPhotos.id, photoId));
		expect(p).toMatchObject({ status: 'uploaded', gymEquipmentId: block.gymEquipmentId });
	});

	// Every real archive path refuses a machine an open workout already uses, so
	// this holder archives directly, the way those paths write (FOR UPDATE, then
	// archived_at). It shows the copy re-checks under the lock all the same.
	it('append a set copied from a block whose machine is being archived', async () => {
		const { userId, gymId, sessionId } = await setup('use-lock-append');
		const m = await createMachine(db, userId, {
			gymId,
			localLabel: 'Press by the door',
			equipmentType: 'machine-stack'
		});
		const block = await addSessionExercise(db, userId, sessionId, stackBlock(gymId, m.id));
		const [source] = (await workout(sessionId)).rows.filter(
			(r) => r.sessionExerciseId === block.id
		);
		// Positive first: an append copies the machine.
		const appended = await appendWorkoutSet(db, userId, sessionId, {
			sourceSetId: source.id,
			requestId: randomUUID(),
			setRole: 'working'
		});
		expect(appended.gymEquipmentId).toBe(m.id);

		await attachWaitsThenRefuses({
			sessionId,
			machineId: m.id,
			archive: async (tx) => {
				await tx.select().from(s.gymEquipment).where(eq(s.gymEquipment.id, m.id)).for('update');
				await tx
					.update(s.gymEquipment)
					.set({ archivedAt: new Date() })
					.where(eq(s.gymEquipment.id, m.id));
			},
			attach: () =>
				appendWorkoutSet(db, userId, sessionId, {
					sourceSetId: source.id,
					requestId: randomUUID(),
					setRole: 'working'
				}),
			refusal: MACHINE_NOT_FOUND
		});
	});
});

describe('an archive that comes second never archives a machine being attached (b)', () => {
	it('the legacy cleanup skips a machine an attach has locked, without waiting; after the attach commits it is in use and stays', async () => {
		const { userId, gymId, sessionId } = await setup('use-lock-skip');
		const m = await legacyPlaceholder(userId, gymId);
		// Positive first: unlocked, the same machine is a legacy placeholder.
		expect(await legacyPhotoPlaceholders(db, userId)).toMatchObject([{ machineId: m.id }]);

		// The attach, paused right after its machine lock and before its insert:
		// the window in which d4ac8af's plain read let the archive through.
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		let lockedSignal!: () => void;
		const locked = new Promise<void>((resolve) => (lockedSignal = resolve));
		const attach = db.transaction(async (tx) => {
			const row = await lockMachineForUse(tx as unknown as Database, userId, m.id, { gymId });
			expect(row?.machine.id).toBe(m.id);
			lockedSignal();
			await gate;
			return addSessionExercise(
				tx as unknown as Database,
				userId,
				sessionId,
				stackBlock(gymId, m.id)
			);
		});
		attach.catch(() => lockedSignal());
		try {
			await locked;
			expect(await within(archiveLegacyPhotoPlaceholders(db, userId, [m.id]), 1500)).toEqual({
				value: { archived: [], skipped: [{ machineId: m.id, reason: 'locked' }] }
			});
		} finally {
			release();
		}
		const added = await attach;
		expect(added.gymEquipmentId).toBe(m.id);
		expect((await machineRow(m.id)).archivedAt).toBeNull();
		// A later run finds it in use.
		expect(await archiveLegacyPhotoPlaceholders(db, userId, [m.id])).toEqual({
			archived: [],
			skipped: [{ machineId: m.id, reason: 'open-workout' }]
		});
	});

	it.each([
		[
			'Remove',
			(userId: string, gymId: string, machineId: string, otherId: string) =>
				removeMachine(db, userId, gymId, machineId).then(() => otherId)
		],
		[
			'Merge',
			(userId: string, gymId: string, machineId: string, otherId: string) =>
				mergeMachines(db, userId, gymId, { keptId: otherId, droppedId: machineId })
		]
	])(
		'%s waits for an attach that holds the machine, then refuses: the open workout uses it',
		async (_, archive) => {
			const { userId, gymId, sessionId } = await setup('use-lock-remove-merge');
			const m = await createMachine(db, userId, {
				gymId,
				localLabel: 'Press by the door',
				equipmentType: 'machine-stack'
			});
			const other = await createMachine(db, userId, {
				gymId,
				localLabel: 'Press by the window',
				equipmentType: 'machine-stack'
			});
			const holder = hold((tx) =>
				addSessionExercise(tx, userId, sessionId, stackBlock(gymId, m.id))
			);
			let pending: Promise<unknown> | undefined;
			try {
				await holder.held;
				pending = archive(userId, gymId, m.id, other.id);
				expect(await within(pending, 750)).toBe('still waiting');
			} finally {
				holder.release();
				await holder.done.catch(() => undefined);
			}
			expect(await within(pending!, 5000)).toMatchObject({
				error: expect.objectContaining({ message: FINISH_WORKOUT_FIRST })
			});
			expect(await machineRow(m.id)).toMatchObject({ archivedAt: null, mergedIntoId: null });
			expect((await workout(sessionId)).blocks.map((b) => b.gymEquipmentId)).toEqual([m.id]);
		}
	);
});
