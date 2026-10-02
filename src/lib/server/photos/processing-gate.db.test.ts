/**
 * The decode gate (0.5.3): at most MAX_CONCURRENT_PROCESSING photos are
 * decoded at once in this process; the rest wait their turn, and every one
 * finishes. Proven through uploadPhoto, with sharp's `toBuffer` (the decode
 * and encode) made slow and counted, against the test database and the memory
 * store.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDb, resetTestDbWithUsers, type TestDb } from '../test-db';
import * as s from '../db/schema';

const decode = vi.hoisted(() => ({ active: 0, peak: 0, entered: 0, delayMs: 0 }));
vi.mock('sharp', async (importOriginal) => {
	const real = (await importOriginal<typeof import('sharp')>()).default;
	// The slow fake processor: the real pipeline, held for `delayMs` inside
	// toBuffer, with a count of how many are inside at once.
	const slow = ((...args: Parameters<typeof real>) => {
		const instance = real(...args);
		const toBuffer = instance.toBuffer.bind(instance) as (...a: unknown[]) => Promise<unknown>;
		instance.toBuffer = (async (...a: unknown[]) => {
			decode.entered++;
			decode.active++;
			decode.peak = Math.max(decode.peak, decode.active);
			try {
				await new Promise((r) => setTimeout(r, decode.delayMs));
				return await toBuffer(...a);
			} finally {
				decode.active--;
			}
		}) as typeof instance.toBuffer;
		return instance;
	}) as unknown as typeof real;
	Object.assign(slow, real);
	return { default: slow };
});

import { MemoryPhotoStore } from './store';
import { uploadPhoto } from './index';
import { createSemaphore, MAX_CONCURRENT_PROCESSING, processingGate } from './process';
import { smallPng } from './test-fixtures';
import { emptyTimings } from './timings';

let db: TestDb;
let handle: Awaited<ReturnType<typeof setupTestDb>>;
let alice: string;
let gymId: string;
const limits = { maxBytes: 10 * 1024 * 1024, dailyLimit: 20 };

beforeAll(async () => {
	handle = await setupTestDb();
	db = handle.db;
});
afterAll(async () => {
	await handle?.end();
});
beforeEach(async () => {
	[{ id: alice }] = await resetTestDbWithUsers(db, handle.client, 1, 'gate');
	[{ id: gymId }] = await db.insert(s.gyms).values({ name: 'Gym', userId: alice }).returning();
	Object.assign(decode, { active: 0, peak: 0, entered: 0, delayMs: 0 });
});

describe('the processing gate', () => {
	it('is two slots', () => {
		expect(MAX_CONCURRENT_PROCESSING).toBe(2);
	});

	it('4 concurrent uploads: never more than 2 decoding at once, and all 4 complete', async () => {
		const png = await smallPng(); // (made with sharp too: before the counting starts)
		const store = new MemoryPhotoStore();
		Object.assign(decode, { active: 0, peak: 0, entered: 0, delayMs: 150 });
		const timings = [0, 1, 2, 3].map(() => emptyTimings());
		const uploads = timings.map((t) =>
			uploadPhoto(db, alice, { gymId, bytes: png }, { store, limits, timings: t })
		);
		const done = await Promise.all(uploads);

		// Positive first: all four really were decoded, stored and recorded...
		expect(decode.entered).toBe(4);
		expect(done.map((d) => d?.photo.status)).toEqual(Array(4).fill('uploaded'));
		expect(store.keys()).toHaveLength(4);
		// ...and two at a time: they overlapped, but never beyond the cap.
		expect(decode.peak).toBe(2);
		expect(processingGate.active).toBe(0);
		expect(processingGate.queued).toBe(0);

		// The two that queued waited about one decode; processMs excludes it.
		const waits = timings.map((t) => t.processWaitMs!).sort((a, b) => a - b);
		expect(waits[0]).toBeLessThan(50);
		expect(waits[1]).toBeLessThan(50);
		expect(waits[2]).toBeGreaterThanOrEqual(100);
		expect(waits[3]).toBeGreaterThanOrEqual(100);
		for (const t of timings) {
			expect(t.processMs!).toBeGreaterThanOrEqual(140);
			// One decode (150 ms) and a little; with the wait counted in, the
			// queued two would be 300 ms or more.
			expect(t.processMs!).toBeLessThan(290);
		}
	});

	it('a slot is released when the work throws, and the next caller gets it', async () => {
		const gate = createSemaphore(1);
		await expect(gate.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
		expect(await gate.run(async () => 'next')).toBe('next');
		expect([gate.active, gate.queued]).toEqual([0, 0]);
	});
});
