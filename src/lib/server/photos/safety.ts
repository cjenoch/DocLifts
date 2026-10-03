import { createHash } from 'node:crypto';
import type { Database } from '../progression';
import { complete } from '../llm';
import { SafetyResult, SAFETY_PURPOSE, SAFETY_PROMPT } from '../llm/safety';

export class PhotoSafetyError extends Error {
	constructor(readonly reason: 'blocked' | 'unavailable') {
		super(
			reason === 'blocked'
				? 'This photo did not pass the safety check. Try a clear photo of the equipment, or add the exercise manually.'
				: 'Photo safety checking is unavailable. The photo was not saved. Try again later, or add the exercise manually.'
		);
		this.name = 'PhotoSafetyError';
	}
}
export function safetyConfig(env: Record<string, string | undefined> = process.env) {
	const mode = env.PHOTO_SAFETY_MODE || 'paused';
	if (!['local', 'openrouter', 'ab', 'paused', 'test-pass'].includes(mode))
		throw new PhotoSafetyError('unavailable');
	if (mode === 'test-pass') {
		let testDatabase = false;
		try {
			testDatabase = new URL(env.DATABASE_URL!).pathname.endsWith('_test');
		} catch {
			/* fail closed */
		}
		if (!env.VITEST || !testDatabase) throw new PhotoSafetyError('unavailable');
	}
	const timeoutMs = Number(env.PHOTO_SAFETY_TIMEOUT_MS || 5000);
	const threshold = Number(env.PHOTO_SAFETY_NSFW_THRESHOLD || 0.5);
	const hourlyLimit = Number(env.PHOTO_SAFETY_HOURLY_LIMIT || 60);
	if (
		!Number.isInteger(timeoutMs) ||
		timeoutMs < 100 ||
		timeoutMs > 15000 ||
		!Number.isFinite(threshold) ||
		threshold <= 0 ||
		threshold > 1 ||
		!Number.isInteger(hourlyLimit) ||
		hourlyLimit < 0 ||
		hourlyLimit > 1000
	)
		throw new PhotoSafetyError('unavailable');
	return {
		mode,
		timeoutMs,
		threshold,
		hourlyLimit,
		localUrl: env.PHOTO_SAFETY_LOCAL_URL || 'http://safety:8000/scan'
	};
}
export function safetyProvider(mode: string, userId: string): 'local' | 'openrouter' {
	if (mode === 'ab')
		return createHash('sha256')
			.update('photo-safety-alpha-v1:' + userId)
			.digest()[0] < 128
			? 'local'
			: 'openrouter';
	if (mode === 'local' || mode === 'openrouter') return mode;
	throw new PhotoSafetyError('unavailable');
}
export async function scanPhoto(
	db: Database,
	userId: string,
	image: Uint8Array,
	deps: { env?: Record<string, string | undefined>; complete?: typeof complete } = {}
) {
	const config = safetyConfig(deps.env);
	if (config.mode === 'test-pass') return;
	const provider = safetyProvider(config.mode, userId);
	let result;
	try {
		result = await (deps.complete ?? complete)(db, userId, {
			purpose: SAFETY_PURPOSE,
			system: SAFETY_PROMPT,
			messages: [{ role: 'user', content: [{ type: 'image', image, mediaType: 'image/jpeg' }] }],
			schema: SafetyResult,
			safety: { provider, image, ...config }
		});
	} catch {
		throw new PhotoSafetyError('unavailable');
	}
	if (!result.output.allowed) throw new PhotoSafetyError('blocked');
}
