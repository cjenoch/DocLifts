/**
 * Upload processing (0.4.0 §3/§7) on generated fixtures — never a real photo.
 *
 * The phone fixture is 4000 x 3000, stored sideways with EXIF orientation 6
 * and GPS/make/model tags, red on its stored LEFT half. Correct processing
 * gives a portrait image <= 1600 px whose TOP is red, with no EXIF at all.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
	decodeAndEncode,
	HEIC_MESSAGE,
	MAX_INPUT_PIXELS,
	PhotoInputError,
	pixelLimitMessage,
	processPhoto
} from './process';
import { handmadePng, phonePhoto, smallPng } from './test-fixtures';
import { emptyTimings } from './timings';

const MAX = 10 * 1024 * 1024;
let phone: Buffer;
beforeAll(async () => {
	phone = await phonePhoto();
});

/** The GPS IFD pointer tag (0x8825) in either byte order. */
const hasGpsPointer = (exif: Buffer) =>
	exif.includes(Buffer.from([0x88, 0x25])) || exif.includes(Buffer.from([0x25, 0x88]));

describe('processPhoto', () => {
	it('the fixture really is what a phone sends: 4000x3000, orientation 6, GPS', async () => {
		// Positive first: a fixture with no EXIF would make "no EXIF out" vacuous.
		const m = await sharp(phone).metadata();
		expect([m.width, m.height, m.orientation]).toEqual([4000, 3000, 6]);
		expect(m.exif && hasGpsPointer(m.exif)).toBe(true);
		expect(m.exif!.toString('latin1')).toContain('FixtureCam');
		expect(phone.byteLength).toBeGreaterThan(512 * 1024);
	});

	it('orients, resizes to 1600 on the long edge, re-encodes JPEG, and strips ALL metadata', async () => {
		const out = await processPhoto(phone, { maxBytes: MAX, type: 'image/jpeg' });
		expect(out.contentType).toBe('image/jpeg');
		// Orientation 6 applied: the 4000x3000 landscape is now portrait.
		expect([out.width, out.height]).toEqual([1200, 1600]);
		const m = await sharp(out.body).metadata();
		expect(m.format).toBe('jpeg');
		expect([m.width, m.height]).toEqual([1200, 1600]);
		// THE privacy property: no EXIF block at all, so no GPS, make or model.
		expect(m.exif).toBeUndefined();
		expect(m.orientation).toBeUndefined();
		expect(m.xmp).toBeUndefined();
		expect(out.body.toString('latin1')).not.toContain('FixtureCam');
		// And the pixels were turned, not just the tag dropped: red is on top.
		const { data } = await sharp(out.body)
			.extract({ left: 600, top: 200, width: 1, height: 1 })
			.raw()
			.toBuffer({ resolveWithObject: true });
		expect(data[0]).toBeGreaterThan(150); // red
		expect(data[2]).toBeLessThan(100);
		expect(out.bytes).toBe(out.body.byteLength);
		expect(out.sha256).toMatch(/^[0-9a-f]{64}$/);
	});

	it('refuses a 12 MB upload before decoding it', async () => {
		const big = Buffer.alloc(12 * 1024 * 1024, 0xff);
		await expect(processPhoto(big, { maxBytes: MAX })).rejects.toThrow(
			new PhotoInputError('The photo is 12 MB; the limit is 10 MB.')
		);
	});

	it('accepts a PNG and re-encodes it as JPEG, never enlarging it', async () => {
		const out = await processPhoto(await smallPng(), { maxBytes: MAX, type: 'image/png' });
		expect((await sharp(out.body).metadata()).format).toBe('jpeg');
		expect([out.width, out.height]).toEqual([300, 200]);
	});

	it('refuses HEIC by name or type with the "use JPEG" message, and non-images', async () => {
		await expect(
			processPhoto(Buffer.from('x'), { maxBytes: MAX, type: 'image/heic', name: 'a.HEIC' })
		).rejects.toThrow(HEIC_MESSAGE);
		await expect(
			processPhoto(Buffer.from('not an image'), { maxBytes: MAX, type: 'image/jpeg' })
		).rejects.toBeInstanceOf(PhotoInputError);
		await expect(processPhoto(Buffer.alloc(0), { maxBytes: MAX })).rejects.toThrow(
			'Choose a photo to upload.'
		);
	});

	it('refuses an image format it does not accept', async () => {
		const gif = await sharp({
			create: { width: 4, height: 4, channels: 3, background: '#000' }
		})
			.gif()
			.toBuffer();
		await expect(processPhoto(gif, { maxBytes: MAX })).rejects.toThrow(
			'Upload a JPEG, PNG or WebP photo.'
		);
	});
});

describe('the pixel limit (0.5.3)', () => {
	it('the limit is 50 megapixels, and a 4000 x 3000 phone photo is well within it', async () => {
		expect(MAX_INPUT_PIXELS).toBe(50_000_000);
		const out = await processPhoto(phone, { maxBytes: MAX, type: 'image/jpeg' });
		expect([out.width, out.height]).toEqual([1200, 1600]);
	});

	it('a small file declaring 20000 x 20000 is refused from its header, before any decode', async () => {
		const bomb = handmadePng(20000, 20000);
		// Small on disk, far under the byte limit: only the pixel check stops it.
		expect(bomb.byteLength).toBeLessThan(1024);
		expect(bomb.byteLength).toBeLessThan(MAX);
		// Positive first: the header really declares 20000 x 20000.
		const header = await sharp(bomb, { limitInputPixels: false }).metadata();
		expect([header.format, header.width, header.height]).toEqual(['png', 20000, 20000]);

		const timings = emptyTimings();
		const refused = processPhoto(bomb, { maxBytes: MAX, type: 'image/png', timings });
		await expect(refused).rejects.toThrow(new PhotoInputError(pixelLimitMessage(20000, 20000)));
		expect(pixelLimitMessage(20000, 20000)).toBe(
			'This photo is 20000×20000 (400 megapixels); the limit is 50. Take it at a lower resolution.'
		);
		// Never queued for a decode slot: the decode is inside the gate.
		expect(timings.processWaitMs).toBeNull();
		// And its pixel data cannot decode: had a decode run, the message would
		// be "could not be read" — as it is for the same data at a small size.
		await expect(
			processPhoto(handmadePng(100, 100), { maxBytes: MAX, type: 'image/png' })
		).rejects.toThrow('That image could not be read. Try taking the photo again.');
	});

	it('the decode itself refuses more than the limit, whatever the header check did', async () => {
		// 10000 x 6000 = 60 MP: over the limit, under sharp's own default.
		const big = handmadePng(10000, 6000, { bitDepth: 1, idat: 'zeros' });
		expect(big.byteLength).toBeLessThan(64 * 1024);
		await expect(decodeAndEncode(big)).rejects.toBeInstanceOf(PhotoInputError);
		// Positive control: the same image at 5000 x 6000 (30 MP) decodes.
		const ok = await decodeAndEncode(handmadePng(5000, 6000, { bitDepth: 1, idat: 'zeros' }));
		expect(Math.max(ok.width, ok.height)).toBe(1600);
	});
});
