/**
 * Upload processing (0.4.0 §3), with sharp.
 *
 * THE PRIVACY PROPERTY: the stored image — the only one that is ever kept, and
 * the cleaned form sent to models — carries NO metadata. sharp writes none
 * unless asked (`withMetadata()` / `keepMetadata()`), and this module never
 * asks. GPS position, device make and model, timestamps and the camera's
 * thumbnail are gone before the image is stored or analyzed. The EXIF
 * orientation is applied to the pixels first, so dropping it does not leave
 * the photo sideways. `process.test.ts` checks the output has no EXIF at all.
 *
 * The output is always a JPEG, quality 85, at most 1600 px on its long edge.
 *
 * MEMORY (0.5.3): a small file can declare an enormous image, and a decode
 * allocates for the declared size. So an image over `MAX_INPUT_PIXELS` is
 * refused from its header alone, before any decode, and the decode itself is
 * capped at the same number in case the header lies. At most
 * `MAX_CONCURRENT_PROCESSING` decodes run at once; the rest wait their turn.
 */
import { createHash } from 'node:crypto';
import sharp, { type Metadata } from 'sharp';
import type { PhotoTimings } from './timings';

export const MAX_EDGE_PX = 1600;
export const JPEG_QUALITY = 85;
export const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

/** Largest image accepted, in pixels (width x height as declared): 50 megapixels. */
export const MAX_INPUT_PIXELS = 50_000_000;

/**
 * How many photos are decoded and re-encoded at once in this process. The
 * web container is capped at 2 GiB; sharp would otherwise run up to four
 * large decodes together on libuv's default pool.
 */
export const MAX_CONCURRENT_PROCESSING = 2;

/** A tiny counting semaphore: `run` waits for a free slot, FIFO. No dependency. */
export function createSemaphore(max: number) {
	let active = 0;
	const waiting: (() => void)[] = [];
	return {
		async run<T>(fn: () => Promise<T>): Promise<T> {
			if (active < max) active++;
			// A released slot is handed straight to the next waiter, so
			// `active` never drops and rises again in between.
			else await new Promise<void>((resolve) => waiting.push(resolve));
			try {
				return await fn();
			} finally {
				const next = waiting.shift();
				if (next) next();
				else active--;
			}
		},
		/** For tests: slots in use, and callers queued. */
		get active() {
			return active;
		},
		get queued() {
			return waiting.length;
		}
	};
}

/** The one gate every decode in this process goes through. */
export const processingGate = createSemaphore(MAX_CONCURRENT_PROCESSING);

/** A refusal the user can act on; the message is shown on the page as is. */
export class PhotoInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PhotoInputError';
	}
}

export const HEIC_MESSAGE =
	'This photo is HEIC, which is not supported. Upload it as JPEG (on an iPhone, Settings > Camera > Formats > Most Compatible).';

export type ProcessedPhoto = {
	body: Buffer;
	contentType: 'image/jpeg';
	bytes: number;
	width: number;
	height: number;
	sha256: string;
};

const megabytes = (n: number) => `${Math.round((n / (1024 * 1024)) * 10) / 10} MB`;
const megapixels = (n: number) => Math.round(n / 100_000) / 10;

export const pixelLimitMessage = (width: number, height: number) =>
	`This photo is ${width}×${height} (${megapixels(width * height)} megapixels); the limit is ${megapixels(MAX_INPUT_PIXELS)}. Take it at a lower resolution.`;

const looksHeic = (type: string | undefined, name: string | undefined) =>
	/^image\/hei[cf]/i.test(type ?? '') || /\.hei[cf]$/i.test(name ?? '');

/**
 * Validate, auto-orient, resize, re-encode and strip one upload.
 *
 * `type` and `name` are what the browser declared; they are used only to give
 * HEIC its own message. The decision is made on the decoded bytes.
 *
 * `opts.timings`, when given, receives `processWaitMs` (queued for a decode
 * slot) and `processMs` (this function's own work, the wait excluded). A
 * refusal from the checks before the gate leaves `processWaitMs` null.
 */
export async function processPhoto(
	input: Uint8Array,
	opts: {
		maxBytes: number;
		type?: string;
		name?: string;
		timings?: Pick<PhotoTimings, 'processMs' | 'processWaitMs'>;
	}
): Promise<ProcessedPhoto> {
	const start = performance.now();
	let waited = 0;
	try {
		return await checkAndProcess(input, opts, (ms) => {
			waited = ms;
			if (opts.timings) opts.timings.processWaitMs = Math.max(0, Math.round(ms));
		});
	} finally {
		if (opts.timings) {
			opts.timings.processMs = Math.max(0, Math.round(performance.now() - start - waited));
		}
	}
}

async function checkAndProcess(
	input: Uint8Array,
	opts: { maxBytes: number; type?: string; name?: string },
	onWaited: (ms: number) => void
): Promise<ProcessedPhoto> {
	if (input.byteLength === 0) throw new PhotoInputError('Choose a photo to upload.');
	if (input.byteLength > opts.maxBytes) {
		throw new PhotoInputError(
			`The photo is ${megabytes(input.byteLength)}; the limit is ${megabytes(opts.maxBytes)}.`
		);
	}
	if (looksHeic(opts.type, opts.name)) throw new PhotoInputError(HEIC_MESSAGE);

	// Header only: metadata() reads the format and declared size, no pixels.
	// sharp applies its own default pixel limit even here; it is switched off
	// for this read so an oversized photo gets the pixel message below rather
	// than "not an image". The decode keeps the limit (decodeAndEncode).
	let header: Metadata;
	try {
		header = await sharp(input, { limitInputPixels: false }).metadata();
	} catch {
		throw new PhotoInputError('That file is not an image this app can read. Use JPEG or PNG.');
	}
	const { format, width = 0, height = 0 } = header;
	if (format === 'heif') throw new PhotoInputError(HEIC_MESSAGE);
	if (format !== 'jpeg' && format !== 'png' && format !== 'webp') {
		throw new PhotoInputError('Upload a JPEG, PNG or WebP photo.');
	}
	if (width * height > MAX_INPUT_PIXELS) {
		throw new PhotoInputError(pixelLimitMessage(width, height));
	}

	const queued = performance.now();
	return processingGate.run(async () => {
		onWaited(performance.now() - queued);
		return decodeAndEncode(input);
	});
}

/**
 * The decode, orient, resize and re-encode. `limitInputPixels` makes sharp
 * itself refuse an image over the limit, so a header that understates the
 * size still cannot force a huge decode.
 */
export async function decodeAndEncode(input: Uint8Array): Promise<ProcessedPhoto> {
	try {
		const { data, info } = await sharp(input, {
			failOn: 'error',
			limitInputPixels: MAX_INPUT_PIXELS
		})
			.autoOrient()
			.resize({
				width: MAX_EDGE_PX,
				height: MAX_EDGE_PX,
				fit: 'inside',
				withoutEnlargement: true
			})
			// No withMetadata()/keepMetadata(): the output carries no EXIF, ICC
			// or XMP. That is the privacy property above; do not add one.
			.jpeg({ quality: JPEG_QUALITY })
			.toBuffer({ resolveWithObject: true });
		return {
			body: data,
			contentType: 'image/jpeg',
			bytes: data.byteLength,
			width: info.width,
			height: info.height,
			sha256: createHash('sha256').update(data).digest('hex')
		};
	} catch {
		throw new PhotoInputError('That image could not be read. Try taking the photo again.');
	}
}
