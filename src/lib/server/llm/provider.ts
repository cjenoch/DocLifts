/**
 * The one place a provider SDK is constructed. Adding Anthropic or Bedrock
 * later is a `case` here and a dependency, nothing else.
 *
 * Only `complete()` (index.ts) calls this. Nothing else in the app imports a
 * provider SDK or `ai` — see CLAUDE.md "LLM calls go through complete() only",
 * enforced by llm-seam.test.ts.
 */
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { LanguageModel } from 'ai';
import type { LlmConfig } from './config';

/**
 * A model INSTANCE, never a bare string: `ai` treats a string model id as a
 * Vercel AI Gateway id and would route the call through a provider this app
 * never configured.
 */
export type ModelInstance = Exclude<LanguageModel, string>;

export type ModelKind = 'text' | 'vision';

/** The model id a call of this kind sends, or null when unset. */
export function modelIdFor(config: LlmConfig, kind: ModelKind): string | null {
	return kind === 'vision' ? config.visionModel : config.model;
}

/**
 * The SDK model for the configured provider. Takes the resolved config as an
 * argument (CLAUDE.md prefers explicit configuration to module-scope reads);
 * the caller has already refused an unusable config, so a missing model or key
 * here is a programming error.
 */
export function getModel(kind: ModelKind, config: LlmConfig): ModelInstance {
	const modelId = modelIdFor(config, kind);
	if (!modelId || !config.apiKey) {
		throw new Error('getModel called with an unusable LLM config');
	}
	switch (config.provider) {
		case 'openrouter':
			// `strict`: this talks to OpenRouter itself, not a compatible proxy.
			return createOpenRouter({ apiKey: config.apiKey, compatibility: 'strict' }).chat(modelId);
	}
}
