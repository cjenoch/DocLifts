/**
 * /photos/[id]/review and /photos/[id]/image (0.4.0 §5/§7), in process, with
 * the memory store. The served-build path is e2e/photos.e2e.ts; these pin the
 * cross-tenant answers: B's GET of A's image is a 404, B's link on A's photo
 * is a 404 with no row, and B cannot link to A's owned model.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { setupTestDb, resetTestDb, withTwoUsers, type TestDb } from '$lib/server/test-db';

const testDb = vi.hoisted(() => ({ db: null as TestDb | null }));
vi.mock('$lib/server/db', async () => {
	const schema = await import('$lib/server/db/schema');
	return {
		get db() {
			return testDb.db;
		},
		...schema
	};
});

import { actions, load } from './+page.server';
import { GET } from '../image/+server';
import * as s from '$lib/server/db/schema';
import { MemoryPhotoStore, setPhotoStoreForTests } from '$lib/server/photos/store';
import { uploadPhoto } from '$lib/server/photos';
import { CountingPhotoStore, FIXTURE_CANDIDATE, smallPng } from '$lib/server/photos/test-fixtures';

let harness: Awaited<ReturnType<typeof setupTestDb>>;
let store: MemoryPhotoStore;
beforeAll(async () => {
	harness = await setupTestDb();
	testDb.db = harness.db;
});
afterAll(async () => {
	setPhotoStoreForTests();
	await harness?.end();
});

let alice: string;
let bob: string;
let alicesGym: string;
let bobsGym: string;
let catalogRow: typeof s.equipmentModels.$inferSelect;
let alicesModel: typeof s.equipmentModels.$inferSelect;
beforeEach(async () => {
	await resetTestDb(harness.client);
	({ alice, bob } = await withTwoUsers(harness.db));
	store = new MemoryPhotoStore();
	setPhotoStoreForTests(store);
	[{ id: alicesGym }] = await harness.db
		.insert(s.gyms)
		.values({ name: 'Alice Gym', userId: alice })
		.returning();
	[{ id: bobsGym }] = await harness.db
		.insert(s.gyms)
		.values({ name: 'Bob Gym', userId: bob })
		.returning();
	[catalogRow] = await harness.db
		.insert(s.equipmentModels)
		.values({
			manufacturer: 'Hammer Strength',
			name: 'Iso-Lateral Row',
			code: 'IL-ROW',
			loadingType: 'machine-plate',
			confidence: 'manufacturer_page'
		})
		.returning();
	[alicesModel] = await harness.db
		.insert(s.equipmentModels)
		.values({
			manufacturer: 'Garage Iron',
			name: 'Hip Thrust',
			loadingType: 'machine-plate',
			ownerUserId: alice
		})
		.returning();
});

async function analyzedPhoto(userId: string, gymId: string) {
	const photo = (await uploadPhoto(
		harness.db,
		userId,
		{ gymId, bytes: await smallPng() },
		{ store, limits: { maxBytes: 10 * 1024 * 1024, dailyLimit: 20 } }
	))!.photo;
	await harness.db
		.update(s.equipmentPhotos)
		.set({ status: 'analyzed', candidate: FIXTURE_CANDIDATE })
		.where(eq(s.equipmentPhotos.id, photo.id));
	return photo;
}

const locals = (user: string) => ({ user: { id: user } }) as App.Locals;
const loadAs = (user: string, id: string) =>
	load({
		params: { id },
		locals: locals(user),
		url: new URL(`http://test.local/photos/${id}/review`)
	} as unknown as Parameters<typeof load>[0]);
type ActionEvent = Parameters<(typeof actions)['link']>[0];
const post = (user: string, id: string, form: Record<string, string>) => {
	const fd = new FormData();
	for (const [k, v] of Object.entries(form)) fd.append(k, v);
	return {
		request: new Request('http://test.local/', { method: 'POST', body: fd }),
		params: { id },
		locals: locals(user)
	} as unknown as ActionEvent;
};
const getImage = (user: string, id: string) =>
	GET({ params: { id }, locals: locals(user) } as unknown as Parameters<typeof GET>[0]);
const machinesAt = (gym: string) =>
	harness.db.select().from(s.gymEquipment).where(eq(s.gymEquipment.gymId, gym));

it('review: the owner sees the candidate and the exact match preselected; another user a 404', async () => {
	const photo = await analyzedPhoto(alice, alicesGym);
	const page = await loadAs(alice, photo.id);
	expect(page).toMatchObject({
		candidate: FIXTURE_CANDIDATE,
		candidateLoadingType: 'machine-plate',
		matching: { method: 'exact', preselectedId: catalogRow.id }
	});
	await expect(loadAs(bob, photo.id)).rejects.toMatchObject({ status: 404 });
	await expect(loadAs(alice, crypto.randomUUID())).rejects.toMatchObject({ status: 404 });
});

it("image: the owner gets the JPEG; B's GET of A's image is a 404", async () => {
	const photo = await analyzedPhoto(alice, alicesGym);
	const res = await getImage(alice, photo.id);
	expect(res.status).toBe(200);
	expect(res.headers.get('content-type')).toBe('image/jpeg');
	const bytes = Buffer.from(await res.arrayBuffer());
	expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8])); // JPEG SOI
	expect(bytes.byteLength).toBe(photo.bytes);
	await expect(getImage(bob, photo.id)).rejects.toMatchObject({ status: 404 });
	await expect(getImage(bob, 'not-a-uuid')).rejects.toMatchObject({ status: 404 });
});

it("link: the owner's link makes the machine; B posting link on A's photo is a 404 and no row", async () => {
	const photo = await analyzedPhoto(alice, alicesGym);
	const other = await analyzedPhoto(alice, alicesGym);
	await expect(
		actions.link(post(alice, other.id, { modelId: catalogRow.id }))
	).rejects.toMatchObject({ status: 303, location: `/photos/${other.id}/review` });
	expect(await machinesAt(alicesGym)).toHaveLength(1);

	await expect(actions.link(post(bob, photo.id, { modelId: catalogRow.id }))).rejects.toMatchObject(
		{ status: 404 }
	);
	expect(await machinesAt(alicesGym)).toHaveLength(1);
	expect(await machinesAt(bobsGym)).toEqual([]);
	const [still] = await harness.db
		.select()
		.from(s.equipmentPhotos)
		.where(eq(s.equipmentPhotos.id, photo.id));
	expect(still.status).toBe('analyzed');
});

it("B cannot link B's own photo to A's owned model: a 404, and no machine", async () => {
	const alicesPhoto = await analyzedPhoto(alice, alicesGym);
	await expect(
		actions.link(post(alice, alicesPhoto.id, { modelId: alicesModel.id }))
	).rejects.toMatchObject({ status: 303 });
	const bobsPhoto = await analyzedPhoto(bob, bobsGym);
	await expect(
		actions.link(post(bob, bobsPhoto.id, { modelId: alicesModel.id }))
	).resolves.toMatchObject({ status: 404, data: { message: 'Model not found' } });
	expect(await machinesAt(bobsGym)).toEqual([]);
});

it('re-analyze reads the photo back from the store (0.5.3: only upload hands it over)', async () => {
	store = new CountingPhotoStore();
	setPhotoStoreForTests(store);
	const photo = await analyzedPhoto(alice, alicesGym);
	expect((store as CountingPhotoStore).gets).toBe(0);
	// No model is configured here, so the call is refused after the image is read.
	await expect(actions.analyze(post(alice, photo.id, { note: '' }))).rejects.toMatchObject({
		status: 303,
		location: `/photos/${photo.id}/review?analysis=failed`
	});
	expect((store as CountingPhotoStore).gets).toBe(1);
	const calls = await harness.db.select().from(s.llmCalls).where(eq(s.llmCalls.userId, alice));
	expect(calls).toMatchObject([{ status: 'refused', errorCode: 'not_configured' }]);
});

it('discard: the object is gone (image 404) and the row is discarded; B cannot discard', async () => {
	const photo = await analyzedPhoto(alice, alicesGym);
	await expect(actions.discard(post(bob, photo.id, {}))).rejects.toMatchObject({ status: 404 });
	expect((await getImage(alice, photo.id)).status).toBe(200);

	await expect(actions.discard(post(alice, photo.id, {}))).rejects.toMatchObject({ status: 303 });
	expect(await store.get(photo.storageKey)).toBeNull();
	await expect(getImage(alice, photo.id)).rejects.toMatchObject({ status: 404 });
	await expect(loadAs(alice, photo.id)).resolves.toMatchObject({
		photo: { status: 'discarded' }
	});
});
