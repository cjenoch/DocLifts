import { describe, expect, it } from 'vitest';
import { dayKeyIn, displayZone, lastLocalDays } from './local-day';
import { workoutProgramName } from './server/workout-to-program';

// Phone: the program page's strip and a saved workout's name are read in the
// evening at the gym; both must use the user's local day (2026-11-09).
describe('local days', () => {
	const evening = new Date('2026-11-09T00:30:00Z'); // 19:30 Nov 8 in Detroit

	it('dayKeyIn gives the local date, and UTC when no zone is stored', () => {
		expect(dayKeyIn(evening, displayZone(null))).toBe('2026-11-09');
		expect(dayKeyIn(evening, 'America/Detroit')).toBe('2026-11-08');
	});

	it('lastLocalDays ends on the local today and steps one date at a time across DST', () => {
		const days = lastLocalDays(14, 'America/Detroit', evening);
		expect(days).toHaveLength(14);
		expect(days[13]).toEqual({ dateKey: '2026-11-08', label: '11/8' });
		// Nov 1 2026 is the fall-back day in Detroit: no date repeated or skipped.
		expect(days.map((d) => d.dateKey)).toEqual([
			'2026-10-26',
			'2026-10-27',
			'2026-10-28',
			'2026-10-29',
			'2026-10-30',
			'2026-10-31',
			'2026-11-01',
			'2026-11-02',
			'2026-11-03',
			'2026-11-04',
			'2026-11-05',
			'2026-11-06',
			'2026-11-07',
			'2026-11-08'
		]);
		expect(lastLocalDays(1, 'UTC', evening)[0].dateKey).toBe('2026-11-09');
	});

	it("a saved workout's program name carries the local date", () => {
		expect(workoutProgramName(evening)).toBe('Workout · Nov 9, 2026');
		expect(workoutProgramName(evening, 'America/Detroit')).toBe('Workout · Nov 8, 2026');
	});
});
