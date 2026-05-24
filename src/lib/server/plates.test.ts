import { describe, it, expect } from 'vitest';
import {
	snapForEquipment,
	snapPerSidePlates,
	snapToAchievable,
	v5DeadliftIncrements
} from './plates';
import { gymConfig } from './gym-config';

describe('snapToAchievable (barbell)', () => {
	it('round-trips every v5 deadlift increment exactly', () => {
		for (const target of v5DeadliftIncrements) {
			const result = snapToAchievable(target);
			expect(result.achievable).toBe(target);
		}
	});

	it('returns bar weight with no plates when target is below the bar', () => {
		expect(snapToAchievable(20)).toEqual({ achievable: 44, platesUsed: [] });
		expect(snapToAchievable(40)).toEqual({ achievable: 44, platesUsed: [] });
	});

	it('returns bar weight when target equals the bar', () => {
		expect(snapToAchievable(44)).toEqual({ achievable: 44, platesUsed: [] });
	});

	it('snaps DOWN (never up) when no exact plate combo matches', () => {
		// 50 lb total → 3 lb per side. Smallest plate is 2.5, so per-side rounds
		// to 2.5 → achievable 49. Must NOT round up to 54 (44 + 5+5).
		const r = snapToAchievable(50);
		expect(r.achievable).toBe(49);
		expect(r.platesUsed).toEqual([2.5]);
	});

	it('decomposes 304 lb correctly (45+45+35+5 per side)', () => {
		// Documented in plates.ts: 304 = 44 + 2×(45+45+35+5)
		const r = snapToAchievable(304);
		expect(r.achievable).toBe(304);
		expect(r.platesUsed).toEqual([45, 45, 35, 5]);
	});

	it('returns plates biggest-first', () => {
		const r = snapToAchievable(244); // 44 + 2×(45+45+10)
		expect(r.platesUsed).toEqual([45, 45, 10]);
		// Verify sorted desc
		const sorted = [...r.platesUsed].sort((a, b) => b - a);
		expect(r.platesUsed).toEqual(sorted);
	});

	it('honors a custom bar weight', () => {
		const r = snapToAchievable(75, gymConfig.bars.ezBar); // 25 + 2×25
		expect(r.achievable).toBe(75);
		expect(r.platesUsed).toEqual([25]);
	});
});

describe('snapPerSidePlates (machine-plate)', () => {
	it('snaps a single 45 lb plate per side exactly', () => {
		expect(snapPerSidePlates(45)).toEqual({ achievable: 45, platesUsed: [45] });
	});

	it('handles multi-plate stacks (45+45+10 = 100)', () => {
		expect(snapPerSidePlates(100)).toEqual({
			achievable: 100,
			platesUsed: [45, 45, 10]
		});
	});

	it('returns 0 with no plates when target is below the smallest plate', () => {
		expect(snapPerSidePlates(1)).toEqual({ achievable: 0, platesUsed: [] });
	});

	it('returns 0 with no plates for a zero target', () => {
		expect(snapPerSidePlates(0)).toEqual({ achievable: 0, platesUsed: [] });
	});

	it('does NOT add the bar (per-side mode has no bar)', () => {
		const r = snapPerSidePlates(50);
		expect(r.achievable).toBe(50); // 45 + 5, no +44 bar
		expect(r.platesUsed).toEqual([45, 5]);
	});
});

describe('snapForEquipment router', () => {
	it("'barbell' uses the standard 44 lb bar", () => {
		const r = snapForEquipment(184, 'barbell'); // 44 + 2×(45+25)
		expect(r.achievable).toBe(184);
	});

	it("'barbell-ez' uses the 25 lb EZ bar", () => {
		const r = snapForEquipment(75, 'barbell-ez'); // 25 + 2×25
		expect(r.achievable).toBe(75);
		expect(r.platesUsed).toEqual([25]);
	});

	it("'machine-plate' snaps per side with no bar", () => {
		const r = snapForEquipment(50, 'machine-plate');
		expect(r.achievable).toBe(50);
		expect(r.platesUsed).toEqual([45, 5]);
	});

	it.each(['machine-stack', 'cable', 'dumbbell', 'smith', 'bodyweight', 'band'] as const)(
		"passes %s through unchanged (load IS the displayed value)",
		(equipment) => {
			const r = snapForEquipment(73.5, equipment);
			expect(r).toEqual({ achievable: 73.5, platesUsed: [] });
		}
	);

	it('passes through when equipment is null', () => {
		expect(snapForEquipment(73.5, null)).toEqual({ achievable: 73.5, platesUsed: [] });
	});

	it('passes through when equipment is undefined', () => {
		expect(snapForEquipment(73.5, undefined)).toEqual({
			achievable: 73.5,
			platesUsed: []
		});
	});

	it('passes through unknown equipment strings (future equipment types)', () => {
		expect(snapForEquipment(73.5, 'kettlebell')).toEqual({
			achievable: 73.5,
			platesUsed: []
		});
	});

	it('preserves fractional loads through pass-through (no silent rounding)', () => {
		// machine-stack values can be non-integer per gym; pipeline must not mangle.
		expect(snapForEquipment(67.5, 'machine-stack').achievable).toBe(67.5);
	});
});
