/**
 * Generated test photos. Never a real photo of a person or a place: every
 * fixture is synthesized here, with sharp, at test time.
 *
 * `phonePhoto()` is what a phone hands the browser: a 4000 x 3000 JPEG stored
 * sideways with EXIF orientation 6 ("rotate 90 degrees clockwise to view"),
 * and GPS, make and model tags. Its left half is red and its right half blue
 * AS STORED, so after correct auto-orientation the TOP of the image is red —
 * a test can tell orientation was applied, not just that a tag was dropped.
 * Mid-frequency noise keeps it well over adapter-node's 512 KB default body
 * limit and well under PHOTO_MAX_BYTES.
 *
 * Imported only by tests. Not used by production code.
 */
import sharp from 'sharp';
import type { EquipmentCandidate } from './analyze';
import { MemoryPhotoStore } from './store';

/** A memory store that counts its reads, to prove which paths read the store back. */
export class CountingPhotoStore extends MemoryPhotoStore {
	gets = 0;
	override async get(key: string) {
		this.gets++;
		return super.get(key);
	}
}

export const FIXTURE_GPS = {
	GPSLatitudeRef: 'N',
	GPSLatitude: '51/1 28/1 4000/100',
	GPSLongitudeRef: 'W',
	GPSLongitude: '0/1 0/1 500/100'
};

export async function phonePhoto(width = 4000, height = 3000): Promise<Buffer> {
	// Low-resolution noise, scaled up: texture that JPEG cannot compress away,
	// without the 10+ MB a full-resolution noise field would encode to.
	const nw = Math.ceil(width / 4);
	const nh = Math.ceil(height / 4);
	const noise = Buffer.alloc(nw * nh * 3);
	let seed = 0x2f6b;
	for (let i = 0; i < noise.length; i++) {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		noise[i] = seed >> 23;
	}
	const texture = await sharp(noise, { raw: { width: nw, height: nh, channels: 3 } })
		.resize(width, height, { kernel: 'nearest' })
		.raw()
		.toBuffer();
	const pixels = Buffer.alloc(width * height * 3);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = (y * width + x) * 3;
			const left = x < width / 2;
			// Strong red or blue, with the texture on top at low amplitude.
			pixels[i] = left ? 200 + (texture[i] >> 3) : texture[i] >> 3;
			pixels[i + 1] = texture[i + 1] >> 3;
			pixels[i + 2] = left ? texture[i + 2] >> 3 : 200 + (texture[i + 2] >> 3);
		}
	}
	return (
		sharp(pixels, { raw: { width, height, channels: 3 } })
			.jpeg({ quality: 92 })
			.withExif({
				IFD0: { Make: 'FixtureCam', Model: 'Synthetic 1' },
				IFD3: FIXTURE_GPS
			})
			// Orientation goes through withMetadata: sharp writes its own
			// Orientation tag and would overwrite one set in IFD0 above.
			.withMetadata({ orientation: 6 })
			.toBuffer()
	);
}

/** A small PNG (no EXIF), for the "PNG is re-encoded as JPEG" case. */
export function smallPng(width = 300, height = 200): Promise<Buffer> {
	return sharp({
		create: { width, height, channels: 3, background: { r: 10, g: 120, b: 30 } }
	})
		.png()
		.toBuffer();
}

/** A candidate as the model would return it for a Hammer Strength Iso-Lateral Row placard. */
export const FIXTURE_CANDIDATE: EquipmentCandidate = {
	placard_text: 'HAMMER STRENGTH  ISO-LATERAL ROW  IL-ROW',
	manufacturer: 'Hammer Strength',
	product_line: 'Plate Loaded',
	model_code: 'IL-ROW',
	name: 'Iso-Lateral Row',
	loading_type: 'plate_loaded',
	laterality: 'independent',
	starting_resistance_lb: null,
	stack_lb: null,
	field_confidence: { manufacturer: 0.95, model_code: 0.9, name: 0.85, loading_type: 0.5 },
	notes: 'Lower half of the placard is scratched.'
};

/**
 * The image bytes a mock model (llm/test-models.ts) was sent in its `n`th
 * call: the prompt's file part, `{ type: 'data', data }` in the SDK's shape.
 */
export function imageSentTo(
	model: { doGenerateCalls: { prompt: unknown[] }[] },
	n: number
): Buffer {
	const message = model.doGenerateCalls[n].prompt[1] as {
		content: { type: string; data?: unknown }[];
	};
	const part = message.content.find((p) => p.type === 'file')?.data as
		| { type: 'data'; data: Uint8Array }
		| Uint8Array
		| undefined;
	if (!part) throw new Error('no image was sent');
	return Buffer.from(part instanceof Uint8Array ? part : part.data);
}
