import { describe, it, expect } from 'vitest';
import { defaultIncrement, suggestNextLoad, type ProgressionInput } from './progression';

function makeInput(overrides: Partial<ProgressionInput> = {}): ProgressionInput {
	return {
		tier: 'main',
		policy: 'standard',
		relevantSets: [{ position: 1, load: 100, reps: 5, rir: 1 }],
		targetRepsMax: 5,
		targetRir: 1,
		increment: 5,
		consecutiveBackwards: 0,
		...overrides
	};
}

describe('suggestNextLoad: policy gating', () => {
	it("holds load on 'hold' policy regardless of performance", () => {
		const r = suggestNextLoad(
			makeInput({
				policy: 'hold',
				relevantSets: [{ position: 1, load: 405, reps: 5, rir: 0 }]
			})
		);
		expect(r.load).toBe(405);
		expect(r.reasoning).toMatch(/hold/i);
	});

	it("holds load on 'cautious' policy even when performance would trigger a bump", () => {
		const r = suggestNextLoad(
			makeInput({
				policy: 'cautious',
				relevantSets: [{ position: 1, load: 100, reps: 5, rir: 0 }]
			})
		);
		expect(r.load).toBe(100);
		expect(r.reasoning).toMatch(/cautious/i);
	});

	it('cautious policy short-circuits the 10% deload path', () => {
		// 2 backwards on standard would deload to 90; cautious must NOT deload.
		const r = suggestNextLoad(
			makeInput({
				policy: 'cautious',
				consecutiveBackwards: 2
			})
		);
		expect(r.load).toBe(100);
		expect(r.reasoning).toMatch(/cautious/i);
	});
});

describe('suggestNextLoad: deload trigger', () => {
	it('deloads 10% after 2 consecutive backwards (standard policy)', () => {
		const r = suggestNextLoad(makeInput({ consecutiveBackwards: 2 }));
		expect(r.load).toBe(90);
		expect(r.reasoning).toMatch(/deload/i);
	});

	it('does not deload at 1 consecutive backwards', () => {
		const r = suggestNextLoad(makeInput({ consecutiveBackwards: 1 }));
		// 100 lb @ 5 reps @ RIR 1, target 5/1 → +5 (standard bump)
		expect(r.load).toBe(105);
	});

	it('rounds deload to 0.5 lb', () => {
		// 105 * 0.9 = 94.5 — exact
		const r = suggestNextLoad(
			makeInput({
				consecutiveBackwards: 2,
				relevantSets: [{ position: 1, load: 105, reps: 5, rir: 1 }]
			})
		);
		expect(r.load).toBe(94.5);
	});

	it('still deloads beyond 2 backwards (3+ counts as backwards too)', () => {
		const r = suggestNextLoad(makeInput({ consecutiveBackwards: 4 }));
		expect(r.load).toBe(90);
	});
});

describe('suggestNextLoad: MAIN tier', () => {
	it('+increment when top set hits target reps at target RIR', () => {
		const r = suggestNextLoad(makeInput()); // 5 reps @ RIR 1, target 5/1
		expect(r.load).toBe(105);
		expect(r.reasoning).toContain('+5');
	});

	it('+2*increment when top set is crushed (RIR ≥ 2 below target)', () => {
		const r = suggestNextLoad(
			makeInput({
				targetRir: 2,
				relevantSets: [{ position: 1, load: 100, reps: 5, rir: 0 }]
			})
		);
		expect(r.load).toBe(110);
		expect(r.reasoning).toContain('+10');
	});

	it('holds when top set missed target reps', () => {
		const r = suggestNextLoad(
			makeInput({
				relevantSets: [{ position: 1, load: 100, reps: 3, rir: 1 }]
			})
		);
		expect(r.load).toBe(100);
		expect(r.reasoning).toMatch(/held.*below target/i);
	});

	it('holds when top set hit reps but RIR is above target', () => {
		const r = suggestNextLoad(
			makeInput({
				relevantSets: [{ position: 1, load: 100, reps: 5, rir: 3 }]
			})
		);
		expect(r.load).toBe(100);
		expect(r.reasoning).toMatch(/held/i);
	});

	it('uses only the top set (first element) for MAIN tier', () => {
		// Extra entries should not influence the outcome.
		const r = suggestNextLoad(
			makeInput({
				relevantSets: [
					{ position: 1, load: 100, reps: 5, rir: 1 },
					{ position: 2, load: 90, reps: 3, rir: 4 } // would block all-sets logic
				]
			})
		);
		expect(r.load).toBe(105);
	});

	it('respects lower-body increment of 10', () => {
		const r = suggestNextLoad(makeInput({ increment: 10 }));
		expect(r.load).toBe(110);
	});
});

describe('suggestNextLoad: SECONDARY / ISOLATION tier', () => {
	it('+increment when ALL working sets clear top of range', () => {
		const r = suggestNextLoad(
			makeInput({
				tier: 'secondary',
				targetRepsMax: 10,
				targetRir: 2,
				relevantSets: [
					{ position: 1, load: 80, reps: 10, rir: 2 },
					{ position: 2, load: 80, reps: 11, rir: 1 }
				]
			})
		);
		expect(r.load).toBe(85);
	});

	it('holds when even one set falls short on reps', () => {
		const r = suggestNextLoad(
			makeInput({
				tier: 'isolation',
				targetRepsMax: 12,
				targetRir: 1,
				relevantSets: [
					{ position: 1, load: 40, reps: 12, rir: 1 },
					{ position: 2, load: 40, reps: 9, rir: 0 } // reps short
				]
			})
		);
		expect(r.load).toBe(40);
		expect(r.reasoning).toMatch(/held/i);
	});

	it('holds when one set has RIR above target', () => {
		const r = suggestNextLoad(
			makeInput({
				tier: 'secondary',
				targetRepsMax: 10,
				targetRir: 1,
				relevantSets: [
					{ position: 1, load: 80, reps: 10, rir: 1 },
					{ position: 2, load: 80, reps: 10, rir: 3 } // RIR too high
				]
			})
		);
		expect(r.load).toBe(80);
		expect(r.reasoning).toMatch(/held/i);
	});

	it('uses set[0].load as the baseline for the bump', () => {
		const r = suggestNextLoad(
			makeInput({
				tier: 'isolation',
				targetRepsMax: 12,
				targetRir: 1,
				relevantSets: [
					{ position: 1, load: 40, reps: 12, rir: 0 },
					{ position: 2, load: 35, reps: 12, rir: 1 }
				]
			})
		);
		// Baseline is the first set's load (40), not min or max across sets.
		expect(r.load).toBe(45);
	});
});

describe('suggestNextLoad: edge cases', () => {
	it('throws when relevantSets is empty', () => {
		expect(() => suggestNextLoad(makeInput({ relevantSets: [] }))).toThrow(
			/relevantSets/
		);
	});
});

describe('defaultIncrement', () => {
	it('returns 10 lb for lower body', () => {
		expect(defaultIncrement(true)).toBe(10);
	});

	it('returns 5 lb for upper body', () => {
		expect(defaultIncrement(false)).toBe(5);
	});
});
