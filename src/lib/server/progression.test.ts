import { describe, it, expect } from 'vitest';
import {
	defaultIncrement,
	suggestNextLoad,
	type ProgressionInput,
	resolveTargets
} from './progression';

function makeInput(overrides: Partial<ProgressionInput> = {}): ProgressionInput {
	return {
		tier: 'main',
		policy: 'standard',
		relevantSets: [{ position: 1, load: 100, reps: 5, rir: 1, targetRepsMax: 5, targetRir: 1 }],
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
				relevantSets: [{ position: 1, load: 405, reps: 5, rir: 0, targetRepsMax: 5, targetRir: 1 }]
			})
		);
		expect(r.load).toBe(405);
		expect(r.reasoning).toMatch(/hold/i);
	});

	it("holds load on 'cautious' policy even when performance would trigger a bump", () => {
		const r = suggestNextLoad(
			makeInput({
				policy: 'cautious',
				relevantSets: [{ position: 1, load: 100, reps: 5, rir: 0, targetRepsMax: 5, targetRir: 1 }]
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
		expect(r.kind).toBe('deload');
		expect(r.load).toBe(90);
		expect(r.reasoning).toMatch(/deload/i);
	});

	it('deload decision kind and reasoning stay in sync', () => {
		const r = suggestNextLoad(
			makeInput({
				consecutiveBackwards: 2,
				relevantSets: [{ position: 1, load: 105, reps: 4, rir: 3, targetRepsMax: 5, targetRir: 1 }]
			})
		);
		expect(r.kind).toBe('deload');
		expect(r.reasoning).toBe('10% deload after 2 consecutive backwards sessions');
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
				relevantSets: [{ position: 1, load: 105, reps: 5, rir: 1, targetRepsMax: 5, targetRir: 1 }]
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
				relevantSets: [{ position: 1, load: 100, reps: 5, rir: 0, targetRepsMax: 5, targetRir: 2 }]
			})
		);
		expect(r.load).toBe(110);
		expect(r.reasoning).toContain('+10');
	});

	it('holds when top set missed target reps', () => {
		const r = suggestNextLoad(
			makeInput({
				relevantSets: [{ position: 1, load: 100, reps: 3, rir: 1, targetRepsMax: 5, targetRir: 1 }]
			})
		);
		expect(r.load).toBe(100);
		expect(r.reasoning).toMatch(/held.*below target/i);
	});

	it('holds when top set hit reps but RIR is above target', () => {
		const r = suggestNextLoad(
			makeInput({
				relevantSets: [{ position: 1, load: 100, reps: 5, rir: 3, targetRepsMax: 5, targetRir: 1 }]
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
					{ position: 1, load: 100, reps: 5, rir: 1, targetRepsMax: 5, targetRir: 1 },
					{ position: 2, load: 90, reps: 3, rir: 4, targetRepsMax: 5, targetRir: 1 } // would block all-sets logic
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
				relevantSets: [
					{ position: 1, load: 80, reps: 10, rir: 2, targetRepsMax: 10, targetRir: 2 },
					{ position: 2, load: 80, reps: 11, rir: 1, targetRepsMax: 10, targetRir: 2 }
				]
			})
		);
		expect(r.load).toBe(85);
	});

	it('holds when even one set falls short on reps', () => {
		const r = suggestNextLoad(
			makeInput({
				tier: 'isolation',
				relevantSets: [
					{ position: 1, load: 40, reps: 12, rir: 1, targetRepsMax: 12, targetRir: 1 },
					{ position: 2, load: 40, reps: 9, rir: 0, targetRepsMax: 12, targetRir: 1 } // reps short
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
				relevantSets: [
					{ position: 1, load: 80, reps: 10, rir: 1, targetRepsMax: 10, targetRir: 1 },
					{ position: 2, load: 80, reps: 10, rir: 3, targetRepsMax: 10, targetRir: 1 } // RIR too high
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
				relevantSets: [
					{ position: 1, load: 40, reps: 12, rir: 0, targetRepsMax: 12, targetRir: 1 },
					{ position: 2, load: 35, reps: 12, rir: 1, targetRepsMax: 12, targetRir: 1 }
				]
			})
		);
		// Baseline is the first set's load (40), not min or max across sets.
		expect(r.load).toBe(45);
	});
});

describe('suggestNextLoad: per-position targets (M2)', () => {
	it("holds when a position clears position 1's range but not its own", () => {
		// Position 2 hits 10 reps — clears position 1's target of 8, but its
		// own target is 12. Pre-fix the engine judged it against 8 and advanced.
		const r = suggestNextLoad(
			makeInput({
				tier: 'secondary',
				relevantSets: [
					{ position: 1, load: 135, reps: 8, rir: 1, targetRepsMax: 8, targetRir: 1 },
					{ position: 2, load: 135, reps: 10, rir: 1, targetRepsMax: 12, targetRir: 1 }
				]
			})
		);
		expect(r.kind).toBe('hold');
		expect(r.load).toBe(135);
	});

	it('advances when every position clears its own range', () => {
		const r = suggestNextLoad(
			makeInput({
				tier: 'secondary',
				relevantSets: [
					{ position: 1, load: 135, reps: 8, rir: 1, targetRepsMax: 8, targetRir: 1 },
					{ position: 2, load: 135, reps: 12, rir: 1, targetRepsMax: 12, targetRir: 1 }
				]
			})
		);
		expect(r.kind).toBe('advance');
		expect(r.load).toBe(140);
	});

	it('judges a narrow position against its own target, not a wider position 1', () => {
		// Position 2 manages 6 reps against its own target of 8 — a hold either
		// way, but for the right reason (6 < 8, not 6 < 12).
		const r = suggestNextLoad(
			makeInput({
				tier: 'secondary',
				relevantSets: [
					{ position: 1, load: 135, reps: 12, rir: 1, targetRepsMax: 12, targetRir: 1 },
					{ position: 2, load: 135, reps: 6, rir: 1, targetRepsMax: 8, targetRir: 1 }
				]
			})
		);
		expect(r.kind).toBe('hold');
		expect(r.load).toBe(135);
	});

	it('holds when a position clears reps but misses its own RIR target', () => {
		const r = suggestNextLoad(
			makeInput({
				tier: 'secondary',
				relevantSets: [
					{ position: 1, load: 135, reps: 8, rir: 1, targetRepsMax: 8, targetRir: 1 },
					{ position: 2, load: 135, reps: 12, rir: 3, targetRepsMax: 12, targetRir: 1 }
				]
			})
		);
		expect(r.kind).toBe('hold');
		expect(r.load).toBe(135);
	});
});

describe('resolveTargets', () => {
	it('prefers the slot target over the snapshotted history target', () => {
		expect(
			resolveTargets(
				{ targetRepsMax: 12, targetRepsMin: 8, targetRir: 2 },
				{ prescribedRepsMax: 10, prescribedRir: 1 }
			)
		).toEqual({ targetRepsMax: 12, targetRir: 2 });
	});

	it('falls back to the history snapshot when the slot target is null', () => {
		expect(
			resolveTargets(
				{ targetRepsMax: null, targetRepsMin: 8, targetRir: null },
				{ prescribedRepsMax: 10, prescribedRir: 1 }
			)
		).toEqual({ targetRepsMax: 10, targetRir: 1 });
	});

	it('falls back to the rep-range floor, then 0, when slot and history are both null', () => {
		expect(
			resolveTargets({ targetRepsMax: null, targetRepsMin: 8, targetRir: null }, null)
		).toEqual({ targetRepsMax: 8, targetRir: 0 });
		expect(
			resolveTargets({ targetRepsMax: null, targetRepsMin: null, targetRir: null }, undefined)
		).toEqual({ targetRepsMax: 0, targetRir: 0 });
	});
});

describe('suggestNextLoad: edge cases', () => {
	it('throws when relevantSets is empty', () => {
		expect(() => suggestNextLoad(makeInput({ relevantSets: [] }))).toThrow(/relevantSets/);
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
