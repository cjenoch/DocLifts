/**
 * The legacy photo-placeholder cleanup (`pnpm photo:placeholders`) recognises
 * a placeholder by its label, so the pattern must match exactly what
 * `openPhotoBlock` writes: `workoutUi.photoMachineLabel(photoTimeLabel(...))`.
 * These tests feed the pattern the functions' own output, so a change to the
 * label's wording or the time format fails here before the cleanup misses (or
 * over-reaches) in production. No database.
 */
import { describe, expect, it } from 'vitest';
import { photoMachineLabelPattern, photoTimeLabel } from './photo-workout';
import {
	PHOTO_LABEL_WINDOW_MINUTES,
	photoTimeMatchesLabel,
	placeholderFingerprint
} from './machine-admin';
import { workoutUi } from '../workout-ui';

const label = (fromClient: unknown, now?: Date) =>
	workoutUi.photoMachineLabel(photoTimeLabel(fromClient, now));

describe('photoMachineLabelPattern', () => {
	it("matches every label openPhotoBlock writes: the phone's time and the server's UTC fallback", () => {
		const phone = ['2:32 PM', '12:05 am', '9:00AM', '14:32', '0:07', ' 7:45 PM '];
		for (const time of phone) expect(label(time)).toMatch(photoMachineLabelPattern);
		const instants = [
			'2026-10-02T00:00:00Z',
			'2026-10-02T09:05:00Z',
			'2026-10-02T12:59:00Z',
			'2026-10-02T14:32:00Z',
			'2026-10-02T23:41:00Z'
		];
		for (const at of instants) {
			// No client time, or one the server refuses: the UTC fallback.
			expect(label(undefined, new Date(at))).toMatch(photoMachineLabelPattern);
			expect(label('teatime', new Date(at))).toMatch(photoMachineLabelPattern);
		}
	});

	it('also matches the U+202F form some ICU builds give the server fallback', () => {
		expect(workoutUi.photoMachineLabel(`2:32${String.fromCharCode(0x202f)}PM`)).toMatch(
			photoMachineLabelPattern
		);
	});

	it('captures the minute of the label', () => {
		expect(photoMachineLabelPattern.exec(label('2:32 PM'))?.[1]).toBe('32');
		expect(
			photoMachineLabelPattern.exec(label(undefined, new Date('2026-10-02T09:05:00Z')))?.[1]
		).toBe('05');
	});

	it('matches nothing else: user names that merely start like a placeholder', () => {
		for (const name of [
			'Photo Finish',
			'Photo',
			'Photo ',
			'photo 2:32 PM',
			'Photo 2:32 PM (left)',
			'Photo 2:32 PM 2',
			'My Photo 2:32 PM',
			'Photo 232 PM',
			'Photo 2:3 PM',
			'Photo 123:45'
		])
			expect(name).not.toMatch(photoMachineLabelPattern);
	});
});

describe('photoTimeMatchesLabel (the strong-evidence window)', () => {
	it('accepts a photo created 0..window minutes after the label minute, at any hour', () => {
		const l = label('2:58 PM');
		expect(photoTimeMatchesLabel(l, new Date('2026-10-02T19:58:10Z'))).toBe(true);
		expect(photoTimeMatchesLabel(l, new Date('2026-10-02T03:59:59Z'))).toBe(true);
		// Across the hour: 2:58 + 2 min = :00.
		expect(PHOTO_LABEL_WINDOW_MINUTES).toBe(2);
		expect(photoTimeMatchesLabel(l, new Date('2026-10-02T20:00:30Z'))).toBe(true);
	});

	it('refuses a photo before the label minute, past the window, or a label of another shape', () => {
		const l = label('2:58 PM');
		expect(photoTimeMatchesLabel(l, new Date('2026-10-02T19:57:59Z'))).toBe(false);
		expect(photoTimeMatchesLabel(l, new Date('2026-10-02T20:01:00Z'))).toBe(false);
		expect(photoTimeMatchesLabel('Photo Finish', new Date('2026-10-02T19:58:00Z'))).toBe(false);
	});
});

describe('placeholderFingerprint', () => {
	it('is order-insensitive and changes when the set changes', () => {
		const a = placeholderFingerprint(['b', 'a', 'c']);
		expect(a).toBe(placeholderFingerprint(['c', 'b', 'a']));
		expect(a).toMatch(/^[0-9a-f]{64}$/);
		expect(placeholderFingerprint(['a', 'b'])).not.toBe(a);
		expect(placeholderFingerprint([])).not.toBe(a);
	});
});
