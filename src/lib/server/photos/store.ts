/**
 * Where equipment photos live (0.4.0 §1).
 *
 * One interface, two implementations: `S3PhotoStore` for production (Linode
 * Object Storage is S3-compatible) and `MemoryPhotoStore` for tests and the
 * e2e harness. Selected by `PHOTO_STORE=s3|memory` (default `s3`), resolved
 * lazily on first use — never at import or boot — so a missing S3 variable is
 * a `PhotoConfigError` for the request that needed the store, and the app and
 * CI run with none set.
 *
 * The bucket is PRIVATE. Nothing is ever served by a public or presigned URL:
 * photos are read back only through the guarded `GET /photos/[id]/image`
 * route, which checks ownership like every other read and keeps the CSP's
 * `img-src 'self'` unchanged.
 */
import { Readable } from 'node:stream';
import {
	DeleteObjectCommand,
	ListObjectVersionsCommand,
	HeadObjectCommand,
	GetObjectCommand,
	NoSuchKey,
	PutObjectCommand,
	S3Client
} from '@aws-sdk/client-s3';
import { resolvePhotoStoreConfig, type Env, type S3Config } from './config';

export interface PhotoStore {
	put(key: string, body: Buffer, contentType: string): Promise<void>;
	get(key: string): Promise<{ body: Readable; contentType: string } | null>;
	delete(key: string): Promise<void>;
	/** Remove all versions; failures must remain pending. */
	erase?(key: string): Promise<void>;
	listOwned?(userId: string, limit: number): Promise<string[]>;
}

/** The object key for a photo. Everything a user uploads sits under their own prefix. */
export function photoKey(userId: string, photoId: string): string {
	return `users/${userId}/equipment-photos/${photoId}.jpg`;
}

/** A `Map`. For tests and the e2e harness; holds nothing across a restart. */
export class MemoryPhotoStore implements PhotoStore {
	private readonly objects = new Map<string, { body: Buffer; contentType: string }>();

	async put(key: string, body: Buffer, contentType: string): Promise<void> {
		this.objects.set(key, { body: Buffer.from(body), contentType });
	}

	async get(key: string) {
		const hit = this.objects.get(key);
		return hit ? { body: Readable.from(hit.body), contentType: hit.contentType } : null;
	}

	async delete(key: string): Promise<void> {
		this.objects.delete(key);
	}

	async erase(key: string): Promise<void> {
		await this.delete(key);
	}
	async listOwned(userId: string, limit: number) {
		return this.keys()
			.filter((key) => key.startsWith(`users/${userId}/equipment-photos/`))
			.slice(0, limit);
	}

	/** Test helper: the keys currently stored. */
	keys(): string[] {
		return [...this.objects.keys()];
	}
}

/** The part of `S3Client` the store uses, so a test can hand it a fake. */
export type S3Sender = Pick<S3Client, 'send'>;

export function createS3Client(config: S3Config): S3Client {
	return new S3Client({
		endpoint: config.endpoint,
		region: config.region,
		credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
		// The SDK's default since 3.729 adds CRC32 checksums to every request,
		// which several S3-compatible stores reject. Send them only where the
		// API requires one; plain PUT/GET/DELETE do not.
		requestChecksumCalculation: 'WHEN_REQUIRED',
		responseChecksumValidation: 'WHEN_REQUIRED'
	});
}

export class S3PhotoStore implements PhotoStore {
	constructor(
		private readonly bucket: string,
		private readonly client: S3Sender
	) {}

	async put(key: string, body: Buffer, contentType: string): Promise<void> {
		await this.client.send(
			new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
			{ abortSignal: AbortSignal.timeout(30000) }
		);
	}

	async get(key: string) {
		try {
			const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
			if (!out.Body) return null;
			const body = out.Body instanceof Readable ? out.Body : Readable.from(out.Body as never);
			return { body, contentType: out.ContentType ?? 'image/jpeg' };
		} catch (error) {
			if (error instanceof NoSuchKey || (error as { name?: string })?.name === 'NoSuchKey') {
				return null;
			}
			throw error;
		}
	}

	async delete(key: string): Promise<void> {
		// S3 answers a delete of a missing key with success, so discard is idempotent.
		await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
	}
	async listOwned(userId: string, limit: number): Promise<string[]> {
		const prefix = `users/${userId}/equipment-photos/`;
		const page = await this.client.send(
			new ListObjectVersionsCommand({ Bucket: this.bucket, Prefix: prefix, MaxKeys: limit }),
			{ abortSignal: AbortSignal.timeout(30000) }
		);
		return [
			...new Set(
				[...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])]
					.map((v) => v.Key)
					.filter((key): key is string => !!key && key.startsWith(prefix))
			)
		];
	}
	async erase(key: string): Promise<void> {
		const signal = AbortSignal.timeout(30000);
		// Exact-key filtering protects similarly prefixed objects. Every invocation is
		// bounded; a heavily versioned key remains pending for the next worker pass.
		const versions = await this.client.send(
			new ListObjectVersionsCommand({
				Bucket: this.bucket,
				Prefix: key,
				MaxKeys: 200
			}),
			{ abortSignal: signal }
		);
		for (const version of [...(versions.Versions ?? []), ...(versions.DeleteMarkers ?? [])]) {
			if (version.Key !== key) continue;
			if (!version.VersionId) throw new Error('Object store omitted version identity');
			await this.client.send(
				new DeleteObjectCommand({ Bucket: this.bucket, Key: key, VersionId: version.VersionId }),
				{ abortSignal: signal }
			);
		}
		if (versions.IsTruncated) throw new Error('Object versions remain; retry cleanup');
		const check = await this.client.send(
			new ListObjectVersionsCommand({ Bucket: this.bucket, Prefix: key, MaxKeys: 200 }),
			{ abortSignal: signal }
		);
		if (
			check.IsTruncated ||
			[...(check.Versions ?? []), ...(check.DeleteMarkers ?? [])].some((v) => v.Key === key)
		)
			throw new Error('Object versions remain; retry cleanup');
		// A successful version listing plus absence of a live object is required.
		// Unsupported APIs, permissions, legal holds and replicas never become success.
		try {
			await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }), {
				abortSignal: signal
			});
		} catch (error) {
			if (
				(error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 404 ||
				['NotFound', 'NoSuchKey'].includes((error as { name?: string })?.name ?? '')
			)
				return;
			throw error;
		}
		throw new Error('Object still present');
	}
}

/** Build the store the environment names. Throws `PhotoConfigError`. */
export function createPhotoStore(env: Env = process.env): PhotoStore {
	const config = resolvePhotoStoreConfig(env);
	if (config.kind === 'memory') return new MemoryPhotoStore();
	return new S3PhotoStore(config.s3.bucket, createS3Client(config.s3));
}

let current: PhotoStore | undefined;

/**
 * The process's store, built on first use from `process.env`, never at import.
 * A config error is thrown to the caller and not cached; the env is read again
 * on the next use (in practice, fix the env file and restart the container).
 */
export function photoStore(): PhotoStore {
	current ??= createPhotoStore(process.env);
	return current;
}

/** Test seam: replace (or with no argument, forget) the process's store. */
export function setPhotoStoreForTests(store?: PhotoStore): void {
	current = store;
}
