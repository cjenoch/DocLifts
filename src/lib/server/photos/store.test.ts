/**
 * The photo store (0.4.0 §1), entirely offline: the S3 store is handed a fake
 * client that records the commands it is sent, so nothing here reaches a
 * network. The lazy-config tests prove the feature needs no S3 variable to
 * import, and names (never echoes) the missing ones when it is used.
 */
import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import {
	DeleteObjectCommand,
	GetObjectCommand,
	NoSuchKey,
	PutObjectCommand
} from '@aws-sdk/client-s3';
import { MemoryPhotoStore, S3PhotoStore, createPhotoStore, photoKey, type S3Sender } from './store';
import {
	PHOTO_DEFAULTS,
	PhotoConfigError,
	resolvePhotoLimits,
	resolvePhotoStoreConfig
} from './config';

const text = async (r: Readable) => {
	const chunks: Buffer[] = [];
	for await (const c of r) chunks.push(Buffer.from(c));
	return Buffer.concat(chunks).toString('utf8');
};

describe('photoKey', () => {
	it('puts every photo under its owner’s prefix', () => {
		expect(photoKey('user-1', 'photo-9')).toBe('users/user-1/equipment-photos/photo-9.jpg');
	});
});

describe('MemoryPhotoStore', () => {
	it('puts, gets back the same bytes and type, and deletes', async () => {
		const store = new MemoryPhotoStore();
		await store.put('k', Buffer.from('jpeg bytes'), 'image/jpeg');
		const got = await store.get('k');
		expect(got?.contentType).toBe('image/jpeg');
		expect(await text(got!.body)).toBe('jpeg bytes');
		await store.delete('k');
		expect(await store.get('k')).toBeNull();
	});

	it('answers null for a key it never stored', async () => {
		expect(await new MemoryPhotoStore().get('missing')).toBeNull();
	});
});

/** A fake S3 client: records each command and answers with `reply`. */
function fakeClient(reply: (command: unknown) => unknown = () => ({})) {
	const sent: unknown[] = [];
	const client: S3Sender = {
		send: (async (command: unknown) => {
			sent.push(command);
			return reply(command);
		}) as S3Sender['send']
	};
	return { client, sent };
}

describe('S3PhotoStore (fake client, no network)', () => {
	it('PUTs to the bucket under the key with the content type', async () => {
		const { client, sent } = fakeClient();
		const store = new S3PhotoStore('doclifts-photos', client);
		const key = photoKey('u1', 'p1');
		await store.put(key, Buffer.from('x'), 'image/jpeg');
		expect(sent).toHaveLength(1);
		expect(sent[0]).toBeInstanceOf(PutObjectCommand);
		expect((sent[0] as PutObjectCommand).input).toMatchObject({
			Bucket: 'doclifts-photos',
			Key: 'users/u1/equipment-photos/p1.jpg',
			ContentType: 'image/jpeg'
		});
	});

	it('GETs a stream and its content type, and maps NoSuchKey to null', async () => {
		const { client, sent } = fakeClient((command) => {
			if ((command as GetObjectCommand).input.Key === 'gone') {
				throw new NoSuchKey({ message: 'no', $metadata: {} });
			}
			return { Body: Readable.from(Buffer.from('bytes')), ContentType: 'image/jpeg' };
		});
		const store = new S3PhotoStore('b', client);
		const got = await store.get('present');
		expect(sent[0]).toBeInstanceOf(GetObjectCommand);
		expect((sent[0] as GetObjectCommand).input).toEqual({ Bucket: 'b', Key: 'present' });
		expect(got?.contentType).toBe('image/jpeg');
		expect(await text(got!.body)).toBe('bytes');
		expect(await store.get('gone')).toBeNull();
	});

	it('DELETEs by bucket and key', async () => {
		const { client, sent } = fakeClient();
		await new S3PhotoStore('b', client).delete('k');
		expect(sent[0]).toBeInstanceOf(DeleteObjectCommand);
		expect((sent[0] as DeleteObjectCommand).input).toEqual({ Bucket: 'b', Key: 'k' });
	});

	it('does not swallow other errors', async () => {
		const { client } = fakeClient(() => {
			throw Object.assign(new Error('denied'), { name: 'AccessDenied' });
		});
		await expect(new S3PhotoStore('b', client).get('k')).rejects.toThrow('denied');
	});
});

describe('store selection (lazy, names not values)', () => {
	const S3_ENV = {
		S3_ENDPOINT: 'https://objects.example.invalid',
		S3_REGION: 'us-east-1',
		S3_BUCKET: 'bucket',
		S3_ACCESS_KEY_ID: 'AKIA-not-real',
		S3_SECRET_ACCESS_KEY: 'secret-not-real'
	};

	it('defaults to s3 and builds it when every variable is set', () => {
		expect(resolvePhotoStoreConfig(S3_ENV)).toMatchObject({ kind: 's3', s3: { bucket: 'bucket' } });
		expect(createPhotoStore(S3_ENV)).toBeInstanceOf(S3PhotoStore);
	});

	it('PHOTO_STORE=memory needs no S3 variable', () => {
		expect(createPhotoStore({ PHOTO_STORE: 'memory' })).toBeInstanceOf(MemoryPhotoStore);
	});

	it('a missing S3 variable is a typed error naming it, never its value', () => {
		const env = { ...S3_ENV, S3_BUCKET: '', S3_SECRET_ACCESS_KEY: undefined };
		let caught: unknown;
		try {
			createPhotoStore(env);
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(PhotoConfigError);
		const err = caught as PhotoConfigError;
		expect(err.problems).toEqual(['S3_BUCKET is not set', 'S3_SECRET_ACCESS_KEY is not set']);
		expect(err.message).not.toContain('AKIA-not-real');
	});

	it('an unknown PHOTO_STORE is refused', () => {
		expect(() => createPhotoStore({ PHOTO_STORE: 'disk' })).toThrow(PhotoConfigError);
	});

	it('limits default, and a malformed one refuses rather than falls back', () => {
		expect(resolvePhotoLimits({})).toEqual({
			maxBytes: PHOTO_DEFAULTS.maxBytes,
			dailyLimit: PHOTO_DEFAULTS.dailyLimit
		});
		expect(PHOTO_DEFAULTS).toMatchObject({ maxBytes: 10 * 1024 * 1024, dailyLimit: 20 });
		expect(resolvePhotoLimits({ PHOTO_MAX_BYTES: '2048', PHOTO_DAILY_LIMIT: '0' })).toEqual({
			maxBytes: 2048,
			dailyLimit: 0
		});
		expect(() => resolvePhotoLimits({ PHOTO_DAILY_LIMIT: 'lots' })).toThrow(
			'PHOTO_DAILY_LIMIT must be a whole number >= 0'
		);
	});
});
