/**
 * The client's measurement fields are parsed defensively: anything that is not
 * exactly what the page sends is null, never an error and never a guess.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clientMeasurement, logUpload } from './upload-log';

const form = (fields: Record<string, string | Blob>) => {
	const f = new FormData();
	for (const [k, v] of Object.entries(fields)) f.append(k, v);
	return f;
};

describe('clientMeasurement', () => {
	it('reads what the page sends', () => {
		expect(clientMeasurement(form({ clientOriginalBytes: '4123456', clientResized: '1' }))).toEqual(
			{ clientOriginalBytes: 4123456, clientResized: true }
		);
		expect(clientMeasurement(form({ clientOriginalBytes: '0', clientResized: '0' }))).toEqual({
			clientOriginalBytes: 0,
			clientResized: false
		});
	});

	it('absent fields (no JavaScript, or an old page) are null', () => {
		expect(clientMeasurement(form({}))).toEqual({
			clientOriginalBytes: null,
			clientResized: null
		});
	});

	it.each([
		['-5'],
		['1.5'],
		['1e6'],
		[' 12'],
		['0x10'],
		['99999999999'],
		['1000000001'],
		[''],
		['abc']
	])('a malformed or absurd byte count (%j) is null', (value) => {
		expect(clientMeasurement(form({ clientOriginalBytes: value })).clientOriginalBytes).toBeNull();
	});

	it('anything but "1" or "0" for clientResized is null, and a file in either field is null', () => {
		for (const v of ['true', 'yes', '', '2']) {
			expect(clientMeasurement(form({ clientResized: v })).clientResized).toBeNull();
		}
		const blob = new Blob(['1']);
		expect(clientMeasurement(form({ clientOriginalBytes: blob, clientResized: blob }))).toEqual({
			clientOriginalBytes: null,
			clientResized: null
		});
	});
});

describe('logUpload', () => {
	afterEach(() => vi.restoreAllMocks());

	it('writes one JSON line with the received size next to the client fields', () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		logUpload({
			receivedBytes: 512000,
			clientOriginalBytes: 4000000,
			clientResized: true,
			outcome: 'stored',
			storedBytes: 240000,
			photoId: 'p1',
			processMs: 180,
			storePutMs: 95,
			modelMs: 2400,
			totalMs: 2750
		});
		expect(log).toHaveBeenCalledTimes(1);
		expect(JSON.parse(log.mock.calls[0][0] as string)).toEqual({
			event: 'photo_upload',
			receivedBytes: 512000,
			clientOriginalBytes: 4000000,
			clientResized: true,
			outcome: 'stored',
			storedBytes: 240000,
			photoId: 'p1',
			processMs: 180,
			storePutMs: 95,
			modelMs: 2400,
			totalMs: 2750
		});
	});
});
