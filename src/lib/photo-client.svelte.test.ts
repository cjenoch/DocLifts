/**
 * resizeForUpload in a real browser (the vitest `client` project, Chromium):
 * decode, orient, draw, export. Every fixture is generated here on a canvas;
 * none is a real photo. The size math alone is in photo-client.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { photoClientSettings, resizeForUpload } from './photo-client';

/** A noisy JPEG of `width` x `height`: noise keeps it large, like a camera photo. */
async function noisyJpeg(width: number, height: number, quality = 0.95): Promise<File> {
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext('2d')!;
	const image = ctx.createImageData(width, height);
	let seed = 0x2f6b;
	for (let i = 0; i < image.data.length; i += 4) {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		image.data[i] = seed & 0xff;
		image.data[i + 1] = (seed >> 8) & 0xff;
		image.data[i + 2] = (seed >> 16) & 0xff;
		image.data[i + 3] = 255;
	}
	ctx.putImageData(image, 0, 0);
	const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), 'image/jpeg', quality));
	return new File([blob], 'IMG_0420.JPG', { type: 'image/jpeg' });
}

/**
 * A JPEG stored sideways, as a phone writes it: left half red, right half
 * blue as stored, with EXIF orientation 6 ("rotate 90 degrees clockwise to
 * view"). Upright, its TOP is red.
 */
async function sidewaysJpeg(width: number, height: number): Promise<File> {
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext('2d')!;
	ctx.fillStyle = '#d00000';
	ctx.fillRect(0, 0, width / 2, height);
	ctx.fillStyle = '#0000d0';
	ctx.fillRect(width / 2, 0, width / 2, height);
	const blob = await new Promise<Blob>((r) => canvas.toBlob((b) => r(b!), 'image/jpeg', 0.95));
	const jpeg = new Uint8Array(await blob.arrayBuffer());
	// APP1 "Exif": big-endian TIFF, IFD0 with one entry, Orientation (0x0112) = 6.
	const tiff = [
		0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00,
		0x00, 0x01, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
	];
	const payload = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff];
	const length = payload.length + 2;
	const app1 = [0xff, 0xe1, length >> 8, length & 0xff, ...payload];
	const out = new Uint8Array(jpeg.length + app1.length);
	out.set(jpeg.subarray(0, 2)); // SOI
	out.set(app1, 2);
	out.set(jpeg.subarray(2), 2 + app1.length);
	return new File([out], 'sideways.jpg', { type: 'image/jpeg' });
}

/** Mean RGB of a horizontal band of the decoded image, top or bottom. */
async function band(file: File, where: 'top' | 'bottom') {
	const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
	const canvas = document.createElement('canvas');
	canvas.width = bitmap.width;
	canvas.height = bitmap.height;
	const ctx = canvas.getContext('2d')!;
	ctx.drawImage(bitmap, 0, 0);
	const h = Math.floor(bitmap.height / 4);
	const y = where === 'top' ? 0 : bitmap.height - h;
	const { data } = ctx.getImageData(0, y, bitmap.width, h);
	let r = 0;
	let b = 0;
	for (let i = 0; i < data.length; i += 4) {
		r += data[i];
		b += data[i + 2];
	}
	const n = data.length / 4;
	return { r: r / n, b: b / n };
}

const dimensions = async (file: File) => {
	const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
	const size = { width: bitmap.width, height: bitmap.height };
	bitmap.close();
	return size;
};

describe('resizeForUpload in the browser', () => {
	it('a large camera-sized photo comes back as a smaller JPEG within maxEdgePx', async () => {
		const original = await noisyJpeg(4000, 3000);
		expect(original.size).toBeGreaterThan(photoClientSettings.skipBelowBytes);

		const out = await resizeForUpload(original);
		expect(out).not.toBe(original);
		expect(out.type).toBe('image/jpeg');
		expect(out.name).toBe('IMG_0420.jpg');
		expect(out.size).toBeLessThan(original.size);
		const size = await dimensions(out);
		expect(Math.max(size.width, size.height)).toBe(photoClientSettings.maxEdgePx);
		expect(size).toEqual({ width: 2000, height: 1500 });
	});

	it('the second argument overrides a setting for one call', async () => {
		const original = await noisyJpeg(1600, 1200);
		const out = await resizeForUpload(original, { maxEdgePx: 800, skipBelowBytes: 0 });
		expect(await dimensions(out)).toEqual({ width: 800, height: 600 });
		expect(photoClientSettings.maxEdgePx).toBe(2000);
	});

	it('applies the EXIF orientation: a sideways photo comes back upright', async () => {
		const sideways = await sidewaysJpeg(400, 300);
		// The fixture is real: the browser reads its tag and turns it (400 x 300
		// stored, 300 x 400 upright).
		expect(await dimensions(sideways)).toEqual({ width: 300, height: 400 });
		const out = await resizeForUpload(sideways, { maxEdgePx: 200, skipBelowBytes: 0 });
		expect(out).not.toBe(sideways);
		expect(await dimensions(out)).toEqual({ width: 150, height: 200 });
		// The resized file carries no orientation tag, so decoding it either way
		// must already show red on top.
		const top = await band(out, 'top');
		const bottom = await band(out, 'bottom');
		expect(top.r).toBeGreaterThan(150);
		expect(top.b).toBeLessThan(60);
		expect(bottom.b).toBeGreaterThan(150);
		expect(bottom.r).toBeLessThan(60);
	});

	it('never upscales: a large file already within maxEdgePx is sent as it is', async () => {
		const original = await noisyJpeg(1800, 1350, 1);
		expect(original.size).toBeGreaterThan(photoClientSettings.skipBelowBytes);
		expect(await resizeForUpload(original)).toBe(original);
	});

	it('a file under skipBelowBytes is sent as it is', async () => {
		const original = await noisyJpeg(4000, 3000);
		const out = await resizeForUpload(original, { skipBelowBytes: original.size + 1 });
		expect(out).toBe(original);
	});

	it('enabled: false returns the original file unchanged', async () => {
		const original = await noisyJpeg(4000, 3000);
		const out = await resizeForUpload(original, { enabled: false });
		expect(out).toBe(original);
		expect(out.size).toBe(original.size);
	});

	it('a non-image falls back to the original file', async () => {
		// skipBelowBytes 0 so the decode really is attempted and fails.
		const text = new File(['not a photo at all, just text'], 'notes.jpg', {
			type: 'image/jpeg'
		});
		expect(await resizeForUpload(text, { skipBelowBytes: 0 })).toBe(text);
		const heicName = new File([new Uint8Array(4096).fill(7)], 'IMG_0001.HEIC', {
			type: 'image/heic'
		});
		expect(await resizeForUpload(heicName, { skipBelowBytes: 0 })).toBe(heicName);
	});

	it('the timeout sends the original', async () => {
		const original = await noisyJpeg(4000, 3000);
		expect(await resizeForUpload(original, { timeoutMs: 1 })).toBe(original);
	});
});
