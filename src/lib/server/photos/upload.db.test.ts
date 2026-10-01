/**
 * uploadPhoto / readOwnPhoto (0.4.0 §3) against the test database and the
 * memory store. No network: the store is a Map.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { setupTestDb, resetTestDbWithUsers, type TestDb } from '../test-db';
import * as s from '../db/schema';
import { MemoryPhotoStore, photoKey } from './store';
import {
	PhotoInputError,
	PhotoLimitError,
	readOwnPhoto,
	uploadPhoto,
	uploadsInLastDay
} from './index';
import { phonePhoto, smallPng } from './test-fixtures';

let db: TestDb;
let handle: Awaited<ReturnType<typeof setupTestDb>>;
let alice: string;
let bob: string;
let alicesGym: string;
let store: MemoryPhotoStore;
const limits = { maxBytes: 10 * 1024 * 1024, dailyLimit: 20 };

beforeAll(async () => {
	handle = await setupTestDb();
	db = handle.db;
});
afterAll(async () => {
	await handle?.end();
});
beforeEach(async () => {
	[{ id: alice }, { id: bob }] = await resetTestDbWithUsers(db, handle.client, 2, 'upload');
	[{ id: alicesGym }] = await db
		.insert(s.gyms)
		.values({ name: 'Alice Gym', userId: alice })
		.returning();
	store = new MemoryPhotoStore();
});

const bytesOf = async (r: NodeJS.ReadableStream) => {
	const chunks: Buffer[] = [];
	for await (const c of r) chunks.push(Buffer.from(c as Buffer));
	return Buffer.concat(chunks);
};

/** Seed `n` photo rows for `userId`, created `ageMs` ago. */
async function seedRows(userId: string, gymId: string, n: number, ageMs = 0) {
	for (let i = 0; i < n; i++) {
		await db.insert(s.equipmentPhotos).values({
			userId,
			gymId,
			storageKey: `seed/${crypto.randomUUID()}`,
			contentType: 'image/jpeg',
			bytes: 1,
			width: 1,
			height: 1,
			sha256: '0'.repeat(64),
			status: i % 2 ? 'discarded' : 'uploaded',
			createdAt: new Date(Date.now() - ageMs)
		});
	}
}

describe('uploadPhoto', () => {
	it('stores the processed JPEG under the owner prefix and records it as uploaded', async () => {
		const photo = await uploadPhoto(
			db,
			alice,
			{ gymId: alicesGym, bytes: await phonePhoto(), type: 'image/jpeg', name: 'IMG_0001.JPG' },
			{ store, limits }
		);
		expect(photo).toMatchObject({
			userId: alice,
			gymId: alicesGym,
			status: 'uploaded',
			contentType: 'image/jpeg',
			width: 1200,
			height: 1600,
			llmCallId: null,
			candidate: null
		});
		expect(photo!.storageKey).toBe(photoKey(alice, photo!.id));
		expect(store.keys()).toEqual([photo!.storageKey]);
		const stored = await bytesOf((await store.get(photo!.storageKey))!.body);
		expect(stored.byteLength).toBe(photo!.bytes);
		expect((await sharp(stored).metadata()).exif).toBeUndefined();
	});

	it('returns null for another user’s gym, and stores nothing', async () => {
		const mine = await uploadPhoto(
			db,
			alice,
			{ gymId: alicesGym, bytes: await smallPng() },
			{ store, limits }
		);
		expect(mine).not.toBeNull(); // positive first
		const theirs = await uploadPhoto(
			db,
			bob,
			{ gymId: alicesGym, bytes: await smallPng() },
			{ store, limits }
		);
		expect(theirs).toBeNull();
		expect(
			await db.select().from(s.equipmentPhotos).where(eq(s.equipmentPhotos.userId, bob))
		).toEqual([]);
		expect(store.keys()).toHaveLength(1);
	});

	it('the daily cap: the 20th upload in 24 hours is accepted, the 21st refused', async () => {
		await seedRows(alice, alicesGym, 19);
		await seedRows(alice, alicesGym, 5, 25 * 60 * 60 * 1000); // older than 24 h: not counted
		const twentieth = await uploadPhoto(
			db,
			alice,
			{ gymId: alicesGym, bytes: await smallPng() },
			{ store, limits }
		);
		expect(twentieth?.status).toBe('uploaded');
		expect(await uploadsInLastDay(db, alice)).toBe(20);
		await expect(
			uploadPhoto(db, alice, { gymId: alicesGym, bytes: await smallPng() }, { store, limits })
		).rejects.toThrow(
			new PhotoLimitError(
				'You have uploaded 20 photos in the last 24 hours, the daily limit. Try again later.'
			)
		);
		expect(await uploadsInLastDay(db, alice)).toBe(20);
		expect(store.keys()).toHaveLength(1);
		// Bob's count is his own.
		expect(
			await uploadPhoto(db, bob, { gymId: alicesGym, bytes: await smallPng() }, { store, limits })
		).toBeNull();
	});

	it('PHOTO_DAILY_LIMIT=0 refuses every upload', async () => {
		await expect(
			uploadPhoto(
				db,
				alice,
				{ gymId: alicesGym, bytes: await smallPng() },
				{ store, limits: { ...limits, dailyLimit: 0 } }
			)
		).rejects.toThrow('Photo uploads are switched off.');
	});

	it('a size refusal is a size message, even at the cap, and writes nothing', async () => {
		await seedRows(alice, alicesGym, 20);
		await expect(
			uploadPhoto(
				db,
				alice,
				{ gymId: alicesGym, bytes: Buffer.alloc(11 * 1024 * 1024) },
				{ store, limits }
			)
		).rejects.toBeInstanceOf(PhotoInputError);
		expect(store.keys()).toEqual([]);
	});

	it('deletes the stored object when the insert fails', async () => {
		const failing = new MemoryPhotoStore();
		// A storage key that collides makes the insert fail after the put.
		const realPut = failing.put.bind(failing);
		failing.put = async (key, body, type) => {
			await realPut(key, body, type);
			await seedRowWithKey(key);
		};
		await expect(
			uploadPhoto(
				db,
				alice,
				{ gymId: alicesGym, bytes: await smallPng() },
				{ store: failing, limits }
			)
		).rejects.toThrow();
		expect(failing.keys()).toEqual([]);
	});
});

/** Outside the upload's transaction, so it commits before the insert. */
async function seedRowWithKey(key: string) {
	await handle.client`
		INSERT INTO equipment_photos (user_id, gym_id, storage_key, content_type, bytes, width, height, sha256, status)
		VALUES (${alice}, ${alicesGym}, ${key}, 'image/jpeg', 1, 1, 1, ${'0'.repeat(64)}, 'uploaded')`;
}

describe('readOwnPhoto', () => {
	it('returns the owner their image, and nothing to another user', async () => {
		const photo = await uploadPhoto(
			db,
			alice,
			{ gymId: alicesGym, bytes: await smallPng() },
			{ store, limits }
		);
		const mine = await readOwnPhoto(db, alice, photo!.id, store);
		expect(mine?.contentType).toBe('image/jpeg'); // positive first
		expect(await readOwnPhoto(db, bob, photo!.id, store)).toBeNull();
		expect(await readOwnPhoto(db, alice, 'not-a-uuid', store)).toBeNull();
	});
});
