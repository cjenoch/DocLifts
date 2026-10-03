/** Image classifiers, called only by complete(). No image or raw response is persisted. */
import { createHash } from 'node:crypto';
import { and, eq, gte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { llmCalls } from '../db/schema';
import type { Database } from '../progression';
import { LlmProviderError, LlmRefused, LlmSchemaError, LlmTimeout } from './errors';

export const SAFETY_PURPOSE = 'photo_safety';
export const LOCAL_MODEL =
	'Falconsai/nsfw_image_detection@96cb0d0342c7afb80cab76ecc58b265fa44da256';
export const REMOTE_MODEL = 'meta-llama/llama-guard-4-12b';
export const SAFETY_PROMPT = 'Identify the gym equipment visible in this photograph.';
export const SafetyResult = z.object({
	provider: z.enum(['local', 'openrouter']),
	allowed: z.boolean(),
	categories: z.array(z.string()).max(14),
	score: z.number().min(0).max(1).nullable(),
	cost: z.number().nonnegative().nullable()
});
export type SafetyResult = z.infer<typeof SafetyResult>;
export type SafetyRequest = {
	provider: 'local' | 'openrouter';
	mode: string;
	image: Uint8Array;
	timeoutMs: number;
	threshold: number;
	localUrl: string;
	hourlyLimit: number;
};

async function boundedJson(response: Response) {
	if (!response.ok || !response.body) throw new Error('provider');
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.length;
			if (size > 16384) throw new Error('response_size');
			chunks.push(value);
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

export async function completeSafety(
	db: Database,
	userId: string,
	request: SafetyRequest,
	env: Record<string, string | undefined>,
	transport: typeof fetch = fetch
): Promise<{ output: SafetyResult; callId: string }> {
	const started = Date.now();
	const policy = { version: 'alpha-v1', mode: request.mode, threshold: request.threshold };
	const model = request.provider === 'local' ? LOCAL_MODEL : REMOTE_MODEL;
	// Reserve before I/O. A crash leaves a refused/pending row, never a pass.
	const reservation = await db.transaction(async (tx) => {
		await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'photo_safety:' + userId}))`);
		const [{ n }] = await tx
			.select({ n: sql<number>`count(*)::int` })
			.from(llmCalls)
			.where(
				and(
					eq(llmCalls.userId, userId),
					eq(llmCalls.purpose, SAFETY_PURPOSE),
					gte(llmCalls.createdAt, sql`now() - interval '1 hour'`)
				)
			);
		const refused = n >= request.hourlyLimit;
		const [row] = await tx
			.insert(llmCalls)
			.values({
				userId,
				purpose: SAFETY_PURPOSE,
				provider: request.provider,
				model,
				status: 'refused',
				errorCode: refused ? 'hourly_cap' : 'pending',
				promptHash: createHash('sha256')
					.update(request.image)
					.update(SAFETY_PROMPT)
					.digest('hex')
					.slice(0, 16),
				promptText: null,
				output: { policy },
				latencyMs: 0
			})
			.returning({ id: llmCalls.id });
		return { id: row.id, refused };
	});
	const callId = reservation.id;
	if (reservation.refused) throw new LlmRefused(request.hourlyLimit, callId);
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, request.timeoutMs);
	let output: SafetyResult;
	let promptTokens: number | null = null;
	let completionTokens: number | null = null;
	try {
		const attempt = async () => {
			if (request.provider === 'local') {
				const url = new URL(request.localUrl);
				if (
					url.protocol !== 'http:' ||
					!['safety', '127.0.0.1', 'localhost'].includes(url.hostname) ||
					url.username ||
					url.password ||
					url.pathname !== '/scan'
				)
					throw new Error('local_config');
				const response = await transport(url, {
					method: 'POST',
					redirect: 'error',
					signal: controller.signal,
					headers: { 'content-type': 'image/jpeg' },
					body: Buffer.from(request.image)
				});
				const parsed = z
					.object({ model: z.literal(LOCAL_MODEL), nsfw: z.number().min(0).max(1) })
					.parse(await boundedJson(response));
				return SafetyResult.parse({
					provider: 'local',
					allowed: parsed.nsfw < request.threshold,
					categories: parsed.nsfw >= request.threshold ? ['nsfw'] : [],
					score: parsed.nsfw,
					cost: null
				});
			}
			if (!env.OPENROUTER_API_KEY) throw new Error('not_configured');
			const response = await transport('https://openrouter.ai/api/v1/chat/completions', {
				method: 'POST',
				redirect: 'error',
				signal: controller.signal,
				headers: {
					authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
					'content-type': 'application/json'
				},
				body: JSON.stringify({
					model: REMOTE_MODEL,
					temperature: 0,
					max_tokens: 128,
					provider: { only: ['DeepInfra'], allow_fallbacks: false, data_collection: 'deny' },
					messages: [
						{
							role: 'user',
							content: [
								{ type: 'text', text: SAFETY_PROMPT },
								{
									type: 'image_url',
									image_url: {
										url: `data:image/jpeg;base64,${Buffer.from(request.image).toString('base64')}`
									}
								}
							]
						}
					]
				})
			});
			const parsed = z
				.object({
					choices: z
						.array(
							z.object({
								finish_reason: z.literal('stop'),
								message: z.object({ content: z.string().max(120) })
							})
						)
						.length(1),
					usage: z
						.object({
							prompt_tokens: z.number().int().nonnegative().optional(),
							completion_tokens: z.number().int().nonnegative().optional(),
							cost: z.number().nonnegative().optional()
						})
						.optional()
				})
				.parse(await boundedJson(response));
			const text = parsed.choices[0].message.content.trim();
			if (!/^(safe|unsafe(?:\s+S(?:[1-9]|1[0-4])(?:\s*,\s*S(?:[1-9]|1[0-4]))*)?)$/.test(text))
				throw new z.ZodError([]);
			promptTokens = parsed.usage?.prompt_tokens ?? null;
			completionTokens = parsed.usage?.completion_tokens ?? null;
			return SafetyResult.parse({
				provider: 'openrouter',
				allowed: text === 'safe',
				categories: text.match(/S\d+/g) ?? [],
				score: null,
				cost: parsed.usage?.cost ?? null
			});
		};
		output = await Promise.race([
			attempt(),
			new Promise<never>((_, reject) => {
				controller.signal.addEventListener('abort', () => reject(new Error('timeout')), {
					once: true
				});
			})
		]);
	} catch (error) {
		const status = timedOut
			? 'timeout'
			: error instanceof z.ZodError
				? 'schema_error'
				: 'provider_error';
		await db
			.update(llmCalls)
			.set({ status, errorCode: status, latencyMs: Date.now() - started })
			.where(eq(llmCalls.id, callId));
		if (timedOut) throw new LlmTimeout(request.timeoutMs, callId);
		if (status === 'schema_error') throw new LlmSchemaError(null, callId);
		throw new LlmProviderError('safety_unavailable', callId);
	} finally {
		clearTimeout(timer);
	}
	await db
		.update(llmCalls)
		.set({
			status: 'ok',
			errorCode: null,
			output: { ...output, policy },
			promptTokens,
			completionTokens,
			latencyMs: Date.now() - started
		})
		.where(eq(llmCalls.id, callId));
	return { output, callId };
}
