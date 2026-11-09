/**
 * completeWithRetry (2026-11-09): one retry of a transient provider answer,
 * above `complete()`, inside one deadline. Every attempt goes through a real
 * `complete()` over the SDK's mock model, so each one's `llm_calls` row and
 * the hourly cap are the production ones. The wait is an injected sleep and
 * the deadline an injected clock: nothing here waits for real.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { setupTestDb, resetTestDbWithUsers, type TestDb } from '../test-db';
import { llmCalls } from '../db/schema';
import {
	completeWithRetry,
	createLlmClient,
	isTransientErrorCode,
	isTransientLlmError,
	LlmNotConfigured,
	LlmProviderError,
	LlmRefused,
	LlmSchemaError,
	LlmTimeout,
	parseRetryAfter,
	type CompleteFn,
	type CompleteRequest,
	type RetryPolicy
} from './index';
import { LLM_ENV, type Env } from './config';
import { scriptedModel, type ScriptedAnswer } from './test-models';
import { MockLanguageModelV4 } from 'ai/test';

let db: TestDb;
let handle: Awaited<ReturnType<typeof setupTestDb>>;
let alice: string;

beforeAll(async () => {
	handle = await setupTestDb();
	db = handle.db;
});
afterAll(async () => {
	await handle?.end();
});
beforeEach(async () => {
	[{ id: alice }] = await resetTestDbWithUsers(db, handle.client, 1, 'retry');
});

const ENV: Env = {
	[LLM_ENV.apiKey]: 'sk-or-v1-test-not-a-real-key-0000',
	[LLM_ENV.model]: 'test/text-model'
};
const OK = { text: '{"ok":true}' };
const schema = z.object({ ok: z.boolean() });
const request: CompleteRequest<z.infer<typeof schema>> = {
	purpose: 'ping',
	system: 'You are a test.',
	messages: [{ role: 'user', content: 'Reply with ok true.' }],
	schema
};
const POLICY: RetryPolicy = {
	budgetMs: 45_000,
	minAttemptMs: 5_000,
	baseDelayMs: 1_000,
	jitterMs: 1_000
};

/**
 * A real complete() over `answers`, a clock the sleep moves, and a record of
 * every wait and of each attempt's timeout.
 */
function harness(answers: ScriptedAnswer[] | MockLanguageModelV4, env: Env = ENV) {
	const clock = { t: 1_800_000_000_000 };
	const model = answers instanceof MockLanguageModelV4 ? answers : scriptedModel(answers);
	const real = createLlmClient({
		env,
		model: () => model,
		now: () => clock.t,
		log: () => {}
	}).complete;
	const timeouts: (number | undefined)[] = [];
	const complete: CompleteFn = (d, u, r) => {
		timeouts.push(r.timeoutMs);
		return real(d, u, r);
	};
	const waits: number[] = [];
	const deps = {
		now: () => clock.t,
		sleep: async (ms: number) => {
			waits.push(ms);
			clock.t += ms;
		},
		random: () => 0.5
	};
	const run = (policy = POLICY, extra: { beforeRetry?: () => Promise<boolean> } = {}) =>
		completeWithRetry(complete, db, alice, request, policy, { ...deps, ...extra });
	return { run, model, waits, timeouts, clock };
}

const rows = () =>
	db
		.select({ status: llmCalls.status, errorCode: llmCalls.errorCode, id: llmCalls.id })
		.from(llmCalls)
		.where(eq(llmCalls.userId, alice))
		.orderBy(asc(llmCalls.createdAt));

async function caught(fn: () => Promise<unknown>): Promise<unknown> {
	try {
		await fn();
	} catch (e) {
		return e;
	}
	throw new Error('expected a throw');
}

describe('completeWithRetry: transient answers', () => {
	it('429 then ok: two attempts, two rows, a jittered wait, the ok result', async () => {
		const h = harness([{ status: 429 }, OK]);
		const result = await h.run();
		expect(result.output).toEqual({ ok: true });
		expect(h.model.doGenerateCalls).toHaveLength(2);
		const recorded = await rows();
		expect(recorded.map((r) => [r.status, r.errorCode])).toEqual([
			['provider_error', 'http_429'],
			['ok', null]
		]);
		expect(result.callId).toBe(recorded[1].id);
		// No Retry-After: 1 s plus random 0.5 of the 1 s jitter.
		expect(h.waits).toEqual([1500]);
	});

	it.each([502, 503])('%i then ok is retried too', async (status) => {
		const h = harness([{ status }, OK]);
		await h.run();
		expect(h.model.doGenerateCalls).toHaveLength(2);
	});

	it('503 twice: two attempts, then the second 503 is thrown, transient', async () => {
		const h = harness([{ status: 503 }, { status: 503 }, OK]);
		const error = await caught(h.run);
		expect(error).toBeInstanceOf(LlmProviderError);
		expect(isTransientLlmError(error)).toBe(true);
		const recorded = await rows();
		expect(recorded.map((r) => r.errorCode)).toEqual(['http_503', 'http_503']);
		expect((error as LlmProviderError).callId).toBe(recorded[1].id);
		expect(h.model.doGenerateCalls).toHaveLength(2); // never a third
	});

	it('honors Retry-After in seconds', async () => {
		const h = harness([{ status: 429, retryAfter: '3' }, OK]);
		await h.run();
		expect(h.waits).toEqual([3000]);
	});

	it('honors Retry-After as an HTTP-date', async () => {
		const at = new Date(1_800_000_000_000 + 4000).toUTCString(); // the harness clock + 4 s
		const dated = harness([{ status: 429, retryAfter: at }, OK]);
		await dated.run();
		expect(dated.waits).toEqual([4000]);
	});

	it('a Retry-After past the budget: no wait, no second attempt, the first error, transient', async () => {
		const h = harness([{ status: 429, retryAfter: '41' }, OK]);
		const error = await caught(h.run);
		expect(isTransientLlmError(error)).toBe(true);
		expect(h.waits).toEqual([]);
		expect(h.model.doGenerateCalls).toHaveLength(1);
		expect(await rows()).toHaveLength(1);
		// 40 s is the most that leaves 5 s of the 45 s budget for the attempt.
		const fits = harness([{ status: 429, retryAfter: '40' }, OK]);
		await fits.run();
		expect(fits.waits).toEqual([40_000]);
	});

	it('both attempts share one deadline: the second gets what is left', async () => {
		const h = harness([{ status: 503, retryAfter: '10' }, OK]);
		await h.run();
		expect(h.timeouts).toEqual([45_000, 35_000]);
	});

	it('beforeRetry false keeps the first error and makes no second attempt', async () => {
		const h = harness([{ status: 429 }, OK]);
		const error = await caught(() => h.run(POLICY, { beforeRetry: async () => false }));
		expect(isTransientLlmError(error)).toBe(true);
		expect(h.waits).toEqual([]);
		expect(h.model.doGenerateCalls).toHaveLength(1);
	});
});

describe('completeWithRetry: never retried', () => {
	it.each([400, 401, 403, 404, 500, 504])('HTTP %i: one attempt, thrown as is', async (status) => {
		const h = harness([{ status }, OK]);
		const error = await caught(h.run);
		expect(error).toBeInstanceOf(LlmProviderError);
		expect((error as LlmProviderError).status).toBe(status);
		expect(h.model.doGenerateCalls).toHaveLength(1);
		expect(h.waits).toEqual([]);
	});

	it('a schema miss: one attempt', async () => {
		const h = harness([{ text: 'not json' }, OK]);
		expect(await caught(h.run)).toBeInstanceOf(LlmSchemaError);
		expect(h.model.doGenerateCalls).toHaveLength(1);
	});

	it('not configured: one refused row, no model call', async () => {
		const h = harness([{ status: 429 }, OK], { [LLM_ENV.model]: 'test/text-model' });
		expect(await caught(h.run)).toBeInstanceOf(LlmNotConfigured);
		expect(h.model.doGenerateCalls).toHaveLength(0);
		expect(await rows()).toHaveLength(1);
	});

	it('a timeout: one attempt, even with budget left (a retry could only be cut short)', async () => {
		const model = new MockLanguageModelV4({ doGenerate: () => new Promise(() => {}) });
		const h = harness(model, { ...ENV, [LLM_ENV.timeoutMs]: '40' });
		const error = await caught(h.run);
		expect(error).toBeInstanceOf(LlmTimeout);
		expect(model.doGenerateCalls).toHaveLength(1);
		expect(await rows()).toHaveLength(1);
	});

	it('the budget caps an attempt below LLM_TIMEOUT_MS', async () => {
		const model = new MockLanguageModelV4({ doGenerate: () => new Promise(() => {}) });
		const h = harness(model); // LLM_TIMEOUT_MS 30 s
		const error = await caught(() => h.run({ ...POLICY, budgetMs: 40 }));
		expect((error as LlmTimeout).timeoutMs).toBe(40);
	});

	it('the cap refusing the first attempt: one refused row, no retry', async () => {
		const h = harness([{ status: 429 }, OK], { ...ENV, [LLM_ENV.maxCallsPerUserPerHour]: '0' });
		expect(await caught(h.run)).toBeInstanceOf(LlmRefused);
		expect(await rows()).toHaveLength(1);
		expect(h.model.doGenerateCalls).toHaveLength(0);
	});

	it('the hourly cap counts each attempt: with a cap of 1 the retry is refused and recorded', async () => {
		const h = harness([{ status: 429 }, OK], { ...ENV, [LLM_ENV.maxCallsPerUserPerHour]: '1' });
		const error = await caught(h.run);
		expect(error).toBeInstanceOf(LlmRefused);
		expect(h.model.doGenerateCalls).toHaveLength(1);
		expect((await rows()).map((r) => [r.status, r.errorCode])).toEqual([
			['provider_error', 'http_429'],
			['refused', 'hourly_cap']
		]);
	});
});

describe('the parts', () => {
	it('parseRetryAfter: seconds, HTTP-date, past, garbage', () => {
		const now = Date.parse('2026-11-09T12:00:00Z');
		expect(parseRetryAfter('2', now)).toBe(2000);
		expect(parseRetryAfter(' 1.5 ', now)).toBe(1500);
		expect(parseRetryAfter('Mon, 09 Nov 2026 12:00:07 GMT', now)).toBe(7000);
		expect(parseRetryAfter('Mon, 09 Nov 2026 11:00:00 GMT', now)).toBe(0);
		expect(parseRetryAfter('soon', now)).toBeNull();
		expect(parseRetryAfter('-3', now)).toBeNull();
		expect(parseRetryAfter(undefined, now)).toBeNull();
	});

	it('isTransientErrorCode reads the recorded code the same way', () => {
		expect(['http_429', 'http_502', 'http_503'].map(isTransientErrorCode)).toEqual([
			true,
			true,
			true
		]);
		expect(
			['http_500', 'http_401', 'http_none', 'timeout', null].map(isTransientErrorCode)
		).toEqual([false, false, false, false, false]);
	});

	it('the provider error carries the status and Retry-After, never the header text', async () => {
		const h = harness([{ status: 429, retryAfter: '2' }]);
		const error = (await caught(() => h.run({ ...POLICY, budgetMs: 1 }))) as LlmProviderError;
		expect(error).toMatchObject({ code: 'http_429', status: 429, retryAfterMs: 2000 });
		expect(error.message).toBe('LLM provider error: http_429');
		const [row] = await rows();
		expect(row.errorCode).toBe('http_429');
	});
});
