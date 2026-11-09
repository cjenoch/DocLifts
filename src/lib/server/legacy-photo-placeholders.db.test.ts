/**
 * The one-time legacy photo-placeholder cleanup (`pnpm photo:placeholders`,
 * `legacyPhotoPlaceholders` / `archiveLegacyPhotoPlaceholders` in
 * machine-admin.ts).
 *
 * A legacy placeholder is made the way production made it: a real
 * `openPhotoBlock`, then the photo's machine link nulled (what openPhotoBlock
 * wrote before c5bb02c), the photo discarded and the block removed. With no
 * link, `dropPhotoPlaceholderMachine` has no evidence and keeps the machine:
 * the row this cleanup exists for.
 *
 * Evidence: `gym_equipment` has no created_at, so "strong" is a photo of the
 * user at that gym, linked to no machine, created 0-2 minutes after the
 * label's minute. A machine that only looks like a placeholder is still
 * listed, as "weak" (label only); the dry run shows which is which.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { setupTestDb, resetTestDbWithUsers, type TestDb } from './test-db';
import * as s from './db/schema';
import {
	archiveLegacyPhotoPlaceholders,
	legacyPhotoPlaceholders,
	restoreMachine
} from './machine-admin';
import { addSessionExercise, createGym, createMachine } from './machines';
import { openPhotoBlock } from './photo-workout';
import { removeSessionExercise } from './live-edit';
import { discardPhoto } from './photos/confirm';
import { MemoryPhotoStore } from './photos/store';
import { startQuickSession } from './quick-workouts';
import { endSession } from './sessions';
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

beforeEach(async () => {
	[{ id: alice }, { id: bob }] = await resetTestDbWithUsers(db, handle.client, 2, 'legacy-photo');
	gymId = (await createGym(db, alice, { name: 'Corner gym' })).id;
});

async function openSession(userId = alice, gym = gymId): Promise<string> {
	const started = await startQuickSession(db, userId, gym);
	if (!started.ok) throw new Error(started.message);
	return started.sessionId;
}

async function photo(userId = alice, gym = gymId, createdAt = new Date()) {
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
			status: 'uploaded',
			createdAt
		})
		.returning();
	return row;
}

/**
 * A placeholder as production left it before c5bb02c: opened by a real
 * openPhotoBlock at "2:32 PM", its photo (created at `photoAt`) not linked to
 * it, the photo discarded, the block removed, the workout finished.
 */
async function legacyPlaceholder(
	opts: { userId?: string; gym?: string; time?: string; photoAt?: Date } = {}
) {
	const userId = opts.userId ?? alice;
	const gym = opts.gym ?? gymId;
	const sessionId = await openSession(userId, gym);
	const p = await photo(userId, gym, opts.photoAt ?? new Date('2026-10-02T19:33:10Z'));
	const block = await openPhotoBlock(db, userId, sessionId, p.id, {
		timeLabel: opts.time ?? '2:32 PM'
	});
	const machineId = block.gymEquipmentId!;
	// Pre-c5bb02c: openPhotoBlock linked the photo to the block only.
	await db
		.update(s.equipmentPhotos)
		.set({ gymEquipmentId: null })
		.where(eq(s.equipmentPhotos.id, p.id));
	expect(await discardPhoto(db, userId, p.id, new MemoryPhotoStore())).toBe(true);
	await removeSessionExercise(db, userId, sessionId, { occurrenceId: block.id });
	await endSession(db, userId, sessionId);
	// No evidence for dropPhotoPlaceholderMachine, so the machine was kept.
	expect(await machineRow(machineId)).toBeDefined();
	return { machineId, photoId: p.id };
}

const machineRow = async (id: string) =>
	(await db.select().from(s.gymEquipment).where(eq(s.gymEquipment.id, id)))[0];

const ids = (rows: { machineId: string }[]) => rows.map((r) => r.machineId).sort();

describe('legacyPhotoPlaceholders and archiveLegacyPhotoPlaceholders', () => {
	it('lists a legacy placeholder with strong evidence, archives it for the owner only, and Restore brings it back', async () => {
		const { machineId, photoId } = await legacyPlaceholder();

		// Positive first: the owner sees it, with the photo that corroborates it.
		const mine = await legacyPhotoPlaceholders(db, alice);
		expect(mine).toEqual([
			{
				machineId,
				gymId,
				gymName: 'Corner gym',
				label: workoutUi.photoMachineLabel('2:32 PM'),
				evidence: {
					kind: 'photo-time',
					photoId,
					photoCreatedAt: new Date('2026-10-02T19:33:10Z')
				}
			}
		]);
		// Another user sees nothing, and cannot archive it (not found, unchanged).
		expect(await legacyPhotoPlaceholders(db, bob)).toEqual([]);
		expect(await archiveLegacyPhotoPlaceholders(db, bob, [machineId])).toEqual({
			archived: [],
			skipped: [{ machineId, reason: 'not-found' }]
		});
		expect((await machineRow(machineId)).archivedAt).toBeNull();

		expect(await archiveLegacyPhotoPlaceholders(db, alice, [machineId])).toEqual({
			archived: [machineId],
			skipped: []
		});
		// Archived, never deleted.
		const archived = await machineRow(machineId);
		expect(archived.archivedAt).toBeInstanceOf(Date);
		expect(archived.mergedIntoId).toBeNull();

		const restored = await restoreMachine(db, alice, gymId, machineId);
		expect(restored?.archivedAt).toBeNull();
		expect((await machineRow(machineId)).archivedAt).toBeNull();
	});

	it('is idempotent: after apply nothing is listed, and a second apply changes nothing', async () => {
		const first = await legacyPlaceholder();
		const second = await legacyPlaceholder({
			time: '6:05 PM',
			photoAt: new Date('2026-10-03T22:06:00Z')
		});
		const listed = ids(await legacyPhotoPlaceholders(db, alice));
		expect(listed).toEqual([first.machineId, second.machineId].sort());

		const applied = await archiveLegacyPhotoPlaceholders(db, alice, listed);
		expect(applied.archived.sort()).toEqual(listed);
		const stamps = await Promise.all(listed.map(async (id) => (await machineRow(id)).archivedAt));

		expect(await legacyPhotoPlaceholders(db, alice)).toEqual([]);
		const again = await archiveLegacyPhotoPlaceholders(db, alice, listed);
		expect(again.archived).toEqual([]);
		expect(again.skipped.map((x) => x.reason)).toEqual(['changed', 'changed']);
		expect(await Promise.all(listed.map(async (id) => (await machineRow(id)).archivedAt))).toEqual(
			stamps
		);
	});

	it('weak path: a machine that only looks like a placeholder is listed as label-only, never as strong', async () => {
		// A legacy placeholder whose photo landed far from the label's minute
		// (or was erased): no corroboration.
		const uncorroborated = await legacyPlaceholder({
			photoAt: new Date('2026-10-02T19:50:00Z')
		});
		// A machine the user typed in with a placeholder-format name, no photo at all.
		const typed = await createMachine(db, alice, {
			gymId,
			localLabel: 'Photo 7:15 PM',
			equipmentType: workoutUi.photoPlaceholderType
		});
		// Not the format: never listed.
		await createMachine(db, alice, {
			gymId,
			localLabel: 'Photo Finish',
			equipmentType: workoutUi.photoPlaceholderType
		});

		const listed = await legacyPhotoPlaceholders(db, alice);
		expect(ids(listed)).toEqual([uncorroborated.machineId, typed.id].sort());
		expect(listed.every((p) => p.evidence.kind === 'label-only')).toBe(true);
	});

	it('leaves out everything that is not an unused legacy placeholder of this user', async () => {
		const legacy = await legacyPlaceholder();

		// Referenced: a placeholder still on its (ended) block.
		const kept = await openSession();
		const keptPhoto = await photo();
		const keptBlock = await openPhotoBlock(db, alice, kept, keptPhoto.id, { timeLabel: '2:40 PM' });
		await db
			.update(s.equipmentPhotos)
			.set({ gymEquipmentId: null })
			.where(eq(s.equipmentPhotos.id, keptPhoto.id));
		await endSession(db, alice, kept);

		// Archived.
		const archived = await legacyPlaceholder({ time: '3:10 PM' });
		await db
			.update(s.gymEquipment)
			.set({ archivedAt: new Date() })
			.where(eq(s.gymEquipment.id, archived.machineId));

		// Modeled, of another type, or with a stack typed in.
		const [stack] = await db
			.insert(s.equipmentModels)
			.values({
				manufacturer: 'Life Fitness',
				code: 'LC-1',
				name: 'Leg Curl',
				loadingType: 'machine-stack',
				confidence: 'manufacturer_page'
			})
			.returning();
		await createMachine(db, alice, {
			gymId,
			localLabel: 'Photo 2:32 PM',
			equipmentType: 'machine-stack',
			equipmentModelId: stack.id
		});
		await createMachine(db, alice, { gymId, localLabel: 'Photo 2:32 PM', equipmentType: 'cable' });
		await createMachine(db, alice, {
			gymId,
			localLabel: 'Photo 2:32 PM',
			equipmentType: 'machine-stack',
			stackLb: 200
		});

		// Another user's legacy placeholder.
		const bobGym = (await createGym(db, bob, { name: 'Bob gym' })).id;
		const bobs = await legacyPlaceholder({ userId: bob, gym: bobGym });

		// On an open workout (last: every other workout above is finished).
		const live = await openSession();
		const liveBlock = await openPhotoBlock(db, alice, live, (await photo()).id, {
			timeLabel: '2:41 PM'
		});

		expect(ids(await legacyPhotoPlaceholders(db, alice))).toEqual([legacy.machineId]);
		expect(ids(await legacyPhotoPlaceholders(db, bob))).toEqual([bobs.machineId]);
		// Sanity: the excluded placeholders are still there, untouched.
		for (const id of [keptBlock.gymEquipmentId!, liveBlock.gymEquipmentId!])
			expect((await machineRow(id)).archivedAt).toBeNull();
	});

	it('re-checks at apply time: a machine that changed since the listing is skipped, with the reason', async () => {
		const referenced = await legacyPlaceholder({
			time: '1:00 PM',
			photoAt: new Date('2026-10-02T18:00:30Z')
		});
		const inWorkout = await legacyPlaceholder({
			time: '1:10 PM',
			photoAt: new Date('2026-10-02T18:10:30Z')
		});
		const renamed = await legacyPlaceholder({
			time: '1:20 PM',
			photoAt: new Date('2026-10-02T18:20:30Z')
		});
		const listed = ids(await legacyPhotoPlaceholders(db, alice));
		expect(listed).toEqual([referenced.machineId, inWorkout.machineId, renamed.machineId].sort());

		// Between the listing and the apply: a photo confirmed onto one, one put
		// on an open workout, one renamed by its owner.
		const claim = await photo();
		await db
			.update(s.equipmentPhotos)
			.set({ status: 'confirmed', gymEquipmentId: referenced.machineId })
			.where(eq(s.equipmentPhotos.id, claim.id));
		const sessionId = await openSession();
		const exercise = (
			await db
				.insert(s.exercises)
				.values({ name: 'Chest press', equipmentType: 'machine-stack', userId: alice })
				.returning()
		)[0];
		await addSessionExercise(db, alice, sessionId, {
			exerciseId: exercise.id,
			equipmentType: 'machine-stack',
			gymId,
			gymEquipmentId: inWorkout.machineId,
			loadConvention: 'displayed',
			setCount: 1,
			repsMin: 8,
			repsMax: 12,
			rir: 2,
			tier: 'secondary',
			progressionPolicy: 'standard'
		});
		await db
			.update(s.gymEquipment)
			.set({ localLabel: 'Chest press by the door' })
			.where(eq(s.gymEquipment.id, renamed.machineId));

		const result = await archiveLegacyPhotoPlaceholders(db, alice, listed);
		expect(result.archived).toEqual([]);
		expect(Object.fromEntries(result.skipped.map((x) => [x.machineId, x.reason]))).toEqual({
			[referenced.machineId]: 'referenced',
			[inWorkout.machineId]: 'open-workout',
			[renamed.machineId]: 'changed'
		});
		for (const id of listed) expect((await machineRow(id)).archivedAt).toBeNull();
	});

	it('skips a machine another transaction holds, without waiting, and archives it on a later run', async () => {
		const { machineId } = await legacyPlaceholder();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		let lockedSignal!: () => void;
		const locked = new Promise<void>((resolve) => (lockedSignal = resolve));
		const holder = db.transaction(async (tx) => {
			await tx.select().from(s.gymEquipment).where(eq(s.gymEquipment.id, machineId)).for('update');
			lockedSignal();
			await gate;
		});
		holder.catch(() => lockedSignal());

		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await locked;
			const waited = new Promise<'waited'>((resolve) => {
				timer = setTimeout(() => resolve('waited'), 1500);
			});
			const outcome = await Promise.race([
				archiveLegacyPhotoPlaceholders(db, alice, [machineId]),
				waited
			]);
			expect(outcome).toEqual({ archived: [], skipped: [{ machineId, reason: 'locked' }] });
		} finally {
			if (timer) clearTimeout(timer);
			release();
			await holder.catch(() => undefined);
		}
		expect((await machineRow(machineId)).archivedAt).toBeNull();
		expect(await archiveLegacyPhotoPlaceholders(db, alice, [machineId])).toEqual({
			archived: [machineId],
			skipped: []
		});
	});
});
