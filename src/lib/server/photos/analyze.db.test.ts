/**
 * analyzePhoto (0.4.0 §4/§7) with the SDK's mock model through a real
 * `complete()` (llm/test-models.ts) and the memory store. No network.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { setupTestDb, resetTestDbWithUsers, type TestDb } from '../test-db';
import * as s from '../db/schema';
import { answeringModel, testComplete } from '../llm/test-models';
import { LlmNotConfigured, LlmSchemaError } from '../llm';
import { MemoryPhotoStore } from './store';
import { PhotoLimitError, uploadPhoto } from './index';
import {
	analyzePhoto,
	EquipmentCandidate,
	PHOTO_PURPOSE,
	SYSTEM_PROMPT,
	userText
} from './analyze';
import { FIXTURE_CANDIDATE as CANDIDATE, smallPng } from './test-fixtures';

let db: TestDb;
let handle: Awaited<ReturnType<typeof setupTestDb>>;
let alice: string;
let bob: string;
let gymId: string;
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
	[{ id: alice }, { id: bob }] = await resetTestDbWithUsers(db, handle.client, 2, 'analyze');
	[{ id: gymId }] = await db.insert(s.gyms).values({ name: 'Gym', userId: alice }).returning();
	store = new MemoryPhotoStore();
});

const upload = async () =>
	(await uploadPhoto(db, alice, { gymId, bytes: await smallPng() }, { store, limits }))!;
const row = async (id: string) =>
	(await db.select().from(s.equipmentPhotos).where(eq(s.equipmentPhotos.id, id)))[0];
const calls = (userId: string) => db.select().from(s.llmCalls).where(eq(s.llmCalls.userId, userId));

describe('analyzePhoto', () => {
	it('a fixture candidate -> row analyzed, candidate stored, llm_call_id names the ok call', async () => {
		const photo = await upload();
		const model = answeringModel(JSON.stringify(CANDIDATE));
		const out = await analyzePhoto(db, alice, photo.id, {
			store,
			limits,
			note: 'code is on the seat post',
			complete: testComplete(model)
		});
		expect(out).toMatchObject({ ok: true, candidate: CANDIDATE });
		const after = await row(photo.id);
		expect(after.status).toBe('analyzed');
		expect(after.candidate).toEqual(CANDIDATE);
		const [call] = await calls(alice);
		expect(after.llmCallId).toBe(call.id);
		expect(call).toMatchObject({
			purpose: PHOTO_PURPOSE,
			status: 'ok',
			model: 'test/vision-model'
		});

		// What was sent: the system prompt, the stored JPEG, and the note.
		const prompt = model.doGenerateCalls[0].prompt;
		expect(prompt[0]).toMatchObject({ role: 'system', content: SYSTEM_PROMPT });
		const parts = (prompt[1] as { content: { type: string; mediaType?: string; text?: string }[] })
			.content;
		expect(parts.map((p) => p.type)).toEqual(['file', 'text']);
		expect(parts[0].mediaType).toBe('image/jpeg');
		expect(parts[1].text).toBe(userText('code is on the seat post'));
	});

	it('a malformed output -> row stays uploaded, llm_calls has schema_error', async () => {
		const photo = await upload();
		const out = await analyzePhoto(db, alice, photo.id, {
			store,
			limits,
			// Wrong type and an out-of-set loading type: malformed, not merely
			// incomplete (missing keys are tolerated; see the next test).
			complete: testComplete(answeringModel('{"manufacturer": 42, "loading_type": "hydraulic"}'))
		});
		expect(out?.ok).toBe(false);
		expect(out && !out.ok && out.error).toBeInstanceOf(LlmSchemaError);
		const after = await row(photo.id);
		expect(after).toMatchObject({ status: 'uploaded', candidate: null, llmCallId: null });
		const [call] = await calls(alice);
		expect(call).toMatchObject({ purpose: PHOTO_PURPOSE, status: 'schema_error' });
	});

	it('a reply that leaves keys out is analyzed, the missing ones read as unknown', async () => {
		// Production's first analysis, 2026-10-01, verbatim except values: the
		// placard read perfectly, product_line absent, and it was refused.
		const reply = {
			manufacturer: 'HAMMER STRENGTH',
			model_code: 'IL-ROW',
			name: 'ISO-LATERAL ROW',
			loading_type: 'unknown',
			laterality: 'unknown',
			starting_resistance_lb: null,
			stack_lb: null,
			placard_text: 'HAMMER STRENGTH\nISO-LATERAL ROW\nIL-ROW',
			notes: 'Only the placard is visible.',
			field_confidence: { manufacturer: 1, model_code: 1, name: 1, loading_type: 1 }
		};
		const photo = await upload();
		const out = await analyzePhoto(db, alice, photo.id, {
			store,
			limits,
			complete: testComplete(answeringModel(JSON.stringify(reply)))
		});
		expect(out).toMatchObject({ ok: true });
		const after = await row(photo.id);
		expect(after.status).toBe('analyzed');
		expect(after.candidate).toMatchObject({
			manufacturer: 'HAMMER STRENGTH',
			model_code: 'IL-ROW',
			product_line: null
		});
		const [call] = await calls(alice);
		expect(call).toMatchObject({ purpose: PHOTO_PURPOSE, status: 'ok' });

		// The bare minimum: every key absent still parses, as "nothing read".
		expect(EquipmentCandidate.parse({})).toMatchObject({
			placard_text: '',
			manufacturer: null,
			loading_type: 'unknown',
			laterality: 'unknown',
			field_confidence: { manufacturer: 0, model_code: 0, name: 0, loading_type: 0 },
			notes: ''
		});
	});

	it('with no LLM configured: not_configured is recorded and the row stays uploaded', async () => {
		const photo = await upload();
		const out = await analyzePhoto(db, alice, photo.id, {
			store,
			limits,
			complete: testComplete(answeringModel('{}'), {})
		});
		expect(out && !out.ok && out.error).toBeInstanceOf(LlmNotConfigured);
		expect((await row(photo.id)).status).toBe('uploaded');
		expect(await calls(alice)).toMatchObject([{ status: 'refused', errorCode: 'not_configured' }]);
	});

	it('re-analysis replaces the candidate; a stored value round-trips through the schema', async () => {
		const photo = await upload();
		await analyzePhoto(db, alice, photo.id, {
			store,
			limits,
			complete: testComplete(answeringModel(JSON.stringify(CANDIDATE)))
		});
		const second = { ...CANDIDATE, model_code: 'IL-ROW2' };
		await analyzePhoto(db, alice, photo.id, {
			store,
			limits,
			complete: testComplete(answeringModel(JSON.stringify(second)))
		});
		const after = await row(photo.id);
		expect(after.candidate).toEqual(second);
		expect(EquipmentCandidate.parse(after.candidate)).toEqual(second);
		expect(await calls(alice)).toHaveLength(2);
	});

	it('returns the owner an analysis, and nothing to another user (no call made)', async () => {
		const photo = await upload();
		const model = answeringModel(JSON.stringify(CANDIDATE));
		const theirs = await analyzePhoto(db, bob, photo.id, {
			store,
			limits,
			complete: testComplete(model)
		});
		const mine = await analyzePhoto(db, alice, photo.id, {
			store,
			limits,
			complete: testComplete(model)
		});
		expect(mine?.ok).toBe(true);
		expect(theirs).toBeNull();
		expect(model.doGenerateCalls).toHaveLength(1);
		expect(await calls(bob)).toEqual([]);
	});

	it('the analysis cap counts calls that reached the provider in the last 24 h', async () => {
		const photo = await upload();
		const two = { ...limits, dailyLimit: 2 };
		const ok = () =>
			analyzePhoto(db, alice, photo.id, {
				store,
				limits: two,
				complete: testComplete(answeringModel(JSON.stringify(CANDIDATE)))
			});
		// A refused (not configured) call does not count.
		await analyzePhoto(db, alice, photo.id, {
			store,
			limits: two,
			complete: testComplete(answeringModel('{}'), {})
		});
		await ok();
		await ok();
		await expect(ok()).rejects.toBeInstanceOf(PhotoLimitError);
		expect(await calls(alice)).toHaveLength(3);
	});

	it('a discarded or confirmed photo is not analyzed', async () => {
		const photo = await upload();
		await db
			.update(s.equipmentPhotos)
			.set({ status: 'discarded' })
			.where(eq(s.equipmentPhotos.id, photo.id));
		const model = answeringModel(JSON.stringify(CANDIDATE));
		expect(
			await analyzePhoto(db, alice, photo.id, { store, limits, complete: testComplete(model) })
		).toBeNull();
		expect(model.doGenerateCalls).toHaveLength(0);
	});
});
