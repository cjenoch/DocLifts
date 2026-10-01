/**
 * LLM configuration, read from `process.env` — never `$env/dynamic/*` (see
 * CLAUDE.md: module-scope `$env` reads are silently undefined on adapter-node).
 *
 * Nothing here runs at import or at boot. `complete()` resolves the config on
 * its FIRST call, so the app starts, serves, and passes its whole gate with no
 * LLM variable set (CI has none). A missing key is an error only for the code
 * that tries to use it.
 *
 * There is deliberately no default model. A hard-coded model id would be a
 * plausible wrong value the day it is retired or repriced; `LLM_MODEL` is
 * required when the layer is used, like the key.
 */

export const LLM_PROVIDERS = ['openrouter'] as const;
export type LlmProviderName = (typeof LLM_PROVIDERS)[number];

/** Every variable this module reads. One table, so the log, docs and parser agree. */
export const LLM_ENV = {
	provider: 'LLM_PROVIDER',
	model: 'LLM_MODEL',
	visionModel: 'LLM_VISION_MODEL',
	apiKey: 'OPENROUTER_API_KEY',
	timeoutMs: 'LLM_TIMEOUT_MS',
	maxCallsPerUserPerHour: 'LLM_MAX_CALLS_PER_USER_PER_HOUR',
	storePrompts: 'LLM_STORE_PROMPTS'
} as const;

export const LLM_DEFAULTS = {
	provider: 'openrouter' as LlmProviderName,
	timeoutMs: 30_000,
	maxCallsPerUserPerHour: 60,
	storePrompts: false
};

export type LlmConfig = {
	provider: LlmProviderName;
	/** `LLM_MODEL`; null when unset. */
	model: string | null;
	/** `LLM_VISION_MODEL`, falling back to `LLM_MODEL`. */
	visionModel: string | null;
	/** The provider key. Never logged, never stored, never in an error. */
	apiKey: string | null;
	timeoutMs: number;
	/** 0 refuses every call: a kill switch, not "unlimited". */
	maxCallsPerUserPerHour: number;
	storePrompts: boolean;
	/**
	 * Why the config cannot be used, by variable name. Empty means usable.
	 * Never contains a variable's value.
	 */
	problems: string[];
};

export type Env = Record<string, string | undefined>;

const read = (env: Env, name: string): string | null => {
	const raw = env[name];
	return raw === undefined || raw.trim() === '' ? null : raw.trim();
};

function wholeNumber(
	env: Env,
	name: string,
	fallback: number,
	min: number,
	problems: string[]
): number {
	const raw = read(env, name);
	if (raw === null) return fallback;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < min) {
		// The value is a tunable, not a secret, but it is still not echoed: one
		// rule for every variable is easier to keep than a list of exceptions.
		problems.push(`${name} must be a whole number >= ${min}`);
		return fallback;
	}
	return n;
}

/**
 * Resolve the config from an environment. Never throws: problems are collected
 * so the caller can record the call and throw `LlmNotConfigured` with all of
 * them at once, rather than one per attempt.
 *
 * A malformed tunable is a problem, not a silent fallback to the default
 * (the 0.2.4 rule from login-throttle.ts: a setting that is quietly ignored is
 * worse than one that refuses).
 */
export function resolveLlmConfig(env: Env = process.env): LlmConfig {
	const problems: string[] = [];

	const providerRaw = read(env, LLM_ENV.provider) ?? LLM_DEFAULTS.provider;
	const provider = (LLM_PROVIDERS as readonly string[]).includes(providerRaw)
		? (providerRaw as LlmProviderName)
		: null;
	if (!provider) problems.push(`${LLM_ENV.provider} must be one of: ${LLM_PROVIDERS.join(', ')}`);

	const model = read(env, LLM_ENV.model);
	if (!model) problems.push(`${LLM_ENV.model} is not set`);
	const visionModel = read(env, LLM_ENV.visionModel) ?? model;

	const apiKey = read(env, LLM_ENV.apiKey);
	if (!apiKey) problems.push(`${LLM_ENV.apiKey} is not set`);

	const timeoutMs = wholeNumber(env, LLM_ENV.timeoutMs, LLM_DEFAULTS.timeoutMs, 1, problems);
	const maxCallsPerUserPerHour = wholeNumber(
		env,
		LLM_ENV.maxCallsPerUserPerHour,
		LLM_DEFAULTS.maxCallsPerUserPerHour,
		0,
		problems
	);

	const storeRaw = read(env, LLM_ENV.storePrompts);
	let storePrompts = LLM_DEFAULTS.storePrompts;
	if (storeRaw === '1') storePrompts = true;
	else if (storeRaw !== null && storeRaw !== '0')
		problems.push(`${LLM_ENV.storePrompts} must be 0 or 1`);

	return {
		provider: provider ?? LLM_DEFAULTS.provider,
		model,
		visionModel,
		apiKey,
		timeoutMs,
		maxCallsPerUserPerHour,
		storePrompts,
		problems
	};
}

/**
 * The effective config as one structured log line, written once at first use.
 * The key appears only as `set` / `unset`.
 */
export function llmConfigLogLine(config: LlmConfig): string {
	return JSON.stringify({
		event: 'llm_config',
		configured: config.problems.length === 0,
		[LLM_ENV.provider]: config.provider,
		[LLM_ENV.model]: config.model,
		[LLM_ENV.visionModel]: config.visionModel,
		[LLM_ENV.apiKey]: config.apiKey ? 'set' : 'unset',
		[LLM_ENV.timeoutMs]: config.timeoutMs,
		[LLM_ENV.maxCallsPerUserPerHour]: config.maxCallsPerUserPerHour,
		[LLM_ENV.storePrompts]: config.storePrompts ? 1 : 0,
		problems: config.problems
	});
}
