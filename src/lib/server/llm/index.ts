/**
 * `complete()` — the ONE way this app calls a language model.
 *
 * Every future feature that wants a typed object from a model calls this. No
 * other module imports `ai` or a provider SDK (CLAUDE.md; llm-seam.test.ts
 * fails the build if one does). That gives one place for the things every call
 * must have: the per-user cap, the timeout, schema validation, and a
 * `llm_calls` row.
 *
 * THE INVARIANT: a row is written on EVERY path — ok, schema miss, provider
 * error, timeout, cap refusal, and "not configured" — and it is written BEFORE
 * the typed error is thrown, so the error's `callId` names a row that exists.
 * If the row itself cannot be written, that database error propagates instead:
 * a call that cannot be recorded is not reported as a success.
 *
 * ORDER: resolve config -> refuse if unusable -> per-user cap -> provider call.
 * The config comes first because the cap's limit is part of it; neither refusal
 * reaches the provider, so the order costs nothing.
 *
 * One provider attempt per call (`maxRetries: 0`), so one row is one request
 * and the timeout bounds the whole call. A caller that wants a retry calls
 * again, and that retry is counted and recorded like any other call.
 */
import {
	APICallError,
	generateText,
	jsonSchema,
	NoObjectGeneratedError,
	NoOutputGeneratedError,
	Output,
	type JSONSchema7
} from 'ai';
import { z, type ZodType } from 'zod';
import { llmCalls, type LlmCallStatus } from '../db/schema';
import type { Database } from '../progression';
import { LlmCallCap, type Clock } from './cap';
import { llmConfigLogLine, resolveLlmConfig, type Env, type LlmConfig } from './config';
import {
	LlmNotConfigured,
	LlmProviderError,
	LlmRefused,
	LlmSchemaError,
	LlmTimeout
} from './errors';
import { promptHash, promptText, type LlmMessage } from './prompt';
import { getModel, modelIdFor, type ModelInstance, type ModelKind } from './provider';

// The SDK validates with the app's own zod instance (pnpm links zod@4.6.5 into
// `ai`). Set jitless here too, so it holds in processes that never load
// program-draft.ts (the llm:ping CLI): zod's eval probe is what the strict CSP
// reports, and one setting everywhere is simpler than reasoning about which
// process loaded which module first. See program-draft.ts.
z.config({ jitless: true });

export * from './errors';
export type { LlmMessage } from './prompt';
export type { ModelKind } from './provider';
export { usageForUser, type LlmUsage } from './usage';

export type CompleteRequest<T> = {
	/** What the call is for; recorded in `llm_calls.purpose`. */
	purpose: string;
	system: string;
	messages: LlmMessage[];
	schema: ZodType<T>;
	/**
	 * The JSON schema SENT to the model, when it should differ from the one
	 * derived from `schema`. The reply is still validated by `schema`.
	 *
	 * Why: a schema derived from zod carries every constraint (maxLength,
	 * min/max, defaults, anyOf nullables), and strict structured output
	 * compiles all of it. Measured 2026-10-01 on anthropic/claude-haiku-4.5 via
	 * OpenRouter with the photo schema: derived 15-16 s, a plain schema of the
	 * same fields 3.7-7 s; the slow path is where analyses hit the timeout.
	 */
	wireSchema?: Record<string, unknown>;
	/** `vision` uses LLM_VISION_MODEL (falling back to LLM_MODEL). Default `text`. */
	kind?: ModelKind;
};

/** The schema handed to the SDK: the wire schema validated by zod, or zod itself. */
function outputSchema<T>(request: CompleteRequest<T>) {
	if (!request.wireSchema) return request.schema;
	return jsonSchema<T>(request.wireSchema as JSONSchema7, {
		validate: (value) => {
			const parsed = request.schema.safeParse(value);
			return parsed.success
				? { success: true, value: parsed.data }
				: { success: false, error: parsed.error };
		}
	});
}

export type CompleteResult<T> = { output: T; callId: string };

export type LlmClientOptions = {
	/** The environment, read once on the first call. Default: process.env. */
	env?: Env | (() => Env);
	/** The model for a call. Default: provider.ts `getModel`. Tests pass a mock. */
	model?: (kind: ModelKind, config: LlmConfig) => ModelInstance;
	/** Clock for the cap and latency. Default: Date.now. */
	now?: Clock;
	/** Where the one-time config line goes. Default: console.log. */
	log?: (line: string) => void;
};

/** A provider-reported request id; the SDK invents `aitxt-…` when there is none. */
const providerRequestId = (id: string | undefined): string | null =>
	id && !id.startsWith('aitxt-') ? id : null;

/** A short, value-free code for a provider failure. Never the message. */
function providerErrorCode(error: unknown): string {
	if (APICallError.isInstance(error)) return `http_${error.statusCode ?? 'none'}`;
	if (error instanceof Error && error.name) return error.name.slice(0, 64);
	return 'unknown';
}

type Outcome =
	| {
			status: 'ok';
			output: unknown;
			requestId: string | null;
			promptTokens: number | null;
			completionTokens: number | null;
	  }
	| {
			status: 'schema_error';
			rawText: string | null;
			errorCode: string;
			requestId: string | null;
			promptTokens: number | null;
			completionTokens: number | null;
	  }
	| { status: 'timeout' }
	| { status: 'provider_error'; errorCode: string };

export function createLlmClient(options: LlmClientOptions = {}) {
	const now = options.now ?? (() => Date.now());
	const log = options.log ?? ((line: string) => console.log(line));
	const modelFor = options.model ?? getModel;
	const cap = new LlmCallCap(now);
	let config: LlmConfig | undefined;

	/** Lazy: resolved and logged on the first call, never at import or boot. */
	function currentConfig(): LlmConfig {
		if (!config) {
			const env = typeof options.env === 'function' ? options.env() : options.env;
			config = resolveLlmConfig(env ?? process.env);
			log(llmConfigLogLine(config));
		}
		return config;
	}

	async function attempt(
		model: ModelInstance,
		request: CompleteRequest<unknown>,
		timeoutMs: number
	): Promise<Outcome> {
		const controller = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort(new Error('LLM timeout'));
		}, timeoutMs);
		// Race the abort as well as passing the signal: a provider that ignores
		// its signal must still not hold the caller past the timeout.
		const aborted = new Promise<never>((_, reject) =>
			controller.signal.addEventListener('abort', () => reject(controller.signal.reason))
		);
		try {
			const result = await Promise.race([
				generateText({
					model,
					instructions: request.system,
					messages: request.messages,
					output: Output.object({ schema: outputSchema(request) }),
					maxRetries: 0,
					abortSignal: controller.signal
				}),
				aborted
			]);
			const usage = {
				requestId: providerRequestId(result.response.id),
				promptTokens: result.usage.inputTokens ?? null,
				completionTokens: result.usage.outputTokens ?? null
			};
			try {
				return { status: 'ok', output: result.output, ...usage };
			} catch (error) {
				// `output` is a getter that throws when the step did not finish
				// with an object (e.g. cut off at the length limit).
				if (NoOutputGeneratedError.isInstance(error)) {
					return { status: 'schema_error', rawText: result.text, errorCode: 'no_output', ...usage };
				}
				throw error;
			}
		} catch (error) {
			if (timedOut) return { status: 'timeout' };
			if (NoObjectGeneratedError.isInstance(error)) {
				return {
					status: 'schema_error',
					rawText: error.text ?? null,
					errorCode: 'no_object',
					requestId: providerRequestId(error.response?.id),
					promptTokens: error.usage?.inputTokens ?? null,
					completionTokens: error.usage?.outputTokens ?? null
				};
			}
			return { status: 'provider_error', errorCode: providerErrorCode(error) };
		} finally {
			clearTimeout(timer);
		}
	}

	async function complete<T>(
		db: Database,
		userId: string,
		request: CompleteRequest<T>
	): Promise<CompleteResult<T>> {
		const started = now();
		const kind = request.kind ?? 'text';
		const cfg = currentConfig();

		const record = async (fields: {
			status: LlmCallStatus;
			errorCode?: string | null;
			requestId?: string | null;
			promptTokens?: number | null;
			completionTokens?: number | null;
			output?: unknown;
		}): Promise<string> => {
			const [row] = await db
				.insert(llmCalls)
				.values({
					userId,
					purpose: request.purpose,
					provider: cfg.provider,
					model: modelIdFor(cfg, kind) ?? '',
					requestId: fields.requestId ?? null,
					status: fields.status,
					errorCode: fields.errorCode ?? null,
					promptTokens: fields.promptTokens ?? null,
					completionTokens: fields.completionTokens ?? null,
					latencyMs: Math.max(0, Math.round(now() - started)),
					promptHash: promptHash(request.system, request.messages),
					promptText: cfg.storePrompts ? promptText(request.system, request.messages) : null,
					output: fields.output ?? null
				})
				.returning({ id: llmCalls.id });
			return row.id;
		};

		if (cfg.problems.length) {
			const callId = await record({ status: 'refused', errorCode: 'not_configured' });
			throw new LlmNotConfigured(cfg.problems, callId);
		}

		if (!cap.allows(userId, cfg.maxCallsPerUserPerHour)) {
			const callId = await record({ status: 'refused', errorCode: 'hourly_cap' });
			throw new LlmRefused(cfg.maxCallsPerUserPerHour, callId);
		}
		cap.record(userId);

		const outcome = await attempt(modelFor(kind, cfg), request, cfg.timeoutMs);
		switch (outcome.status) {
			case 'ok': {
				const callId = await record(outcome);
				return { output: outcome.output as T, callId };
			}
			case 'schema_error': {
				const callId = await record({ ...outcome, output: outcome.rawText });
				throw new LlmSchemaError(outcome.rawText, callId);
			}
			case 'timeout': {
				const callId = await record({ status: 'timeout', errorCode: 'timeout' });
				throw new LlmTimeout(cfg.timeoutMs, callId);
			}
			case 'provider_error': {
				const callId = await record(outcome);
				throw new LlmProviderError(outcome.errorCode, callId);
			}
		}
	}

	return { complete };
}

let defaultClient: ReturnType<typeof createLlmClient> | undefined;

/**
 * Get a typed object from the configured model, on behalf of `userId`.
 *
 * Throws `LlmNotConfigured`, `LlmRefused`, `LlmSchemaError`, `LlmProviderError`
 * or `LlmTimeout`; each carries the `callId` of the row recorded for the call.
 */
export function complete<T>(
	db: Database,
	userId: string,
	request: CompleteRequest<T>
): Promise<CompleteResult<T>> {
	defaultClient ??= createLlmClient();
	return defaultClient.complete(db, userId, request);
}
