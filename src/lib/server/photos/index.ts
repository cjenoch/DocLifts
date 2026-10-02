/**
 * Equipment photos (0.4.0): upload, read-back, and the daily cap.
 *
 * Every function takes `(db, userId, ...)` (D5). `equipment_photos` is directly
 * owned, and the gym a photo is for is resolved with `gyms.user_id = userId` in
 * the same query that uses it, so another user's gym or photo is not found —
 * never a 403 (D6).
 */
import { randomUUID } from 'node:crypto';
import { and, count, eq, gt, sql } from 'drizzle-orm';
import { equipmentPhotos, gyms, type EquipmentPhoto } from '../db/schema';
import type { Database } from '../progression';
import type { PhotoLimits } from './config';
import { processPhoto } from './process';
import { photoKey, type PhotoStore } from './store';
import { timed, type PhotoTimings } from './timings';

export { PhotoInputError } from './process';
export { PhotoConfigError } from './config';

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: string) => uuidRe.test(v);

/** The daily cap refused an upload or an analysis. Shown on the page as is. */
export class PhotoLimitError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PhotoLimitError';
	}
}

export const DAY_MS = 24 * 60 * 60 * 1000;

/** One of this user's gyms, or null (missing and foreign look the same). */
export async function ownGym(db: Database, userId: string, gymId: string) {
	if (!isUuid(gymId)) return null;
	const [gym] = await db
		.select()
		.from(gyms)
		.where(and(eq(gyms.id, gymId), eq(gyms.userId, userId)));
	return gym ?? null;
}

/** Photos this user created in the last 24 hours — every row, whatever its status. */
export async function uploadsInLastDay(db: Database, userId: string): Promise<number> {
	const [{ n }] = await db
		.select({ n: count() })
		.from(equipmentPhotos)
		.where(
			and(
				eq(equipmentPhotos.userId, userId),
				gt(equipmentPhotos.createdAt, sql`now() - interval '24 hours'`)
			)
		);
	return n;
}

export const uploadLimitMessage = (limit: number) =>
	limit === 0
		? 'Photo uploads are switched off.'
		: `You have uploaded ${limit} photos in the last 24 hours, the daily limit. Try again later.`;

/** A stored photo's row, and the processed JPEG that was stored under its key. */
export type UploadedPhoto = { photo: EquipmentPhoto; image: Buffer };

export type UploadInput = {
	gymId: string;
	bytes: Uint8Array;
	/** What the browser declared; used only for the HEIC message. */
	type?: string;
	name?: string;
};

/**
 * Store one photo for one of this user's gyms and record it as `uploaded`.
 *
 * Order: gym (owner) -> size -> daily cap -> process (orient, resize, strip)
 * -> under a per-user advisory lock, recount, `put`, insert. The recount under
 * the lock makes the cap exact when two uploads race. If the insert fails the
 * stored object is deleted, so the store never holds an object no row names.
 *
 * Returns the row and `image`, the processed JPEG exactly as stored, so the
 * upload action can hand it to `analyzePhoto` without reading it back from the
 * store (0.5.3). `deps.timings`, when given, receives `processWaitMs`,
 * `processMs` and `storePutMs` (timings.ts); measurement only.
 *
 * Returns null when the gym is not this user's. Throws `PhotoInputError`
 * (size, format) or `PhotoLimitError` (daily cap) for the page to show.
 */
export async function uploadPhoto(
	db: Database,
	userId: string,
	input: UploadInput,
	deps: { store: PhotoStore; limits: PhotoLimits; timings?: PhotoTimings }
): Promise<UploadedPhoto | null> {
	const gym = await ownGym(db, userId, input.gymId);
	if (!gym) return null;
	const { limits, store } = deps;
	// Size first: processPhoto checks it too, but a refused upload should not
	// cost a count query, and the cap message must not mask a size message.
	if (input.bytes.byteLength <= limits.maxBytes) {
		if ((await uploadsInLastDay(db, userId)) >= limits.dailyLimit) {
			throw new PhotoLimitError(uploadLimitMessage(limits.dailyLimit));
		}
	}
	const processed = await processPhoto(input.bytes, {
		maxBytes: limits.maxBytes,
		type: input.type,
		name: input.name,
		timings: deps.timings
	});

	const id = randomUUID();
	const key = photoKey(userId, id);
	let stored = false;
	try {
		const photo = await db.transaction(async (tx) => {
			await tx.execute(
				sql`SELECT pg_advisory_xact_lock(hashtext(${'equipment_photos:' + userId}))`
			);
			if ((await uploadsInLastDay(tx, userId)) >= limits.dailyLimit) {
				throw new PhotoLimitError(uploadLimitMessage(limits.dailyLimit));
			}
			await timed(deps.timings, 'storePutMs', () =>
				store.put(key, processed.body, processed.contentType)
			);
			stored = true;
			const [row] = await tx
				.insert(equipmentPhotos)
				.values({
					id,
					userId,
					gymId: gym.id,
					storageKey: key,
					contentType: processed.contentType,
					bytes: processed.bytes,
					width: processed.width,
					height: processed.height,
					sha256: processed.sha256,
					status: 'uploaded'
				})
				.returning();
			return row;
		});
		return { photo, image: processed.body };
	} catch (error) {
		if (stored) await store.delete(key).catch(() => {});
		throw error;
	}
}

/** One of this user's photos, or null. */
export async function loadOwnPhoto(db: Database, userId: string, photoId: string) {
	if (!isUuid(photoId)) return null;
	const [row] = await db
		.select()
		.from(equipmentPhotos)
		.where(and(eq(equipmentPhotos.id, photoId), eq(equipmentPhotos.userId, userId)));
	return row ?? null;
}

/**
 * The image bytes of one of this user's photos, or null when the photo is not
 * theirs, does not exist, or its object is gone (discarded).
 */
export async function readOwnPhoto(
	db: Database,
	userId: string,
	photoId: string,
	store: PhotoStore
) {
	const photo = await loadOwnPhoto(db, userId, photoId);
	if (!photo || photo.status === 'discarded') return null;
	return store.get(photo.storageKey);
}

/**
 * For this user's machines that came from a photo: machine id -> photo id,
 * for the thumbnail (served by the guarded image route).
 */
export async function photoIdsByMachine(
	db: Database,
	userId: string
): Promise<Record<string, string>> {
	const rows = await db
		.select({ machineId: equipmentPhotos.gymEquipmentId, photoId: equipmentPhotos.id })
		.from(equipmentPhotos)
		.where(and(eq(equipmentPhotos.userId, userId), eq(equipmentPhotos.status, 'confirmed')));
	return Object.fromEntries(
		rows.filter((r) => r.machineId).map((r) => [r.machineId as string, r.photoId])
	);
}
