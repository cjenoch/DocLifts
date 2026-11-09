/**
 * Offline model doubles for tests OUTSIDE src/lib/server/llm/.
 *
 * llm-seam.test.ts forbids importing `ai` (including `ai/test`) anywhere but
 * this directory, tests included. A feature's test that needs a model goes
 * through these instead: a `complete()` from `createLlmClient` over the SDK's
 * own MockLanguageModelV4, with a fixed fake env, so no test reaches a network
 * and the real recording path (the `llm_calls` row) still runs.
 *
 * Imported only by tests. Not used by production code.
 */
import { APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { createLlmClient } from './index';
import { LLM_ENV, type Env } from './config';

const TEST_ENV: Env = {
	[LLM_ENV.apiKey]: 'sk-or-v1-test-not-a-real-key-0000',
	[LLM_ENV.model]: 'test/text-model',
	[LLM_ENV.visionModel]: 'test/vision-model'
};

const usage = (input: number, output: number) => ({
	inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
	outputTokens: { total: output, text: output, reasoning: undefined }
});

/** A mock model that answers `text` to every call. */
export function answeringModel(text: string) {
	return new MockLanguageModelV4({
		doGenerate: async () => ({
			content: [{ type: 'text', text }],
			finishReason: { unified: 'stop', raw: undefined },
			usage: usage(1200, 150),
			response: { id: 'gen-test-photo' },
			warnings: []
		})
	});
}

/** One provider answer: an HTTP failure (with Retry-After, if given) or a text reply. */
export type ScriptedAnswer = { status: number; retryAfter?: string } | { text: string };

/**
 * A mock model that gives `answers` in order, one per call (the last repeats).
 * A failure is the SDK's own `APICallError`, as the OpenRouter provider throws
 * it: the status, and the headers lower-cased.
 */
export function scriptedModel(answers: ScriptedAnswer[]) {
	let i = 0;
	return new MockLanguageModelV4({
		doGenerate: async () => {
			const answer = answers[Math.min(i++, answers.length - 1)];
			if ('status' in answer)
				throw new APICallError({
					message: `provider said ${answer.status}`,
					url: 'https://provider.invalid/v1/chat',
					requestBodyValues: {},
					statusCode: answer.status,
					responseHeaders:
						answer.retryAfter === undefined ? {} : { 'retry-after': answer.retryAfter },
					isRetryable: answer.status === 429 || answer.status >= 500
				});
			return {
				content: [{ type: 'text', text: answer.text }],
				finishReason: { unified: 'stop', raw: undefined },
				usage: usage(1200, 150),
				response: { id: 'gen-test-photo' },
				warnings: []
			};
		}
	});
}

/**
 * One `complete()` over `model` that keeps its hourly cap across calls (the
 * production singleton's shape), with the cap set to `maxPerHour`.
 */
export function cappedComplete(model: MockLanguageModelV4, maxPerHour: number) {
	return createLlmClient({
		env: { ...TEST_ENV, [LLM_ENV.maxCallsPerUserPerHour]: String(maxPerHour) },
		model: () => model,
		log: () => {}
	}).complete;
}

/** A `complete()` over `model`, with a fake key and model ids. Never a network call. */
export function testComplete(model: MockLanguageModelV4, env: Env = TEST_ENV) {
	return createLlmClient({ env, model: () => model, log: () => {} }).complete;
}
