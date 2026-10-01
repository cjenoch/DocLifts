/**
 * Upload processing (0.4.0 §3), with sharp.
 *
 * THE PRIVACY PROPERTY: the stored image — the only one that is ever kept, and
 * the only one ever sent to a model — carries NO metadata. sharp writes none
 * unless asked (`withMetadata()` / `keepMetadata()`), and this module never
 * asks. GPS position, device make and model, timestamps and the camera's
 * thumbnail are gone before the image is stored or analyzed. The EXIF
 * orientation is applied to the pixels first, so dropping it does not leave
 * the photo sideways. `process.test.ts` checks the output has no EXIF at all.
 *
 * The output is always a JPEG, quality 85, at most 1600 px on its long edge.
 */
import { createHash } from 'node:crypto';
import sharp from 'sharp';

export const MAX_EDGE_PX = 1600;
export const JPEG_QUALITY = 85;
export const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

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

const looksHeic = (type: string | undefined, name: string | undefined) =>
	/^image\/hei[cf]/i.test(type ?? '') || /\.hei[cf]$/i.test(name ?? '');

/**
 * Validate, auto-orient, resize, re-encode and strip one upload.
 *
 * `type` and `name` are what the browser declared; they are used only to give
 * HEIC its own message. The decision is made on the decoded bytes.
 */
export async function processPhoto(
	input: Uint8Array,
	opts: { maxBytes: number; type?: string; name?: string }
): Promise<ProcessedPhoto> {
	if (input.byteLength === 0) throw new PhotoInputError('Choose a photo to upload.');
	if (input.byteLength > opts.maxBytes) {
		throw new PhotoInputError(
			`The photo is ${megabytes(input.byteLength)}; the limit is ${megabytes(opts.maxBytes)}.`
		);
	}
	if (looksHeic(opts.type, opts.name)) throw new PhotoInputError(HEIC_MESSAGE);

	let format: string | undefined;
	try {
		format = (await sharp(input).metadata()).format;
	} catch {
		throw new PhotoInputError('That file is not an image this app can read. Use JPEG or PNG.');
	}
	if (format === 'heif') throw new PhotoInputError(HEIC_MESSAGE);
	if (format !== 'jpeg' && format !== 'png' && format !== 'webp') {
		throw new PhotoInputError('Upload a JPEG, PNG or WebP photo.');
	}

	try {
		const { data, info } = await sharp(input, { failOn: 'error' })
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
