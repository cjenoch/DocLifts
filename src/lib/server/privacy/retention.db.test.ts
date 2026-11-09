import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { setupTestDb, resetTestDbWithUsers, type TestDb } from '../test-db';
import * as s from '../db/schema';
import { createLlmClient } from '../llm';
import { LOCAL_MODEL, SAFETY_PURPOSE } from '../llm/safety';
import { PhotoSafetyError, scanPhoto } from '../photos/safety';
import { smallPng } from '../photos/test-fixtures';
import { ABANDONED_RESERVATION_MINUTES, sweepRetention } from './retention';

let handle: Awaited<ReturnType<typeof setupTestDb>>;
let db: TestDb;
let alice: string;
let bob: string;
beforeAll(async () => {
	handle = await setupTestDb();
	db = handle.db;
});
afterAll(async () => {
	await handle?.end();
});
beforeEach(async () => {
	[{ id: alice }, { id: bob }] = await resetTestDbWithUsers(db, handle.client, 2, 'retention');
});

const minutesAgo = (m: number) => new Date(Date.now() - m * 60000);
/** The row completeSafety writes before any I/O, as a crash would leave it. */
async function reservation(userId: string, createdAt: Date) {
	const [row] = await db
		.insert(s.llmCalls)
		.values({
			userId,
			purpose: SAFETY_PURPOSE,
			provider: 'local',
			model: LOCAL_MODEL,
			status: 'refused',
			errorCode: 'pending',
			promptHash: 'fixture',
			output: { policy: { version: 'alpha-v1' } },
			latencyMs: 0,
			createdAt
		})
		.returning();
	return row;
}
const row = async (id: string) =>
	(await db.select().from(s.llmCalls).where(eq(s.llmCalls.id, id)))[0];

describe('abandoned photo-safety reservations', () => {
	it('settles an abandoned reservation once, as timeout/abandoned, before details are cleared', async () => {
		const stuck = await reservation(alice, minutesAgo(ABANDONED_RESERVATION_MINUTES + 1));
		const first = await sweepRetention(db, alice, { apply: true });
		expect(first.abandoned).toBe(1);
		expect(await row(stuck.id)).toMatchObject({
			status: 'timeout',
			errorCode: 'abandoned',
			purpose: SAFETY_PURPOSE,
			createdAt: stuck.createdAt
		});
		const second = await sweepRetention(db, alice, { apply: true });
		expect(second.abandoned).toBe(0);
		expect((await row(stuck.id)).status).toBe('timeout');

		// Past the details window the code is cleared, but the status still says
		// what happened: it can no longer read as a cap refusal.
		const old = await reservation(alice, new Date(Date.now() - 31 * 86400000));
		await sweepRetention(db, alice, { apply: true });
		expect(await row(old.id)).toMatchObject({ status: 'timeout', errorCode: null });
	});

	it('leaves a live reservation, a dry run and another owner alone', async () => {
		const stuck = await reservation(alice, minutesAgo(ABANDONED_RESERVATION_MINUTES + 1));
		const live = await reservation(alice, minutesAgo(ABANDONED_RESERVATION_MINUTES - 1));
		const foreign = await reservation(bob, minutesAgo(ABANDONED_RESERVATION_MINUTES + 1));
		const dry = await sweepRetention(db, alice);
		expect(dry.abandoned).toBe(1);
		expect((await row(stuck.id)).status).toBe('refused');
		await sweepRetention(db, alice, { apply: true });
		expect((await row(stuck.id)).status).toBe('timeout');
		expect(await row(live.id)).toMatchObject({ status: 'refused', errorCode: 'pending' });
		expect(await row(foreign.id)).toMatchObject({ status: 'refused', errorCode: 'pending' });
	});

	it('keeps counting a settled reservation against the safety hourly cap', async () => {
		const env = { PHOTO_SAFETY_MODE: 'local', PHOTO_SAFETY_HOURLY_LIMIT: '1' };
		const transport = (async () =>
			Response.json({ model: LOCAL_MODEL, nsfw: 0.01 })) as unknown as typeof fetch;
		const { complete } = createLlmClient({ env, transport });
		const scan = () => scanPhoto(db, alice, new Uint8Array(smallPngBytes), { env, complete });
		// Positive first: with no reservation the one allowed scan passes.
		await expect(scan()).resolves.toBeUndefined();
		await db.delete(s.llmCalls);
		await reservation(alice, minutesAgo(ABANDONED_RESERVATION_MINUTES + 1));
		await expect(scan()).rejects.toBeInstanceOf(PhotoSafetyError);
		await sweepRetention(db, alice, { apply: true });
		await expect(scan()).rejects.toBeInstanceOf(PhotoSafetyError);
		const capRows = (await db.select().from(s.llmCalls)).filter(
			(r) => r.errorCode === 'hourly_cap'
		);
		expect(capRows).toHaveLength(2);
	});
});

let smallPngBytes: Buffer;
beforeAll(async () => {
	smallPngBytes = await smallPng();
});
