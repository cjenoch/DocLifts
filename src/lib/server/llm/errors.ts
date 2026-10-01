/**
 * The typed errors `complete()` throws. Every one carries `callId`, the
 * `llm_calls` row written for the failed call — the row exists on every path,
 * including these.
 *
 * Messages never contain the API key, the prompt, or the provider's raw error
 * text: they name what happened and, at most, an error code.
 */

export class LlmError extends Error {
	constructor(
		message: string,
		/** The `llm_calls` row recorded for this call. */
		readonly callId: string
	) {
		super(message);
		this.name = new.target.name;
	}
}

/**
 * The LLM layer is not configured: a required variable is missing or a tunable
 * is malformed. Thrown only when something calls `complete()` — the app boots
 * and serves without any LLM variable set.
 */
export class LlmNotConfigured extends LlmError {
	constructor(
		/** Variable names and what is wrong with each. Never a value. */
		readonly problems: string[],
		callId: string
	) {
		super(`LLM is not configured: ${problems.join('; ')}`, callId);
	}
}

/** The per-user hourly cap refused the call before it reached the provider. */
export class LlmRefused extends LlmError {
	constructor(
		readonly limit: number,
		callId: string
	) {
		super(`LLM call refused: hourly limit of ${limit} calls reached`, callId);
	}
}

/** The model answered, but not with an object that matches the schema. */
export class LlmSchemaError extends LlmError {
	constructor(
		/** The model's raw text, also stored in `llm_calls.output`. */
		readonly rawText: string | null,
		callId: string
	) {
		super('LLM output did not match the schema', callId);
	}
}

/** The provider failed: HTTP error, network error, or no usable response. */
export class LlmProviderError extends LlmError {
	constructor(
		readonly code: string,
		callId: string
	) {
		super(`LLM provider error: ${code}`, callId);
	}
}

/** The call exceeded LLM_TIMEOUT_MS and was aborted. */
export class LlmTimeout extends LlmError {
	constructor(
		readonly timeoutMs: number,
		callId: string
	) {
		super(`LLM call timed out after ${timeoutMs} ms`, callId);
	}
}
