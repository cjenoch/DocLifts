/**
 * analyzePhoto (0.4.0 §4/§7) with the SDK's mock model through a real
 * `complete()` (llm/test-models.ts) and the memory store. No network.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { setupTestDb, resetTestDbWithUsers, type TestDb } from '../test-db';
import * as s from '../db/schema';
import { answeringModel, cappedComplete, scriptedModel, testComplete } from '../llm/test-models';
import {
	complete as defaultComplete,
	LlmNotConfigured,
	LlmProviderError,
	LlmRefused,
	LlmSchemaError
} from '../llm';
import { PhotoSafetyError, scanPhoto } from './safety';
import { MemoryPhotoStore } from './store';
import { PhotoLimitError, uploadPhoto } from './index';
import {
	analysesInLastDay,
	analyzePhoto,
	CANDIDATE_WIRE_SCHEMA,
	EquipmentCandidate,
	PHOTO_PURPOSE,
	SYSTEM_PROMPT,
	userText
} from './analyze';
import { emptyTimings } from './timings';
import {
	ERASED_PROMPT_HASH,
	requestAccountDeletion,
	requestPhotoDeletion,
	runDeletion
} from '../privacy/lifecycle';
import type { LedgerEntry } from '../privacy/ledger';
import {
	CountingPhotoStore,
	FIXTURE_CANDIDATE as CANDIDATE,
	imageSentTo,
	smallPng
} from './test-fixtures';

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
	(await uploadPhoto(db, alice, { gymId, bytes: await smallPng() }, { store, limits }))!.photo;
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
		// What the model was asked for: the plain wire schema, not one derived
		// from zod with every constraint (0.4.4: the derived one was 4x slower).
		const format = model.doGenerateCalls[0].responseFormat as { type: string; schema?: unknown };
		expect(format.type).toBe('json');
		expect(format.schema).toEqual(CANDIDATE_WIRE_SCHEMA);

		const prompt = model.doGenerateCalls[0].prompt;
		expect(prompt[0]).toMatchObject({ role: 'system', content: SYSTEM_PROMPT });
		const parts = (prompt[1] as { content: { type: string; mediaType?: string; text?: string }[] })
			.content;
		expect(parts.map((p) => p.type)).toEqual(['file', 'text']);
		expect(parts[0].mediaType).toBe('image/jpeg');
		expect(parts[1].text).toBe(userText('code is on the seat post'));
	});

	it('a malformed output -> row stays uploaded, llm_call_id names the schema_error call', async () => {
		const photo = await upload();
		const out = await analyzePhoto(db, alice, photo.id, {
			store,
			limits,
			// Wrong types (a number, an array): malformed, not merely incomplete
			// or oddly worded (both tolerated; see the next tests).
			complete: testComplete(answeringModel('{"manufacturer": 42, "loading_type": ["plate"]}'))
		});
		expect(out?.ok).toBe(false);
		expect(out && !out.ok && out.error).toBeInstanceOf(LlmSchemaError);
		const after = await row(photo.id);
		const [call] = await calls(alice);
		expect(call).toMatchObject({ purpose: PHOTO_PURPOSE, status: 'schema_error' });
		// The failed read is recorded on the photo (Phase 2, 2f), so the workout
		// page can show it as failed after a reload.
		expect(after).toMatchObject({ status: 'uploaded', candidate: null, llmCallId: call.id });
	});

	it('a failed re-read keeps the call that produced the candidate', async () => {
		const photo = await upload();
		await analyzePhoto(db, alice, photo.id, {
			store,
			limits,
			complete: testComplete(answeringModel(JSON.stringify(CANDIDATE)))
		});
		const [ok] = await calls(alice);
		expect((await row(photo.id)).llmCallId).toBe(ok.id);
		const out = await analyzePhoto(db, alice, photo.id, {
			store,
			limits,
			complete: testComplete(answeringModel('{"manufacturer": 42}'))
		});
		expect(out?.ok).toBe(false);
		expect(await row(photo.id)).toMatchObject({
			status: 'analyzed',
			candidate: CANDIDATE,
			llmCallId: ok.id
		});
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

	it("a reply in the model's own words maps to the allowed values, not a refusal", async () => {
		// Production, 2026-10-01: both readings right, both refused.
		const replies = [
			[{ loading_type: 'plate_loaded', laterality: 'iso-lateral' }, 'plate_loaded', 'independent'],
			[{ loading_type: 'weight_stack', laterality: 'unknown' }, 'selectorized', 'unknown'],
			[{ loading_type: 'Weight Stack', laterality: 'Bilateral' }, 'selectorized', 'bilateral'],
			[{ loading_type: 'hydraulic', laterality: 'sideways' }, 'unknown', 'unknown']
		] as const;
		for (const [words, loading, laterality] of replies) {
			const photo = await upload();
			const out = await analyzePhoto(db, alice, photo.id, {
				store,
				limits,
				complete: testComplete(
					answeringModel(JSON.stringify({ manufacturer: 'HAMMER STRENGTH', ...words }))
				)
			});
			expect(out, JSON.stringify(words)).toMatchObject({ ok: true });
			expect((await row(photo.id)).candidate).toMatchObject({
				loading_type: loading,
				laterality
			});
		}
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
		const [refused] = await calls(alice);
		expect(refused).toMatchObject({ status: 'refused', errorCode: 'not_configured' });
		expect((await row(photo.id)).llmCallId).toBe(refused.id);
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

	describe('the image handed over on upload (0.5.3)', () => {
		it('given the image, analysis does not read the store; without it, it does', async () => {
			const counting = new CountingPhotoStore();
			const uploaded = (await uploadPhoto(
				db,
				alice,
				{ gymId, bytes: await smallPng() },
				{ store: counting, limits }
			))!;
			const model = answeringModel(JSON.stringify(CANDIDATE));
			const handed = await analyzePhoto(db, alice, uploaded.photo.id, {
				store: counting,
				limits,
				image: uploaded.image,
				complete: testComplete(model)
			});
			expect(handed).toMatchObject({ ok: true, candidate: CANDIDATE });
			expect(counting.gets).toBe(0);

			// The retry path: no image given, so it is read from the store.
			const read = await analyzePhoto(db, alice, uploaded.photo.id, {
				store: counting,
				limits,
				complete: testComplete(model)
			});
			expect(read).toMatchObject({ ok: true, candidate: CANDIDATE });
			expect(counting.gets).toBe(1);
		});

		it('the result is the same whether the image is handed over or read back', async () => {
			const uploaded = (await uploadPhoto(
				db,
				alice,
				{ gymId, bytes: await smallPng() },
				{ store, limits }
			))!;
			const model = answeringModel(JSON.stringify(CANDIDATE));
			const handed = await analyzePhoto(db, alice, uploaded.photo.id, {
				store,
				limits,
				image: uploaded.image,
				complete: testComplete(model)
			});
			const handedRow = await row(uploaded.photo.id);
			const read = await analyzePhoto(db, alice, uploaded.photo.id, {
				store,
				limits,
				complete: testComplete(model)
			});
			const readRow = await row(uploaded.photo.id);

			// Same bytes sent to the model, and they are the stored image.
			const stored = imageSentTo(model, 1);
			expect(stored.byteLength).toBe(uploaded.photo.bytes);
			expect(imageSentTo(model, 0).equals(stored)).toBe(true);
			// Same candidate, returned and stored.
			expect(handed && handed.ok && handed.candidate).toEqual(CANDIDATE);
			expect(read && read.ok && read.candidate).toEqual(CANDIDATE);
			expect(handedRow.candidate).toEqual(readRow.candidate);
			expect(readRow.status).toBe('analyzed');
		});

		it('records the model call time, whether the call succeeds or fails', async () => {
			const photo = await upload();
			const ok = emptyTimings();
			await analyzePhoto(db, alice, photo.id, {
				store,
				limits,
				timings: ok,
				complete: testComplete(answeringModel(JSON.stringify(CANDIDATE)))
			});
			expect(Number.isInteger(ok.modelMs) && ok.modelMs! >= 0).toBe(true);

			const failed = emptyTimings();
			const out = await analyzePhoto(db, alice, photo.id, {
				store,
				limits,
				timings: failed,
				complete: testComplete(answeringModel('{}'), {})
			});
			expect(out?.ok).toBe(false);
			expect(Number.isInteger(failed.modelMs) && failed.modelMs! >= 0).toBe(true);
			// Analysis is not where processing or storing happens.
			expect(failed).toMatchObject({ processMs: null, storePutMs: null });
		});
	});
});

/**
 * Identification's retry (2026-11-09): the first production photo error after
 * PR #65 was an OpenRouter 429 the next calls survived. One automatic retry of
 * a 429/502/503 against the SAVED photo (no new upload, row, store write,
 * processing or safety scan), each attempt its own llm_calls row; after that,
 * a retryable outcome and "Retry identification" on the same photo.
 */
describe('identification retry', () => {
	const OK = { text: JSON.stringify(CANDIDATE) };
	/** No real waits: the sleep records and returns. */
	const waits: number[] = [];
	const retry = {
		sleep: async (ms: number) => void waits.push(ms),
		random: () => 0
	};
	let counting: CountingPhotoStore;
	beforeEach(() => {
		waits.length = 0;
		counting = new CountingPhotoStore();
	});

	/** One photo through the real upload, as the gym page does it; the image is handed over. */
	async function uploaded() {
		const result = (await uploadPhoto(
			db,
			alice,
			{ gymId, bytes: await smallPng() },
			{ store: counting, limits }
		))!;
		expect(counting.puts).toBe(1);
		return result;
	}
	const photoRows = () =>
		db.select().from(s.equipmentPhotos).where(eq(s.equipmentPhotos.userId, alice));
	const objectRows = () => db.select().from(s.photoObjects).where(eq(s.photoObjects.userId, alice));
	const callRows = async () =>
		(await calls(alice))
			.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
			.map((c) => ({ id: c.id, status: c.status, errorCode: c.errorCode }));

	it('429 then ok: identified on the second attempt; two rows; one photo, one object, one write', async () => {
		const { photo, image } = await uploaded();
		const model = scriptedModel([{ status: 429 }, OK]);
		const out = await analyzePhoto(db, alice, photo.id, {
			store: counting,
			limits,
			image,
			complete: testComplete(model),
			retry
		});
		expect(out).toMatchObject({ ok: true, candidate: CANDIDATE });
		const rows = await callRows();
		expect(rows.map((r) => [r.status, r.errorCode])).toEqual([
			['provider_error', 'http_429'],
			['ok', null]
		]);
		expect(await row(photo.id)).toMatchObject({ status: 'analyzed', llmCallId: rows[1].id });
		// Both attempts sent the same stored image: never re-uploaded, re-stored or re-read.
		expect(imageSentTo(model, 0)).toEqual(imageSentTo(model, 1));
		expect(await photoRows()).toHaveLength(1);
		expect(await objectRows()).toHaveLength(1);
		expect(counting.keys()).toHaveLength(1);
		expect([counting.puts, counting.gets]).toEqual([1, 0]);
		expect(waits).toEqual([1000]); // 1 s, jitter 0 here
	});

	it('503 twice: retryable, two rows, the photo kept; Retry identification reads the same photo', async () => {
		const { photo, image } = await uploaded();
		const out = await analyzePhoto(db, alice, photo.id, {
			store: counting,
			limits,
			image,
			complete: testComplete(scriptedModel([{ status: 503 }, { status: 503 }])),
			retry
		});
		expect(out).toMatchObject({ ok: false, retryable: true });
		const rows = await callRows();
		expect(rows.map((r) => r.errorCode)).toEqual(['http_503', 'http_503']);
		// The photo is saved and waiting: uploaded, its last read on record.
		expect(await row(photo.id)).toMatchObject({ status: 'uploaded', llmCallId: rows[1].id });

		// "Retry identification": the same photo id, read back from the store once.
		const again = await analyzePhoto(db, alice, photo.id, {
			store: counting,
			limits,
			complete: testComplete(scriptedModel([OK])),
			retry
		});
		expect(again).toMatchObject({ ok: true, candidate: CANDIDATE });
		expect(await row(photo.id)).toMatchObject({ status: 'analyzed', candidate: CANDIDATE });
		expect(await photoRows()).toHaveLength(1);
		expect(await objectRows()).toHaveLength(1);
		expect([counting.puts, counting.gets]).toEqual([1, 1]);
		expect(await callRows()).toHaveLength(3);
	});

	it('honors Retry-After; one past the 45 s budget means no wait, one attempt, retryable', async () => {
		const { photo, image } = await uploaded();
		const run = (answers: Parameters<typeof scriptedModel>[0]) => {
			const model = scriptedModel(answers);
			return {
				model,
				out: analyzePhoto(db, alice, photo.id, {
					store: counting,
					limits,
					image,
					complete: testComplete(model),
					retry
				})
			};
		};
		const waited = run([{ status: 429, retryAfter: '7' }, OK]);
		expect(await waited.out).toMatchObject({ ok: true });
		expect(waits).toEqual([7000]);

		waits.length = 0;
		await db
			.update(s.equipmentPhotos)
			.set({ status: 'uploaded', candidate: null })
			.where(eq(s.equipmentPhotos.id, photo.id));
		const tooLong = run([{ status: 429, retryAfter: '120' }, OK]);
		expect(await tooLong.out).toMatchObject({ ok: false, retryable: true });
		expect(waits).toEqual([]);
		expect(tooLong.model.doGenerateCalls).toHaveLength(1);
	});

	it.each([
		['401', [{ status: 401 }, OK]],
		['403', [{ status: 403 }, OK]],
		['500', [{ status: 500 }, OK]],
		['a schema miss', [{ text: '{"manufacturer": 42}' }, OK]]
	] as const)('%s: one attempt, not retryable', async (_name, answers) => {
		const { photo, image } = await uploaded();
		const model = scriptedModel([...answers]);
		const out = await analyzePhoto(db, alice, photo.id, {
			store: counting,
			limits,
			image,
			complete: testComplete(model),
			retry
		});
		expect(out).toMatchObject({ ok: false, retryable: false });
		expect(model.doGenerateCalls).toHaveLength(1);
		expect(await calls(alice)).toHaveLength(1);
		expect(waits).toEqual([]);
	});

	it('the hourly cap counts the retry: with a cap of 1 it is refused and recorded, not retryable', async () => {
		const { photo, image } = await uploaded();
		const model = scriptedModel([{ status: 429 }, OK]);
		const out = await analyzePhoto(db, alice, photo.id, {
			store: counting,
			limits,
			image,
			complete: cappedComplete(model, 1),
			retry
		});
		expect(out).toMatchObject({ ok: false, retryable: false });
		expect(out && !out.ok && out.error).toBeInstanceOf(LlmRefused);
		expect(model.doGenerateCalls).toHaveLength(1);
		const rows = await callRows();
		expect(rows.map((r) => [r.status, r.errorCode])).toEqual([
			['provider_error', 'http_429'],
			['refused', 'hourly_cap']
		]);
		// The photo's last read is the refusal: the page shows the ordinary failure.
		expect((await row(photo.id)).llmCallId).toBe(rows[1].id);
	});

	it('the daily limit holds the retry too: at the last analysis, a 429 is not retried', async () => {
		const { photo, image } = await uploaded();
		const model = scriptedModel([{ status: 429 }, OK]);
		const out = await analyzePhoto(db, alice, photo.id, {
			store: counting,
			limits: { ...limits, dailyLimit: 1 },
			image,
			complete: testComplete(model),
			retry
		});
		expect(out).toMatchObject({ ok: false, retryable: true });
		expect(model.doGenerateCalls).toHaveLength(1);
		expect(await analysesInLastDay(db, alice)).toBe(1);
	});

	it('the safety scan is never retried: a 429 from it is one call and the photo is not saved', async () => {
		let scans = 0;
		const scanner: typeof defaultComplete = async (_db, _user, request) => {
			scans++;
			expect(request.purpose).toBe('photo_safety');
			throw new LlmProviderError('http_429', 'no-row', { status: 429 });
		};
		const blocked: typeof defaultComplete = async () => {
			scans++;
			return { output: { allowed: false } as never, callId: 'no-row' };
		};
		const env = { PHOTO_SAFETY_MODE: 'openrouter' };
		for (const complete of [scanner, blocked]) {
			scans = 0;
			await expect(
				uploadPhoto(
					db,
					alice,
					{ gymId, bytes: await smallPng() },
					{
						store: counting,
						limits,
						scan: (d, u, image) => scanPhoto(d, u, image, { env, complete })
					}
				)
			).rejects.toBeInstanceOf(PhotoSafetyError);
			expect(scans).toBe(1);
		}
		expect(await photoRows()).toHaveLength(0);
		expect(counting.puts).toBe(0);
	});
});

/**
 * Owner review P2 (PR #62): removing a photo deleted its llm_calls row, which
 * dropped the 24-hour analysis count and refunded the daily cap — for failed
 * reads (linked since this PR) and successful ones (linked since 0.4.0). The
 * erasure now keeps the row as usage metadata with every detail cleared.
 */
describe('the analysis cap survives photo removal', () => {
	const one = { ...limits, dailyLimit: 1 };
	const journal: LedgerEntry[] = [];
	const ledger = { append: async (e: LedgerEntry) => void journal.push(e) };
	const malformed = '{"manufacturer": 42, "loading_type": ["plate"]}';
	const callRow = async (id: string) =>
		(await db.select().from(s.llmCalls).where(eq(s.llmCalls.id, id)))[0];
	const objectRows = (key: string) =>
		db.select().from(s.photoObjects).where(eq(s.photoObjects.storageKey, key));

	/** The review page's "Remove saved photo": request, then one bounded pass. */
	async function removeLikeReviewPage(photoId: string) {
		const job = await requestPhotoDeletion(db, alice, photoId, ledger);
		expect(job).not.toBeNull();
		expect((await runDeletion(db, alice, job!.id, store, ledger, 1)).state).toBe('completed');
	}

	/** A further analysis at a limit of one: refused, and no model is called. */
	async function expectCapStillHolds() {
		const next = await upload();
		const model = answeringModel(JSON.stringify(CANDIDATE));
		await expect(
			analyzePhoto(db, alice, next.id, { store, limits: one, complete: testComplete(model) })
		).rejects.toBeInstanceOf(PhotoLimitError);
		expect(model.doGenerateCalls).toHaveLength(0);
	}

	for (const [name, reply, status] of [
		['a failed read (malformed output)', malformed, 'schema_error'],
		['a successful read', JSON.stringify(CANDIDATE), 'ok']
	] as const)
		it(`${name}: removing its photo keeps the cap and keeps no image or model output`, async () => {
			const first = await upload();
			await analyzePhoto(db, alice, first.id, {
				store,
				limits: one,
				complete: testComplete(answeringModel(reply))
			});
			const [call] = await calls(alice);
			// Positive first: the call is recorded, linked, carries its output, and counts.
			expect(call).toMatchObject({ purpose: PHOTO_PURPOSE, status });
			expect(call.output).not.toBeNull();
			expect((await row(first.id)).llmCallId).toBe(call.id);
			expect(await analysesInLastDay(db, alice)).toBe(1);
			await expectCapStillHolds();

			// Another user cannot request the removal; nothing changes.
			expect(await requestPhotoDeletion(db, bob, first.id, ledger)).toBeNull();
			expect(await callRow(call.id)).toEqual(call);

			await removeLikeReviewPage(first.id);

			// The photo, its inventory row and its object are gone.
			expect(await row(first.id)).toBeUndefined();
			expect(await objectRows(first.storageKey)).toEqual([]);
			expect(await store.get(first.storageKey)).toBeNull();
			// The call stays as usage metadata only.
			const kept = await callRow(call.id);
			expect(kept).toEqual({
				...call,
				output: null,
				promptText: null,
				errorCode: null,
				promptHash: ERASED_PROMPT_HASH
			});
			// ...so the 24-hour count does not drop, and the cap still refuses.
			expect(await analysesInLastDay(db, alice)).toBe(1);
			await expectCapStillHolds();
			expect(await calls(alice)).toHaveLength(1);
		});

	it('account deletion still removes every llm_calls row, kept or still linked', async () => {
		const kept = await upload();
		const pending = await upload();
		for (const photo of [kept, pending])
			await analyzePhoto(db, alice, photo.id, {
				store,
				limits,
				complete: testComplete(answeringModel(JSON.stringify(CANDIDATE)))
			});
		const keptCall = (await row(kept.id)).llmCallId!;
		const pendingCall = (await row(pending.id)).llmCallId!;
		await removeLikeReviewPage(kept.id);
		expect(await callRow(keptCall)).toMatchObject({ output: null, status: 'ok' });

		// A photo job still pending when the account is fenced: the fence refuses an
		// update to llm_calls, so this erasure deletes the call instead of failing.
		const photoJob = await requestPhotoDeletion(db, alice, pending.id, ledger);
		const sessionId = crypto.randomUUID();
		await db.insert(s.authSessions).values({
			id: sessionId,
			userId: alice,
			token: crypto.randomUUID(),
			expiresAt: new Date(Date.now() + 86400000)
		});
		const accountJob = await requestAccountDeletion(db, alice, sessionId, ledger);
		expect(accountJob).not.toBeNull();
		expect((await runDeletion(db, alice, photoJob!.id, store, ledger, 1)).state).toBe('completed');
		expect(await callRow(pendingCall)).toBeUndefined();
		expect(await callRow(keptCall)).toBeDefined();

		expect((await runDeletion(db, alice, accountJob!.id, store, ledger)).state).toBe('completed');
		expect(await calls(alice)).toEqual([]);
	});
});
