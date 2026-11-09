/**
 * /photos/[id]/review and /photos/[id]/image (0.4.0 §5/§7), in process, with
 * the memory store. The served-build path is e2e/photos.e2e.ts; these pin the
 * cross-tenant answers: B's GET of A's image is a 404, B's link on A's photo
 * is a 404 with no row, and B cannot link to A's owned model.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

// The removal actions need a journal; this stands in for the broker. Everything
// else in the module is real.
const journal = vi.hoisted(() => ({ entries: [] as unknown[] }));
vi.mock('$lib/server/privacy/ledger', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/server/privacy/ledger')>()),
	durableLedger: () => ({
		append: async (entry: unknown) => {
			journal.entries.push(entry);
		}
	})
}));

// The model, for the retry tests: a mock behind the real `complete()`. Unset,
// the real `complete()` runs with no LLM configured, as before.
const llm = vi.hoisted(() => ({ complete: null as CompleteFn | null }));
vi.mock('$lib/server/llm', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/llm')>();
	return {
		...actual,
		complete: ((...args: Parameters<CompleteFn>) =>
			(llm.complete ?? actual.complete)(...args)) as CompleteFn
	};
});

import { actions, load } from './+page.server';
import type { CompleteFn } from '$lib/server/llm';
import { scriptedModel, testComplete } from '$lib/server/llm/test-models';
import { photoRemovalUi, removalStatusLine, type StoredRemovalState } from '$lib/photo-removal-ui';
import { GET } from '../image/+server';
import * as s from '$lib/server/db/schema';
import { subjectHash } from '$lib/server/privacy/ledger';
import { deletionJobState } from '$lib/server/privacy/lifecycle';
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
	const page = (await loadAs(alice, photo.id)) as { removal: StoredRemovalState | null };
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

describe('removal says what is true: busy, failed and pending are different lines', () => {
	let enabled: string | undefined;
	beforeEach(() => {
		enabled = process.env.PRIVACY_DELETION_ENABLED;
		process.env.PRIVACY_DELETION_ENABLED = '1';
		journal.entries = [];
	});
	afterEach(() => {
		if (enabled === undefined) delete process.env.PRIVACY_DELETION_ENABLED;
		else process.env.PRIVACY_DELETION_ENABLED = enabled;
	});
	const remove = (user: string, id: string) =>
		actions.remove(post(user, id, { confirmRemoval: 'yes' }));
	const jobOf = async (photoId: string) =>
		(
			await harness.db
				.select()
				.from(s.privacyDeletions)
				.where(eq(s.privacyDeletions.subjectHash, subjectHash('photo', photoId)))
		)[0];

	it('an uncontended removal finishes, and the page has no removal line to show', async () => {
		// Positive first: the path the other cases leave from.
		const photo = await analyzedPhoto(alice, alicesGym);
		await expect(remove(alice, photo.id)).rejects.toMatchObject({
			status: 303,
			location: '/account?photoRemoved=1'
		});
		expect(await store.get(photo.storageKey)).toBeNull();
		expect(deletionJobState(await jobOf(photo.id))).toBe('completed');
	});

	it('busy: another holder has the object; "in progress", no retry mark, and the page says pending', async () => {
		const photo = await analyzedPhoto(alice, alicesGym);
		// Another runner (or an upload) holds the object's storage lock.
		const holder = await harness.client.reserve();
		try {
			await holder`SELECT pg_advisory_lock(hashtextextended(${photo.storageKey}, 29))`;
			const result = await remove(alice, photo.id);
			expect(result).toMatchObject({
				status: 503,
				data: { message: photoRemovalUi.outcome.busy, removal: 'busy' }
			});
			expect(photoRemovalUi.outcome.busy).not.toMatch(/retry/i);
			const job = await jobOf(photo.id);
			expect(job.lastError).toBeNull();
			expect(deletionJobState(job)).toBe('pending');
			expect(await store.get(photo.storageKey)).not.toBeNull();
			const page = (await loadAs(alice, photo.id)) as { removal: StoredRemovalState | null };
			expect(page.removal).toBe('pending');
			expect(removalStatusLine(page.removal)).toBe(photoRemovalUi.status.pending);
		} finally {
			await holder`SELECT pg_advisory_unlock_all()`;
			holder.release();
		}
		// Once the holder lets go, the same removal finishes.
		await expect(remove(alice, photo.id)).rejects.toMatchObject({ status: 303 });
		expect(await store.get(photo.storageKey)).toBeNull();
	});

	it('failed: the store refuses; "waiting for an operator retry", and the page says needs_retry', async () => {
		const photo = await analyzedPhoto(alice, alicesGym);
		store.erase = async () => {
			throw new Error('fictional store outage');
		};
		expect(await remove(alice, photo.id)).toMatchObject({
			status: 503,
			data: { message: photoRemovalUi.outcome.failed, removal: 'failed' }
		});
		const job = await jobOf(photo.id);
		expect(job.lastError).toBe('storage');
		const page = (await loadAs(alice, photo.id)) as { removal: StoredRemovalState | null };
		expect(page.removal).toBe('needs_retry');
		expect(removalStatusLine(page.removal)).toBe(photoRemovalUi.status.needs_retry);
		// Another user's POST on the same photo is a 404, and nothing about the job moves.
		await expect(remove(bob, photo.id)).rejects.toMatchObject({ status: 404 });
		expect((await jobOf(photo.id)).attempts).toBe(job.attempts);
	});

	it('the three run outcomes and the two stored states are five distinct lines', () => {
		const lines = [
			...Object.values(photoRemovalUi.outcome),
			photoRemovalUi.status.pending,
			photoRemovalUi.status.needs_retry
		];
		expect(new Set(lines).size).toBe(5);
		expect(removalStatusLine(null)).toBe(photoRemovalUi.status.done);
	});
});

/**
 * 2026-11-09: the gym page's landing after a transient provider answer. The
 * line and the control come from the photo's last read in llm_calls, so they
 * survive a reload and a visit from the gym page's "Waiting for review" list;
 * "Retry identification" re-reads the same saved photo.
 */
describe('identification temporarily unavailable', () => {
	afterEach(() => {
		llm.complete = null;
	});
	const BUSY = { status: 429, retryAfter: '0' };
	const notice = async (id: string) =>
		((await loadAs(alice, id)) as { analysisNotice: string | null }).analysisNotice;

	it('a 429 past the retry: unavailable; Retry identification identifies the same photo', async () => {
		const counting = new CountingPhotoStore();
		setPhotoStoreForTests(counting);
		const { photo } = (await uploadPhoto(
			harness.db,
			alice,
			{ gymId: alicesGym, bytes: await smallPng() },
			{ store: counting, limits: { maxBytes: 10 * 1024 * 1024, dailyLimit: 20 } }
		))!;
		llm.complete = testComplete(scriptedModel([BUSY, BUSY]));
		await expect(actions.analyze(post(alice, photo.id, { note: '' }))).rejects.toMatchObject({
			status: 303,
			location: `/photos/${photo.id}/review?analysis=unavailable`
		});
		expect(await notice(photo.id)).toBe('unavailable'); // no query: read from the database

		// The control posts ?/analyze for this photo id.
		llm.complete = testComplete(scriptedModel([{ text: JSON.stringify(FIXTURE_CANDIDATE) }]));
		await expect(actions.analyze(post(alice, photo.id, { note: '' }))).rejects.toMatchObject({
			status: 303,
			location: `/photos/${photo.id}/review`
		});
		const rows = await harness.db
			.select()
			.from(s.equipmentPhotos)
			.where(eq(s.equipmentPhotos.userId, alice));
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			id: photo.id,
			status: 'analyzed',
			candidate: FIXTURE_CANDIDATE
		});
		expect(counting.puts).toBe(1);
		expect(await notice(photo.id)).toBeNull();
		const calls = await harness.db.select().from(s.llmCalls).where(eq(s.llmCalls.userId, alice));
		expect(calls.map((c) => c.status).sort()).toEqual(['ok', 'provider_error', 'provider_error']);
	});

	it('any other failure keeps the ordinary line', async () => {
		const { photo } = (await uploadPhoto(
			harness.db,
			alice,
			{ gymId: alicesGym, bytes: await smallPng() },
			{ store, limits: { maxBytes: 10 * 1024 * 1024, dailyLimit: 20 } }
		))!;
		llm.complete = testComplete(scriptedModel([{ status: 403 }]));
		await expect(actions.analyze(post(alice, photo.id, { note: '' }))).rejects.toMatchObject({
			location: `/photos/${photo.id}/review?analysis=failed`
		});
		expect(await notice(photo.id)).toBeNull(); // the template's "!c" line, as before
	});
});
