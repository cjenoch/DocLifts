import { describe, expect, it } from 'vitest';
import { blankSetDraft, programDraftSchema, type ProgramDraft } from './program-draft';
import {
	DEFAULT_PATTERN,
	dayCount,
	exerciseKey,
	locate,
	patternOf,
	reroleForTier,
	setsFromPattern,
	summaryLine
} from './program-pattern';
import { barbellStrengthDraft, machineFullBodyDraft } from './starter-templates';

type Exercise = ProgramDraft['days'][number]['exercises'][number];
const exercise = (sets: Exercise['sets'], tier: Exercise['tier'] = 'secondary'): Exercise => ({
	exerciseId: '11111111-1111-4111-8111-111111111111',
	newExercise: null,
	tier,
	progressionPolicy: 'standard',
	notes: null,
	sets
});

describe('set pattern', () => {
	it('round-trips: equal working sets are a pattern, and the pattern writes them back', () => {
		const pattern = { sets: 4, repsMin: 6, repsMax: 10, rir: 1, rest: 'long' as const };
		const sets = setsFromPattern(pattern);
		expect(sets).toHaveLength(4);
		expect(sets[0]).toEqual({
			setRole: 'working',
			targetMetric: 'reps',
			targetRepsMin: 6,
			targetRepsMax: 10,
			targetRir: 1,
			restSecondsMin: 120,
			restSecondsMax: 180,
			initialLoad: null,
			notes: null
		});
		expect(patternOf(exercise(sets))).toEqual(pattern);
		// The editor's blank set is the default pattern's set.
		expect(setsFromPattern(DEFAULT_PATTERN)[0]).toEqual(blankSetDraft());
	});

	it.each([
		['a warm-up', (s: Exercise['sets']) => (s[0].setRole = 'warmup')],
		['a timed set', (s: Exercise['sets']) => (s[1].targetMetric = 'seconds')],
		['a different target', (s: Exercise['sets']) => (s[2].targetRepsMax = 15)],
		['a starting load', (s: Exercise['sets']) => (s[0].initialLoad = 50)],
		['a set note', (s: Exercise['sets']) => (s[0].notes = 'pause')],
		['other rest', (s: Exercise['sets']) => (s[0].restSecondsMin = 60)],
		['no RIR', (s: Exercise['sets']) => s.forEach((x) => (x.targetRir = null))]
	])('sets with %s need per-set editing', (_, change) => {
		const sets = setsFromPattern(DEFAULT_PATTERN);
		change(sets);
		expect(patternOf(exercise(sets))).toBeNull();
	});

	it('a MAIN lift (top set + backoffs) is always edited set by set', () => {
		const ex = exercise(setsFromPattern(DEFAULT_PATTERN), 'main');
		reroleForTier(ex);
		expect(ex.sets.map((s) => s.setRole)).toEqual(['top', 'backoff', 'backoff']);
		expect(patternOf(ex)).toBeNull();
		ex.tier = 'isolation';
		reroleForTier(ex);
		expect(ex.sets.map((s) => s.setRole)).toEqual(['working', 'working', 'working']);
		expect(patternOf(ex)).toEqual(DEFAULT_PATTERN);
	});

	it('re-roling keeps leading warm-ups and satisfies the validator', () => {
		const ex = exercise([
			{ ...blankSetDraft(), setRole: 'warmup' },
			...setsFromPattern(DEFAULT_PATTERN)
		]);
		ex.tier = 'main';
		reroleForTier(ex);
		expect(ex.sets.map((s) => s.setRole)).toEqual(['warmup', 'top', 'backoff', 'backoff']);
		const draft: ProgramDraft = {
			name: 'P',
			description: null,
			days: [{ name: 'D', notes: null, alternateGroupId: null, exercises: [ex] }]
		};
		expect(programDraftSchema.safeParse(draft).success).toBe(true);
	});

	it('the templates: machine exercises open as patterns, barbell main lifts and the plank do not', () => {
		const machine = machineFullBodyDraft().days.flatMap((d) => d.exercises);
		expect(machine.every((x) => patternOf(x) !== null)).toBe(true);
		const barbell = barbellStrengthDraft().days.flatMap((d) => d.exercises);
		const custom = barbell.filter((x) => patternOf(x) === null).map((x) => x.newExercise?.name);
		expect(custom).toEqual([
			'Overhead press',
			'Barbell bench press',
			'Back squat',
			'Plank',
			'Overhead press',
			'Barbell bench press',
			'Deadlift'
		]);
	});
});

describe('summary line', () => {
	it('reads like the spec: "Leg press · 3 × 8–12 · RIR 2"', () => {
		expect(summaryLine('Leg press', exercise(setsFromPattern(DEFAULT_PATTERN)))).toBe(
			'Leg press · 3 × 8–12 · RIR 2'
		);
		const five = exercise(setsFromPattern({ ...DEFAULT_PATTERN, repsMin: 5, repsMax: 5 }), 'main');
		reroleForTier(five);
		expect(summaryLine('Squat', five)).toBe('Squat · 3 × 5 · top + backoffs');
		const plank = barbellStrengthDraft().days[1].exercises[3];
		expect(summaryLine('Plank', plank)).toBe('Plank · 2 × 30–60 s');
		const warm = exercise([
			{ ...blankSetDraft(), setRole: 'warmup' },
			...setsFromPattern(DEFAULT_PATTERN)
		]);
		expect(summaryLine('Press', warm)).toBe('Press · 3 × 8–12 · 1 warm-up');
		expect(summaryLine('Empty', exercise([]))).toBe('Empty · no sets');
	});
});

describe('locating validation problems', () => {
	it('puts each issue on its screen and counts them for the level above', () => {
		const located = locate([
			{ path: ['name'], message: 'Too small' },
			{ path: ['days', 1, 'name'], message: 'Too small' },
			{ path: ['days', 1, 'exercises'], message: 'Too small' },
			{ path: ['days', 1, 'exercises', 0, 'sets', 2, 'targetRepsMax'], message: 'Max below min' },
			{ path: ['days', 1, 'exercises', 0, 'exerciseId'], message: 'Choose one' },
			{ path: ['days', 0, 'exercises', 3, 'sets'], message: 'Roles' }
		]);
		expect(located.program).toEqual(['Too small']);
		expect(located.day.get(1)).toEqual(['Too small', 'Too small']);
		expect(located.exercise.get(exerciseKey(1, 0))).toEqual([
			'Set 3 (targetRepsMax): Max below min',
			'Choose one'
		]);
		expect(dayCount(located, 1)).toBe(4);
		expect(dayCount(located, 0)).toBe(1);
	});
});
