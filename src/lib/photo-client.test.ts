/**
 * The size math for resize-on-the-phone (0.5.0 Part A), and the missing-API
 * fallback: this file runs in Node, which has no createImageBitmap, exactly
 * like an old browser. The browser path is in photo-client.svelte.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { photoClientSettings, resizeForUpload, targetSize } from './photo-client';

describe('targetSize', () => {
	it('scales the longer edge to maxEdgePx and keeps the aspect ratio', () => {
		expect(targetSize(4000, 3000, 2000)).toEqual({ width: 2000, height: 1500 });
		expect(targetSize(3000, 4000, 2000)).toEqual({ width: 1500, height: 2000 });
		expect(targetSize(4032, 3024, 2000)).toEqual({ width: 2000, height: 1500 });
		// An odd ratio rounds, and stays within a pixel of the original ratio.
		const odd = targetSize(4001, 2999, 2000)!;
		expect(Math.max(odd.width, odd.height)).toBe(2000);
		expect(Math.abs(odd.width / odd.height - 4001 / 2999)).toBeLessThan(0.002);
	});

	it('never upscales: a photo already within maxEdgePx needs no resize', () => {
		expect(targetSize(2000, 1500, 2000)).toBeNull();
		expect(targetSize(1200, 1600, 2000)).toBeNull();
		expect(targetSize(10, 10, 2000)).toBeNull();
	});

	it('a very long, thin image keeps at least one pixel on its short side', () => {
		expect(targetSize(100_000, 10, 2000)).toEqual({ width: 2000, height: 1 });
	});

	it('nonsense dimensions or limits mean no resize', () => {
		expect(targetSize(NaN, 3000, 2000)).toBeNull();
		expect(targetSize(4000, 3000, 0)).toBeNull();
		expect(targetSize(4000, 3000, NaN)).toBeNull();
	});
});

describe('resizeForUpload without the browser APIs', () => {
	it('returns the original file itself when createImageBitmap does not exist', async () => {
		expect(typeof globalThis.createImageBitmap).toBe('undefined');
		const big = new File([new Uint8Array(photoClientSettings.skipBelowBytes + 1)], 'a.jpg', {
			type: 'image/jpeg'
		});
		expect(await resizeForUpload(big)).toBe(big);
	});
});
