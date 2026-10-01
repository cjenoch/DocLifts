/**
 * Photo configuration (0.4.0), read from `process.env` — never `$env/dynamic/*`
 * (CLAUDE.md: module-scope `$env` reads are silently undefined on adapter-node).
 *
 * Nothing here runs at import or at boot. The store is resolved on its first
 * use and the limits on each upload, so the app starts, serves, and passes its
 * whole gate with no S3 variable set (CI has none). A missing S3 variable is an
 * error for the request that needs the store, not a boot failure — the same
 * shape as the LLM layer's lazy config.
 */

export type Env = Record<string, string | undefined>;

/** Every variable the photo feature reads. One table, so docs, compose and parser agree. */
export const PHOTO_ENV = {
	store: 'PHOTO_STORE',
	maxBytes: 'PHOTO_MAX_BYTES',
	dailyLimit: 'PHOTO_DAILY_LIMIT',
	s3Endpoint: 'S3_ENDPOINT',
	s3Region: 'S3_REGION',
	s3Bucket: 'S3_BUCKET',
	s3AccessKeyId: 'S3_ACCESS_KEY_ID',
	s3SecretAccessKey: 'S3_SECRET_ACCESS_KEY'
} as const;

export const PHOTO_STORES = ['s3', 'memory'] as const;
export type PhotoStoreKind = (typeof PHOTO_STORES)[number];

export const PHOTO_DEFAULTS = {
	store: 's3' as PhotoStoreKind,
	/** 10 MB: the largest upload accepted, before processing. */
	maxBytes: 10 * 1024 * 1024,
	/** Uploads per user per sliding 24 hours (and analyses, counted separately). */
	dailyLimit: 20
};

/**
 * Thrown when the photo feature cannot be used as configured: an unknown
 * `PHOTO_STORE`, a missing S3 variable, or a malformed limit. Lists variable
 * NAMES only — never a value, since two of them are credentials.
 */
export class PhotoConfigError extends Error {
	constructor(readonly problems: string[]) {
		super(`Photo storage is not configured: ${problems.join('; ')}`);
		this.name = 'PhotoConfigError';
	}
}

const read = (env: Env, name: string): string | null => {
	const raw = env[name];
	return raw === undefined || raw.trim() === '' ? null : raw.trim();
};

export type S3Config = {
	endpoint: string;
	region: string;
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;
};

export type PhotoStoreConfig = { kind: 'memory' } | { kind: 's3'; s3: S3Config };

/** Which store to build. Throws `PhotoConfigError` naming every missing variable. */
export function resolvePhotoStoreConfig(env: Env = process.env): PhotoStoreConfig {
	const kind = read(env, PHOTO_ENV.store) ?? PHOTO_DEFAULTS.store;
	if (kind === 'memory') return { kind: 'memory' };
	if (kind !== 's3') {
		throw new PhotoConfigError([`${PHOTO_ENV.store} must be one of: ${PHOTO_STORES.join(', ')}`]);
	}
	const names = [
		PHOTO_ENV.s3Endpoint,
		PHOTO_ENV.s3Region,
		PHOTO_ENV.s3Bucket,
		PHOTO_ENV.s3AccessKeyId,
		PHOTO_ENV.s3SecretAccessKey
	] as const;
	const problems = names.filter((n) => !read(env, n)).map((n) => `${n} is not set`);
	if (problems.length) throw new PhotoConfigError(problems);
	return {
		kind: 's3',
		s3: {
			endpoint: read(env, PHOTO_ENV.s3Endpoint)!,
			region: read(env, PHOTO_ENV.s3Region)!,
			bucket: read(env, PHOTO_ENV.s3Bucket)!,
			accessKeyId: read(env, PHOTO_ENV.s3AccessKeyId)!,
			secretAccessKey: read(env, PHOTO_ENV.s3SecretAccessKey)!
		}
	};
}

export type PhotoLimits = { maxBytes: number; dailyLimit: number };

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
		problems.push(`${name} must be a whole number >= ${min}`);
		return fallback;
	}
	return n;
}

/**
 * The upload limits. A malformed value refuses the upload with
 * `PhotoConfigError`; it is never quietly replaced by the default (the 0.2.4
 * rule: a setting that is silently ignored is worse than one that refuses).
 */
export function resolvePhotoLimits(env: Env = process.env): PhotoLimits {
	const problems: string[] = [];
	const maxBytes = wholeNumber(env, PHOTO_ENV.maxBytes, PHOTO_DEFAULTS.maxBytes, 1, problems);
	const dailyLimit = wholeNumber(env, PHOTO_ENV.dailyLimit, PHOTO_DEFAULTS.dailyLimit, 0, problems);
	if (problems.length) throw new PhotoConfigError(problems);
	return { maxBytes, dailyLimit };
}
