/**
 * `?/readPhoto` on a workout's photo block, in process, with the memory store
 * and the SDK's mock model behind the real `complete()` (2026-11-09).
 *
 * On a phone: the block's read runs while sets are logged; when the provider
 * is rate limited or down past the one automatic retry, the block says "Photo
 * saved. Identification is temporarily unavailable." with "Retry
 * identification" (44 px, one thumb), and that tap reads the SAME saved photo.
 * These assert the database, not the text: the photo id, its status, the
 * llm_calls rows, and that nothing was uploaded or stored again.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { createTestUser, setupTestDb, resetTestDb, type TestDb } from '$lib/server/test-db';
import type { CompleteFn } from '$lib/server/llm';

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
import * as s from '$lib/server/db/schema';
import { createGym } from '$lib/server/machines';
import { startQuickSession } from '$lib/server/quick-workouts';
import { openPhotoBlock } from '$lib/server/photo-workout';
import { uploadPhoto } from '$lib/server/photos';
import { setPhotoStoreForTests } from '$lib/server/photos/store';
import { CountingPhotoStore, FIXTURE_CANDIDATE, smallPng } from '$lib/server/photos/test-fixtures';
import { cappedComplete, scriptedModel, testComplete } from '$lib/server/llm/test-models';

let harness: Awaited<ReturnType<typeof setupTestDb>>;
let store: CountingPhotoStore;
let userId: string;
beforeAll(async () => {
	harness = await setupTestDb();
	testDb.db = harness.db;
});
beforeEach(async () => {
	await resetTestDb(harness.client);
	userId = await createTestUser(harness.db, 'read-photo-route');
	store = new CountingPhotoStore();
	setPhotoStoreForTests(store);
});
afterEach(() => {
	llm.complete = null;
});
afterAll(async () => {
	setPhotoStoreForTests();
	await harness?.end();
});

/** Retry-After 0: the automatic retry runs at once instead of after 1-2 s. */
const BUSY = { status: 503, retryAfter: '0' };
const OK = { text: JSON.stringify(FIXTURE_CANDIDATE) };

/** A quick workout with one photo block, its photo stored as the photo action stores it. */
async function photoBlock() {
	const db = testDb.db!;
	const gym = await createGym(db, userId, { name: 'Corner gym' });
	const started = await startQuickSession(db, userId, gym.id);
	if (!started.ok) throw new Error(started.message);
	const { photo } = (await uploadPhoto(
		db,
		userId,
		{ gymId: gym.id, bytes: await smallPng() },
		{ store, limits: { maxBytes: 10 * 1024 * 1024, dailyLimit: 20 } }
	))!;
	const block = await openPhotoBlock(db, userId, started.sessionId, photo.id);
	return { sessionId: started.sessionId, photoId: photo.id, occurrenceId: block.id };
}

type ActionEvent = Parameters<(typeof actions)['readPhoto']>[0];
const readPhoto = (sessionId: string, photoId: string) => {
	const fd = new FormData();
	fd.append('photoId', photoId);
	return actions.readPhoto({
		request: new Request('http://test.local/', { method: 'POST', body: fd }),
		params: { id: sessionId },
		locals: { user: { id: userId } } as App.Locals
	} as unknown as ActionEvent);
};
const blockKind = async (sessionId: string, occurrenceId: string) => {
	const page = (await load({
		params: { id: sessionId },
		url: new URL('http://test.local/'),
		locals: { user: { id: userId } }
	} as Parameters<typeof load>[0])) as { photoBlocks: Record<string, { kind: string }> };
	return page.photoBlocks[occurrenceId]?.kind;
};
const photos = () =>
	testDb.db!.select().from(s.equipmentPhotos).where(eq(s.equipmentPhotos.userId, userId));
const calls = () =>
	testDb
		.db!.select({ status: s.llmCalls.status, errorCode: s.llmCalls.errorCode })
		.from(s.llmCalls)
		.where(eq(s.llmCalls.userId, userId))
		.orderBy(asc(s.llmCalls.createdAt));

it('503 past the retry: unavailable, then Retry identification identifies the same photo', async () => {
	const { sessionId, photoId, occurrenceId } = await photoBlock();
	llm.complete = testComplete(scriptedModel([BUSY, BUSY]));
	expect(await readPhoto(sessionId, photoId)).toEqual({ read: 'unavailable', photoId });
	expect((await calls()).map((c) => c.errorCode)).toEqual(['http_503', 'http_503']);
	// The block says so after a reload too: the state is the database's.
	expect(await blockKind(sessionId, occurrenceId)).toBe('unavailable');

	// "Retry identification" posts the same form with the same photo id.
	llm.complete = testComplete(scriptedModel([OK]));
	expect(await readPhoto(sessionId, photoId)).toMatchObject({ photoId });
	const [photo] = await photos();
	expect(photo).toMatchObject({ id: photoId, status: 'analyzed', candidate: FIXTURE_CANDIDATE });
	expect(await photos()).toHaveLength(1);
	expect(store.puts).toBe(1); // the upload's one write; the retry stored nothing
	expect(store.keys()).toHaveLength(1);
	expect((await calls()).map((c) => c.status)).toEqual(['provider_error', 'provider_error', 'ok']);
	expect(await blockKind(sessionId, occurrenceId)).not.toBe('unavailable');
});

it('429 then ok: the automatic retry identifies it, with no tap', async () => {
	const { sessionId, photoId } = await photoBlock();
	llm.complete = testComplete(scriptedModel([{ status: 429, retryAfter: '0' }, OK]));
	expect(await readPhoto(sessionId, photoId)).toMatchObject({ photoId });
	const [photo] = await photos();
	expect(photo).toMatchObject({ id: photoId, status: 'analyzed' });
	expect((await calls()).map((c) => c.errorCode)).toEqual(['http_429', null]);
});

it('a 401 is not retried and is the ordinary failure', async () => {
	const { sessionId, photoId, occurrenceId } = await photoBlock();
	llm.complete = testComplete(scriptedModel([{ status: 401 }, OK]));
	expect(await readPhoto(sessionId, photoId)).toEqual({ read: 'failed', photoId });
	expect(await calls()).toHaveLength(1);
	expect(await blockKind(sessionId, occurrenceId)).toBe('failed');
});

it('the hourly cap refuses the retry: recorded, and the user sees the ordinary failure', async () => {
	const { sessionId, photoId, occurrenceId } = await photoBlock();
	llm.complete = cappedComplete(scriptedModel([BUSY, OK]), 1);
	expect(await readPhoto(sessionId, photoId)).toEqual({ read: 'failed', photoId });
	expect((await calls()).map((c) => [c.status, c.errorCode])).toEqual([
		['provider_error', 'http_503'],
		['refused', 'hourly_cap']
	]);
	expect(await blockKind(sessionId, occurrenceId)).toBe('failed');
});
