/**
 * complete() and usageForUser(), entirely offline: every model here is the
 * SDK's own MockLanguageModelV4 (`ai/test`), injected through
 * createLlmClient's `model` option. No test reaches a network — the provider
 * factory is never called, and the one test of the exported `complete()`
 * blanks every LLM variable first so it cannot find a key.
 *
 * The invariant these prove: an `llm_calls` row exists on every path, and the
 * typed error's `callId` names it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { setupTestDb, resetTestDbWithUsers, type TestDb } from '../test-db';
import { llmCalls } from '../db/schema';
import {
	complete as defaultComplete,
	createLlmClient,
	LlmNotConfigured,
	LlmProviderError,
	LlmRefused,
	LlmSchemaError,
	LlmTimeout,
	usageForUser,
	type CompleteRequest
} from './index';
import { promptHash } from './prompt';
import { LLM_ENV, llmConfigLogLine, resolveLlmConfig, type Env } from './config';

let db: TestDb;
let handle: Awaited<ReturnType<typeof setupTestDb>>;
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
	[{ id: alice }, { id: bob }] = await resetTestDbWithUsers(db, handle.client, 2, 'llm');
});
afterEach(() => {
	vi.unstubAllEnvs();
});

/** Not a real key; asserted never to appear in a row, a log line, or an error. */
const FAKE_KEY = 'sk-or-v1-test-not-a-real-key-0000';

const ENV: Env = {
	[LLM_ENV.apiKey]: FAKE_KEY,
	[LLM_ENV.model]: 'test/text-model',
	[LLM_ENV.visionModel]: 'test/vision-model'
};

const usage = (input: number, output: number) => ({
	inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
	outputTokens: { total: output, text: output, reasoning: undefined }
});

/** A mock that answers `text`, with a provider response id. */
function answering(text: string, onCall?: () => void) {
	return new MockLanguageModelV4({
		doGenerate: async () => {
			onCall?.();
			return {
				content: [{ type: 'text', text }],
				finishReason: { unified: 'stop', raw: undefined },
				usage: usage(11, 7),
				response: { id: 'gen-provider-123' },
				warnings: []
			};
		}
	});
}

const schema = z.object({ ok: z.boolean(), model: z.string() });

const request = (over: Partial<CompleteRequest<z.infer<typeof schema>>> = {}) => ({
	purpose: 'ping',
	system: 'You are a test.',
	messages: [{ role: 'user' as const, content: 'Reply with ok true.' }],
	schema,
	...over
});

/** A client over a mock, a fixed env, and a clock the test moves. */
function client(model: MockLanguageModelV4, env: Env = ENV) {
	const clock = { t: 1_000_000 };
	const logs: string[] = [];
	const llm = createLlmClient({
		env,
		model: () => model,
		now: () => clock.t,
		log: (line) => logs.push(line)
	});
	return { llm, clock, logs };
}

const rowsFor = (userId: string) =>
	db.select().from(llmCalls).where(eq(llmCalls.userId, userId)).orderBy(llmCalls.createdAt);

/** `llm_calls.output` as Postgres holds it: its jsonb type and its text. */
async function storedOutput(id: string) {
	const [r] = await handle.client<{ type: string; text: string }[]>`
		SELECT jsonb_typeof(output) AS type, output #>> '{}' AS text FROM llm_calls WHERE id = ${id}`;
	return r;
}

/** Run `fn`, expect it to throw `type`, and return the error. */
async function caught<E extends Error>(
	fn: () => Promise<unknown>,
	type: new (...args: never[]) => E
): Promise<E> {
	try {
		await fn();
	} catch (error) {
		expect(error).toBeInstanceOf(type);
		return error as E;
	}
	throw new Error(`expected ${type.name}, nothing was thrown`);
}

describe('complete(): ok', () => {
	it('returns the parsed object and records tokens, latency, request id and prompt hash', async () => {
		const model = answering('{"ok":true,"model":"test/text-model"}');
		const { llm, clock } = client(model);
		model.doGenerate = (async (opts: Parameters<typeof model.doGenerate>[0]) => {
			clock.t += 250; // the provider takes 250 ms
			return answering('{"ok":true,"model":"test/text-model"}').doGenerate(opts);
		}) as typeof model.doGenerate;

		const req = request();
		const result = await llm.complete(db, alice, req);
		expect(result.output).toEqual({ ok: true, model: 'test/text-model' });

		const [row] = await rowsFor(alice);
		expect(row).toMatchObject({
			id: result.callId,
			userId: alice,
			purpose: 'ping',
			provider: 'openrouter',
			model: 'test/text-model',
			requestId: 'gen-provider-123',
			status: 'ok',
			errorCode: null,
			promptTokens: 11,
			completionTokens: 7,
			latencyMs: 250,
			output: { ok: true, model: 'test/text-model' },
			promptHash: promptHash(req.system, req.messages),
			promptText: null
		});
		expect(row.promptHash).toMatch(/^[0-9a-f]{16}$/);
	});

	it('sends the system prompt as instructions and the messages as given', async () => {
		const model = answering('{"ok":true,"model":"m"}');
		const { llm } = client(model);
		await llm.complete(db, alice, request());
		const prompt = model.doGenerateCalls[0].prompt;
		expect(prompt[0]).toMatchObject({ role: 'system', content: 'You are a test.' });
		expect(prompt[1]).toMatchObject({ role: 'user' });
		expect(JSON.stringify(prompt[1])).toContain('Reply with ok true.');
	});

	it('stores prompt text only with LLM_STORE_PROMPTS=1, and never image bytes', async () => {
		const image = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);
		const req = request({
			messages: [
				{
					role: 'user',
					content: [
						{ type: 'text', text: 'What machine is this?' },
						{ type: 'image', image, mediaType: 'image/png' }
					]
				}
			]
		});

		const off = client(answering('{"ok":true,"model":"m"}'));
		await off.llm.complete(db, alice, req);
		const on = client(answering('{"ok":true,"model":"m"}'), {
			...ENV,
			[LLM_ENV.storePrompts]: '1'
		});
		await on.llm.complete(db, alice, req);

		const [withoutFlag, withFlag] = await rowsFor(alice);
		expect(withFlag.promptText).toContain('You are a test.');
		expect(withFlag.promptText).toContain('What machine is this?');
		expect(withFlag.promptText).toMatch(/"image":"sha256:[0-9a-f]{64}"/);
		expect(withFlag.promptText).not.toContain(Buffer.from(image).toString('base64'));
		expect(withoutFlag.promptText).toBeNull();
		// Same prompt, same hash, flag or not.
		expect(withoutFlag.promptHash).toBe(withFlag.promptHash);
	});

	it('uses LLM_VISION_MODEL for kind vision, and LLM_MODEL when it is unset', async () => {
		await client(answering('{"ok":true,"model":"m"}')).llm.complete(
			db,
			alice,
			request({ kind: 'vision' })
		);
		const noVision = { ...ENV, [LLM_ENV.visionModel]: undefined };
		await client(answering('{"ok":true,"model":"m"}'), noVision).llm.complete(
			db,
			alice,
			request({ kind: 'vision' })
		);
		expect((await rowsFor(alice)).map((r) => r.model)).toEqual([
			'test/vision-model',
			'test/text-model'
		]);
	});

	it('keeps zod jitless after a call through the SDK', async () => {
		await client(answering('{"ok":true,"model":"m"}')).llm.complete(db, alice, request());
		expect(z.config().jitless).toBe(true);
	});
});

describe('complete(): every failure still writes its row', () => {
	it('schema mismatch: schema_error row with the raw text, LlmSchemaError thrown', async () => {
		const raw = '{"ok":"yes","model":42}';
		const { llm } = client(answering(raw));
		const error = await caught(() => llm.complete(db, alice, request()), LlmSchemaError);
		expect(error.rawText).toBe(raw);

		const [row] = await rowsFor(alice);
		expect(row).toMatchObject({
			id: error.callId,
			status: 'schema_error',
			promptTokens: 11,
			completionTokens: 7,
			requestId: 'gen-provider-123'
		});
		// Read in SQL: drizzle's jsonb reader JSON.parses any string it gets
		// back, so a stored JSON *string* that looks like JSON reads as an object.
		expect(await storedOutput(row.id)).toEqual({ type: 'string', text: raw });
	});

	it('text that is not JSON at all is a schema_error too', async () => {
		const { llm } = client(answering('Sure! ok is true.'));
		const error = await caught(() => llm.complete(db, alice, request()), LlmSchemaError);
		const [row] = await rowsFor(alice);
		expect(row).toMatchObject({ id: error.callId, status: 'schema_error' });
		expect(await storedOutput(row.id)).toEqual({ type: 'string', text: 'Sure! ok is true.' });
	});

	it('provider error: provider_error row with the HTTP status code, error thrown', async () => {
		const model = new MockLanguageModelV4({
			doGenerate: async () => {
				throw new APICallError({
					message: `upstream exploded; key ${FAKE_KEY}`,
					url: 'https://provider.invalid/v1/chat',
					requestBodyValues: {},
					statusCode: 502,
					isRetryable: true
				});
			}
		});
		const { llm } = client(model);
		const error = await caught(() => llm.complete(db, alice, request()), LlmProviderError);
		expect(error.code).toBe('http_502');
		expect(error.message).not.toContain(FAKE_KEY);
		expect(model.doGenerateCalls).toHaveLength(1); // one attempt, no retries

		const rows = await rowsFor(alice);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			id: error.callId,
			status: 'provider_error',
			errorCode: 'http_502',
			output: null
		});
	});

	it('timeout: timeout row, LlmTimeout thrown, even when the provider ignores the abort', async () => {
		const model = new MockLanguageModelV4({
			doGenerate: () => new Promise(() => {}) // never settles, ignores its signal
		});
		const { llm } = client(model, { ...ENV, [LLM_ENV.timeoutMs]: '40' });
		const started = Date.now();
		const error = await caught(() => llm.complete(db, alice, request()), LlmTimeout);
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(error.timeoutMs).toBe(40);
		expect(model.doGenerateCalls[0].abortSignal?.aborted).toBe(true);

		const [row] = await rowsFor(alice);
		expect(row).toMatchObject({ id: error.callId, status: 'timeout', errorCode: 'timeout' });
	});
});

describe('complete(): per-user hourly cap', () => {
	it('refuses the 61st call in an hour, logs it, and never reaches the model', async () => {
		let reached = 0;
		const model = answering('{"ok":true,"model":"m"}', () => reached++);
		const { llm, clock } = client(model); // no LLM_MAX_CALLS_PER_USER_PER_HOUR: default 60

		for (let i = 0; i < 60; i++) {
			await llm.complete(db, alice, request());
			clock.t += 1000;
		}
		expect(reached).toBe(60);

		const error = await caught(() => llm.complete(db, alice, request()), LlmRefused);
		expect(error.limit).toBe(60);
		expect(reached).toBe(60); // the 61st never reached the model

		const rows = await rowsFor(alice);
		expect(rows).toHaveLength(61);
		const refused = rows.filter((r) => r.status === 'refused');
		expect(refused).toHaveLength(1);
		expect(refused[0]).toMatchObject({ id: error.callId, errorCode: 'hourly_cap' });

		// The cap is per user: bob is unaffected.
		await llm.complete(db, bob, request());
		expect(reached).toBe(61);

		// It is a sliding hour: once the first call is an hour old, one more fits.
		clock.t += 60 * 60 * 1000 - 60 * 1000 + 1;
		await llm.complete(db, alice, request());
		expect(reached).toBe(62);
	});

	it('LLM_MAX_CALLS_PER_USER_PER_HOUR=0 refuses every call', async () => {
		let reached = 0;
		const { llm } = client(
			answering('{"ok":true,"model":"m"}', () => reached++),
			{
				...ENV,
				[LLM_ENV.maxCallsPerUserPerHour]: '0'
			}
		);
		await caught(() => llm.complete(db, alice, request()), LlmRefused);
		expect(reached).toBe(0);
	});
});

describe('usageForUser', () => {
	it('returns the owner their own calls and tokens, and nothing of another user', async () => {
		const { llm } = client(answering('{"ok":true,"model":"m"}'));
		await llm.complete(db, alice, request());
		await llm.complete(db, alice, request());
		await llm.complete(db, bob, request());
		const since = new Date(Date.now() - 60_000);

		const mine = await usageForUser(db, alice, since);
		expect(mine).toEqual({ calls: 2, refused: 0, promptTokens: 22, completionTokens: 14 }); // positive FIRST
		const theirs = await usageForUser(db, bob, since);
		expect(theirs).toEqual({ calls: 1, refused: 0, promptTokens: 11, completionTokens: 7 });
	});

	it('counts only calls since the given time', async () => {
		const { llm } = client(answering('{"ok":true,"model":"m"}'));
		await llm.complete(db, alice, request());
		const later = new Date(Date.now() + 60_000);
		expect(await usageForUser(db, alice, later)).toEqual({
			calls: 0,
			refused: 0,
			promptTokens: 0,
			completionTokens: 0
		});
	});
});

describe('config', () => {
	it('with no key, complete() throws LlmNotConfigured, records it, and never calls a model', async () => {
		let reached = 0;
		const { llm } = client(
			answering('{"ok":true,"model":"m"}', () => reached++),
			{
				[LLM_ENV.model]: 'test/text-model'
			}
		);
		const error = await caught(() => llm.complete(db, alice, request()), LlmNotConfigured);
		expect(error.problems).toEqual([`${LLM_ENV.apiKey} is not set`]);
		expect(reached).toBe(0);
		const [row] = await rowsFor(alice);
		expect(row).toMatchObject({
			id: error.callId,
			status: 'refused',
			errorCode: 'not_configured',
			model: 'test/text-model'
		});
	});

	it('the exported complete() throws LlmNotConfigured with every LLM variable unset', async () => {
		for (const name of Object.values(LLM_ENV)) vi.stubEnv(name, '');
		const error = await caught(() => defaultComplete(db, alice, request()), LlmNotConfigured);
		expect(error.problems).toContain(`${LLM_ENV.apiKey} is not set`);
		expect(error.problems).toContain(`${LLM_ENV.model} is not set`);
		const [row] = await rowsFor(alice);
		expect(row).toMatchObject({ status: 'refused', errorCode: 'not_configured', model: '' });
	});

	it('reads the environment lazily, once, on the first call — not when the client is built', async () => {
		const env = vi.fn(() => ENV);
		const logs: string[] = [];
		const llm = createLlmClient({
			env,
			model: () => answering('{"ok":true,"model":"m"}'),
			log: (l) => logs.push(l)
		});
		expect(env).not.toHaveBeenCalled();
		await llm.complete(db, alice, request());
		await llm.complete(db, alice, request());
		expect(env).toHaveBeenCalledTimes(1);
		expect(logs).toHaveLength(1);
		expect(JSON.parse(logs[0])).toMatchObject({
			event: 'llm_config',
			configured: true,
			[LLM_ENV.apiKey]: 'set',
			[LLM_ENV.model]: 'test/text-model'
		});
	});

	it('never writes the key to the log line, a row, or an error', async () => {
		const { llm, logs } = client(answering('{"ok":"bad"}'), {
			...ENV,
			[LLM_ENV.storePrompts]: '1'
		});
		const error = await caught(() => llm.complete(db, alice, request()), LlmSchemaError);
		const rows = await rowsFor(alice);
		for (const text of [...logs, JSON.stringify(rows), error.message, String(error.stack)]) {
			expect(text).not.toContain(FAKE_KEY);
		}
	});

	it('defaults, and refuses malformed values instead of falling back', () => {
		const cfg = resolveLlmConfig(ENV);
		expect(cfg).toMatchObject({
			provider: 'openrouter',
			timeoutMs: 30_000,
			maxCallsPerUserPerHour: 60,
			storePrompts: false,
			problems: []
		});
		const bad = resolveLlmConfig({
			...ENV,
			[LLM_ENV.provider]: 'elsewhere',
			[LLM_ENV.timeoutMs]: 'soon',
			[LLM_ENV.maxCallsPerUserPerHour]: '-1',
			[LLM_ENV.storePrompts]: 'yes'
		});
		expect(bad.problems).toEqual([
			`${LLM_ENV.provider} must be one of: openrouter`,
			`${LLM_ENV.timeoutMs} must be a whole number >= 1`,
			`${LLM_ENV.maxCallsPerUserPerHour} must be a whole number >= 0`,
			`${LLM_ENV.storePrompts} must be 0 or 1`
		]);
		expect(llmConfigLogLine(bad)).not.toContain('soon');
	});
});
