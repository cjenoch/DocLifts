/**
 * The upload action (0.5.3), in process, with a counting memory store and the
 * SDK's mock model behind `complete()`. Pins the hand-off (the processed JPEG
 * goes straight to analysis; the store is not read back) and the log line
 * (the stage timings, next to every field it carried before).
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { setupTestDb, resetTestDb, withTwoUsers, type TestDb } from '$lib/server/test-db';
import type { CompleteFn } from '$lib/server/photos/analyze';

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
// The model: a mock behind the real `complete()` (llm/test-models.ts), so the
// action's own analysis call runs end to end with no network.
const llm = vi.hoisted(() => ({ complete: null as CompleteFn | null }));
vi.mock('$lib/server/llm', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/server/llm')>();
	return {
		...actual,
		complete: ((...args: Parameters<CompleteFn>) =>
			(llm.complete ?? actual.complete)(...args)) as CompleteFn
	};
});

import { actions } from './+page.server';
import * as s from '$lib/server/db/schema';
import { setPhotoStoreForTests } from '$lib/server/photos/store';
import {
	CountingPhotoStore,
	FIXTURE_CANDIDATE,
	imageSentTo,
	smallPng
} from '$lib/server/photos/test-fixtures';
import { answeringModel, testComplete } from '$lib/server/llm/test-models';

let harness: Awaited<ReturnType<typeof setupTestDb>>;
let store: CountingPhotoStore;
let model: ReturnType<typeof answeringModel>;
let alice: string;
let bob: string;
let alicesGym: string;

beforeAll(async () => {
	harness = await setupTestDb();
	testDb.db = harness.db;
});
afterAll(async () => {
	setPhotoStoreForTests();
	await harness?.end();
});
beforeEach(async () => {
	await resetTestDb(harness.client);
	({ alice, bob } = await withTwoUsers(harness.db));
	store = new CountingPhotoStore();
	setPhotoStoreForTests(store);
	model = answeringModel(JSON.stringify(FIXTURE_CANDIDATE));
	llm.complete = testComplete(model);
	[{ id: alicesGym }] = await harness.db
		.insert(s.gyms)
		.values({ name: 'Alice Gym', userId: alice })
		.returning();
});
afterEach(() => {
	llm.complete = null;
	vi.restoreAllMocks();
});

type ActionEvent = Parameters<(typeof actions)['upload']>[0];
const upload = async (user: string, gymId: string, photo: Buffer) => {
	const fd = new FormData();
	fd.append('photo', new File([new Uint8Array(photo)], 'placard.png', { type: 'image/png' }));
	fd.append('clientOriginalBytes', '4000000');
	fd.append('clientResized', '1');
	return actions.upload({
		request: new Request('http://test.local/', { method: 'POST', body: fd }),
		params: { gymId },
		locals: { user: { id: user } } as App.Locals
	} as unknown as ActionEvent);
};

/** Runs `fn` and returns the `photo_upload` lines it logged. */
async function uploadLines(fn: () => Promise<unknown>) {
	const log = vi.spyOn(console, 'log').mockImplementation(() => {});
	await fn().catch((e) => e);
	const calls = [...log.mock.calls];
	log.mockRestore();
	return calls
		.map((c) => String(c[0]))
		.filter((l) => l.startsWith('{"event":"photo_upload"'))
		.map((l) => JSON.parse(l) as Record<string, unknown>);
}

const TIMINGS = ['processWaitMs', 'processMs', 'storePutMs', 'modelMs', 'totalMs'] as const;
const isMs = (v: unknown) => Number.isInteger(v) && (v as number) >= 0;

it('upload: the processed JPEG goes straight to analysis, and the store is not read back', async () => {
	const png = await smallPng();
	await expect(upload(alice, alicesGym, png)).rejects.toMatchObject({ status: 303 });
	const [photo] = await harness.db
		.select()
		.from(s.equipmentPhotos)
		.where(eq(s.equipmentPhotos.userId, alice));
	// Positive first: analysis really ran, on the stored image.
	expect(photo).toMatchObject({ status: 'analyzed', candidate: FIXTURE_CANDIDATE });
	expect(model.doGenerateCalls).toHaveLength(1);
	const sent = imageSentTo(model, 0);
	const stored = await store.get(photo.storageKey);
	const chunks: Buffer[] = [];
	for await (const c of stored!.body) chunks.push(Buffer.from(c as Buffer));
	expect(sent.equals(Buffer.concat(chunks))).toBe(true);
	// The read just above is the only one: the action itself read nothing back.
	expect(store.gets).toBe(1);
});

it('upload: the log line carries the timings, and every field it had before', async () => {
	const png = await smallPng();
	const lines = await uploadLines(() => upload(alice, alicesGym, png));
	expect(lines).toHaveLength(1);
	const [line] = lines;
	const [photo] = await harness.db
		.select()
		.from(s.equipmentPhotos)
		.where(eq(s.equipmentPhotos.userId, alice));
	expect(line).toMatchObject({
		event: 'photo_upload',
		clientOriginalBytes: 4000000,
		clientResized: true,
		receivedBytes: png.byteLength,
		outcome: 'stored',
		storedBytes: photo.bytes,
		photoId: photo.id
	});
	for (const k of TIMINGS) expect(isMs(line[k]), `${k}=${line[k]}`).toBe(true);
	expect(line.totalMs as number).toBeGreaterThanOrEqual(
		(line.processWaitMs as number) +
			(line.processMs as number) +
			(line.storePutMs as number) +
			(line.modelMs as number) -
			4
	);
});

it('upload: a failed analysis still logs the time the model call took', async () => {
	llm.complete = testComplete(model, {}); // not configured
	const png = await smallPng();
	const lines = await uploadLines(() => upload(alice, alicesGym, png));
	expect(lines).toHaveLength(1);
	expect(lines[0].outcome).toBe('stored');
	for (const k of TIMINGS) expect(isMs(lines[0][k]), `${k}=${lines[0][k]}`).toBe(true);
});

it('upload: a refused upload logs one refused line; stages it never reached are null', async () => {
	const notImage = await uploadLines(() => upload(alice, alicesGym, Buffer.from('not an image')));
	expect(notImage).toHaveLength(1);
	expect(notImage[0]).toMatchObject({
		outcome: 'refused',
		storedBytes: null,
		photoId: null,
		processWaitMs: null, // refused from the header, never queued for a decode
		storePutMs: null,
		modelMs: null
	});
	expect(isMs(notImage[0].processMs)).toBe(true);
	expect(isMs(notImage[0].totalMs)).toBe(true);

	// Another user's gym: a 404, refused before processing.
	const foreign = await uploadLines(() => upload(bob, alicesGym, Buffer.from('x')));
	expect(foreign).toHaveLength(1);
	expect(foreign[0]).toMatchObject({
		outcome: 'refused',
		processWaitMs: null,
		processMs: null,
		modelMs: null
	});
	expect(isMs(foreign[0].totalMs)).toBe(true);
});
