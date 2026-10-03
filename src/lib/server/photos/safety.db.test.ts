/** Harmless generated pixels only. These test enforcement, not harmful-image recall. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { setupTestDb, resetTestDbWithUsers, type TestDb } from '../test-db';
import * as s from '../db/schema';
import { createLlmClient, usageForUser } from '../llm';
import { LOCAL_MODEL, REMOTE_MODEL } from '../llm/safety';
import { uploadPhoto } from './index';
import { PhotoSafetyError, scanPhoto, safetyConfig, safetyProvider } from './safety';
import { MemoryPhotoStore } from './store';
import { phonePhoto, smallPng } from './test-fixtures';
import { emptyTimings } from './timings';

let handle: Awaited<ReturnType<typeof setupTestDb>>;
let db: TestDb;
let alice: string;
let bob: string;
let gym: string;
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
	[{ id: alice }, { id: bob }] = await resetTestDbWithUsers(db, handle.client, 2, 'safety');
	[{ id: gym }] = await db
		.insert(s.gyms)
		.values({ name: 'Safety test gym', userId: alice })
		.returning();
	store = new MemoryPhotoStore();
});
const remote = (text = 'safe', finish = 'stop') =>
	Response.json({
		choices: [{ finish_reason: finish, message: { content: text } }],
		usage: { prompt_tokens: 200, completion_tokens: 3, cost: 0.00004 }
	});
const local = (score = 0.01) => Response.json({ model: LOCAL_MODEL, nsfw: score });
function scanner(mode: string, transport: typeof fetch, extra: Record<string, string> = {}) {
	const env = { PHOTO_SAFETY_MODE: mode, OPENROUTER_API_KEY: 'test-only-placeholder', ...extra };
	const client = createLlmClient({ env, transport });
	return (database: Parameters<typeof scanPhoto>[0], owner: string, bytes: Uint8Array) =>
		scanPhoto(database, owner, bytes, { env, complete: client.complete });
}
async function upload(scan: typeof scanPhoto, bytes?: Buffer) {
	return uploadPhoto(
		db,
		alice,
		{ gymId: gym, bytes: bytes ?? (await smallPng()) },
		{ store, limits, scan }
	);
}
const calls = () => db.select().from(s.llmCalls).orderBy(s.llmCalls.createdAt);
async function nothingStored() {
	expect(store.keys()).toEqual([]);
	expect(await db.select().from(s.equipmentPhotos)).toEqual([]);
	expect(await db.select().from(s.sessionExercises)).toEqual([]);
}

describe('pre-storage safety enforcement', () => {
	it.each(['local', 'openrouter'])(
		'allows a valid %s result and audits only metadata',
		async (mode) => {
			let sent: RequestInit | undefined;
			let endpoint = '';
			const transport = vi.fn<typeof fetch>(async (url, init) => {
				endpoint = String(url);
				sent = init;
				return mode === 'local' ? local() : remote();
			});
			const image = await phonePhoto(400, 300);
			const timings = emptyTimings();
			const result = await uploadPhoto(
				db,
				alice,
				{ gymId: gym, bytes: image },
				{
					store,
					limits,
					timings,
					scan: scanner(mode, transport)
				}
			);
			expect(result).not.toBeNull();
			expect(store.keys()).toHaveLength(1);
			expect(timings.safetyMs).toBeGreaterThanOrEqual(0);
			let jpeg: Buffer;
			if (mode === 'openrouter') {
				const body = JSON.parse(String(sent!.body));
				expect(body.model).toBe(REMOTE_MODEL);
				expect(body.provider).toEqual({
					only: ['DeepInfra'],
					allow_fallbacks: false,
					data_collection: 'deny'
				});
				jpeg = Buffer.from(body.messages[0].content[1].image_url.url.split(',')[1], 'base64');
				expect(endpoint).toBe('https://openrouter.ai/api/v1/chat/completions');
			} else {
				jpeg = Buffer.from(sent!.body as Buffer);
				expect(endpoint).toBe('http://safety:8000/scan');
			}
			expect(jpeg.equals(result!.image)).toBe(true);
			expect((await sharp(jpeg).metadata()).exif).toBeUndefined();
			expect(sent!.redirect).toBe('error');
			const [audit] = await calls();
			expect(audit).toMatchObject({
				userId: alice,
				purpose: 'photo_safety',
				status: 'ok',
				promptText: null,
				output: {
					allowed: true,
					provider: mode,
					policy: { version: 'alpha-v1', mode, threshold: 0.5 }
				}
			});
			expect(JSON.stringify(audit)).not.toContain('data:image');
			expect(JSON.stringify(audit)).not.toContain('test-only-placeholder');
			expect(transport).toHaveBeenCalledTimes(1);
			// Audit remains owner-scoped through the existing usage reader.
			expect((await usageForUser(db, alice, new Date(0))).calls).toBeGreaterThan(0);
			expect((await usageForUser(db, bob, new Date(0))).calls).toBe(0);
		}
	);

	it.each(['local', 'openrouter'])(
		'blocks %s refusals before put, erases held buffers and never falls back',
		async (mode) => {
			const bytes = await smallPng();
			let cleaned: Uint8Array | undefined;
			const transport = vi.fn<typeof fetch>(async () =>
				mode === 'local' ? local(0.5) : remote('unsafe\nS1,S3')
			);
			const scan = scanner(mode, transport);
			await expect(
				upload(async (d, u, b) => {
					cleaned = b;
					await scan(d, u, b);
				}, bytes)
			).rejects.toMatchObject({ reason: 'blocked' });
			await nothingStored();
			expect(bytes.every((v) => v === 0)).toBe(true);
			expect(cleaned!.every((v) => v === 0)).toBe(true);
			expect(transport).toHaveBeenCalledTimes(1);
			expect((await calls())[0].output).toMatchObject({ allowed: false, provider: mode });
		}
	);

	it('keeps an above/below threshold boundary distinct', async () => {
		await upload(scanner('local', async () => local(0.4999)));
		expect(store.keys()).toHaveLength(1);
		await expect(upload(scanner('local', async () => local(0.5001)))).rejects.toMatchObject({
			reason: 'blocked'
		});
		expect(store.keys()).toHaveLength(1);
		expect(await db.select().from(s.equipmentPhotos)).toHaveLength(1);
	});

	const failures: [string, string, () => Promise<Response>][] = [
		[
			'provider HTTP error',
			'openrouter',
			async () => new Response('private provider error', { status: 503 })
		],
		['missing result', 'openrouter', async () => Response.json({ choices: [] })],
		['ambiguous response', 'openrouter', async () => remote('probably safe')],
		['truncated response', 'openrouter', async () => remote('safe', 'length')],
		['oversized response', 'openrouter', async () => new Response('x'.repeat(17000))],
		['broken JSON', 'local', async () => new Response('{')],
		['wrong local model', 'local', async () => Response.json({ model: 'wrong', nsfw: 0 })],
		['out-of-range score', 'local', async () => local(-1)],
		[
			'local unavailable',
			'local',
			async () => {
				throw new Error('private connection detail');
			}
		],
		['timeout', 'openrouter', () => new Promise(() => {})]
	];
	it.each(failures)(
		'%s refuses the upload without preserving raw responses',
		async (_name, mode, answer) => {
			await expect(
				upload(scanner(mode, answer, { PHOTO_SAFETY_TIMEOUT_MS: '100' }))
			).rejects.toBeInstanceOf(PhotoSafetyError);
			await nothingStored();
			const [audit] = await calls();
			expect(audit.status).not.toBe('ok');
			expect(JSON.stringify(audit)).not.toContain('private');
			expect(audit.output).toEqual({ policy: { version: 'alpha-v1', mode, threshold: 0.5 } });
		}
	);

	it('reserves the hourly cap across concurrent requests and owners independently', async () => {
		const transport = vi.fn<typeof fetch>(async () => local());
		const scan = scanner('local', transport, { PHOTO_SAFETY_HOURLY_LIMIT: '1' });
		const results = await Promise.allSettled([upload(scan), upload(scan)]);
		expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
		expect(store.keys()).toHaveLength(1);
		expect(transport).toHaveBeenCalledTimes(1);
		await scan(db, bob, await smallPng());
		expect(transport).toHaveBeenCalledTimes(2);
		expect((await calls()).filter((r) => r.errorCode === 'hourly_cap')).toHaveLength(1);
	});

	it('does not scan or store a foreign gym upload', async () => {
		const transport = vi.fn<typeof fetch>(async () => local());
		const scan = scanner('local', transport);
		expect(await upload(scan)).not.toBeNull();
		expect(
			await uploadPhoto(db, bob, { gymId: gym, bytes: await smallPng() }, { store, limits, scan })
		).toBeNull();
		expect(transport).toHaveBeenCalledTimes(1);
		expect(await db.select().from(s.llmCalls).where(eq(s.llmCalls.userId, bob))).toEqual([]);
	});

	it('pausing or missing remote credentials cannot bypass safety', async () => {
		const transport = vi.fn<typeof fetch>(async () => remote());
		await expect(upload(scanner('paused', transport))).rejects.toMatchObject({
			reason: 'unavailable'
		});
		await expect(
			upload(scanner('openrouter', transport, { OPENROUTER_API_KEY: '' }))
		).rejects.toMatchObject({ reason: 'unavailable' });
		expect(transport).not.toHaveBeenCalled();
		await nothingStored();
	});
});

describe('mode configuration', () => {
	it('requires both the test runner and test database for the test-only bypass', () => {
		const base = {
			PHOTO_SAFETY_MODE: 'test-pass',
			DATABASE_URL: 'postgresql://localhost/doclifts_test',
			VITEST: 'true'
		};
		expect(safetyConfig(base).mode).toBe('test-pass');
		expect(() => safetyConfig({ ...base, VITEST: '' })).toThrow(PhotoSafetyError);
		expect(() =>
			safetyConfig({ ...base, DATABASE_URL: 'postgresql://localhost/doclifts' })
		).toThrow(PhotoSafetyError);
		expect(safetyConfig({}).mode).toBe('paused');
	});
	it.each([
		{ PHOTO_SAFETY_MODE: 'off' },
		{ PHOTO_SAFETY_TIMEOUT_MS: 'NaN' },
		{ PHOTO_SAFETY_NSFW_THRESHOLD: '0' },
		{ PHOTO_SAFETY_HOURLY_LIMIT: '-1' }
	])('fails closed for invalid configuration %j', (env) => {
		expect(() => safetyConfig(env)).toThrow(PhotoSafetyError);
	});
	it('supports stable A/B cohorts and explicit operator mode changes', () => {
		const choices = Array.from({ length: 100 }, (_, i) => safetyProvider('ab', `test-${i}`));
		expect(new Set(choices)).toEqual(new Set(['local', 'openrouter']));
		for (let i = 0; i < 100; i++) expect(safetyProvider('ab', `test-${i}`)).toBe(choices[i]);
		expect(safetyProvider('local', alice)).toBe('local');
		expect(safetyProvider('openrouter', alice)).toBe('openrouter');
		expect(() => safetyProvider('paused', alice)).toThrow(PhotoSafetyError);
	});
});
