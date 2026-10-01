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

/** A `complete()` over `model`, with a fake key and model ids. Never a network call. */
export function testComplete(model: MockLanguageModelV4, env: Env = TEST_ENV) {
	return createLlmClient({ env, model: () => model, log: () => {} }).complete;
}
