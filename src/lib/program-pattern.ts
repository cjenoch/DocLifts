import type { ProgramDraft } from './program-draft';

/**
 * The phone editor's set pattern (editor spec, Part N). Most exercises are a
 * number of equal working sets, so the exercise screen edits four fields —
 * sets, rep range, reps in reserve, rest — and rewrites every set from them.
 * Anything else (warm-ups, a MAIN top set with backoffs, timed sets, starting
 * loads, set notes, other rest values) is edited set by set under "Customize
 * sets". The saved shape never changes: a pattern is only a way of writing
 * the same `sets` array.
 */
type Exercise = ProgramDraft['days'][number]['exercises'][number];
type Set = Exercise['sets'][number];

export type Rest = 'short' | 'long';
export const REST: Record<Rest, [number, number]> = { short: [90, 120], long: [120, 180] };

export type Pattern = {
	sets: number;
	repsMin: number;
	repsMax: number;
	rir: number;
	rest: Rest;
};

export const DEFAULT_PATTERN: Pattern = { sets: 3, repsMin: 8, repsMax: 12, rir: 2, rest: 'short' };
export const PATTERN_LIMITS = { sets: [1, 30], reps: [1, 3600], rir: [0, 10] } as const;

function restOf(set: Set): Rest | null {
	for (const [key, [min, max]] of Object.entries(REST) as [Rest, [number, number]][])
		if (set.restSecondsMin === min && set.restSecondsMax === max) return key;
	return null;
}

/** The pattern an exercise's sets follow, or null when they need per-set editing. */
export function patternOf(exercise: Exercise): Pattern | null {
	if (exercise.tier === 'main' || exercise.sets.length === 0) return null;
	const [first] = exercise.sets;
	const rest = restOf(first);
	if (rest === null || first.targetRir === null) return null;
	const equal = exercise.sets.every(
		(set) =>
			set.setRole === 'working' &&
			set.targetMetric === 'reps' &&
			set.targetRepsMin === first.targetRepsMin &&
			set.targetRepsMax === first.targetRepsMax &&
			set.targetRir === first.targetRir &&
			restOf(set) === rest &&
			set.initialLoad === null &&
			set.notes === null
	);
	return equal
		? {
				sets: exercise.sets.length,
				repsMin: first.targetRepsMin,
				repsMax: first.targetRepsMax,
				rir: first.targetRir,
				rest
			}
		: null;
}

/** Every set written from the pattern: equal working sets. */
export function setsFromPattern(pattern: Pattern): Set[] {
	const [restMin, restMax] = REST[pattern.rest];
	return Array.from({ length: pattern.sets }, () => ({
		setRole: 'working' as const,
		targetMetric: 'reps' as const,
		targetRepsMin: pattern.repsMin,
		targetRepsMax: pattern.repsMax,
		targetRir: pattern.rir,
		restSecondsMin: restMin,
		restSecondsMax: restMax,
		initialLoad: null,
		notes: null
	}));
}

/**
 * The roles a tier needs (the draft validator's rule): MAIN is one top set
 * then backoffs, the others working sets; leading warm-ups stay warm-ups.
 */
export function reroleForTier(exercise: Exercise): void {
	let firstWork = true;
	for (const set of exercise.sets) {
		if (set.setRole === 'warmup') continue;
		set.setRole = exercise.tier === 'main' ? (firstWork ? 'top' : 'backoff') : 'working';
		firstWork = false;
	}
}

const range = (min: number, max: number) => (min === max ? `${min}` : `${min}–${max}`);

/** The day screen's one line: "Leg press · 3 × 8–12 · RIR 2". */
export function summaryLine(name: string, exercise: Exercise): string {
	const pattern = patternOf(exercise);
	if (pattern)
		return `${name} · ${pattern.sets} × ${range(pattern.repsMin, pattern.repsMax)} · RIR ${pattern.rir}`;
	const work = exercise.sets.filter((set) => set.setRole !== 'warmup');
	const warm = exercise.sets.length - work.length;
	const first = work[0] ?? exercise.sets[0];
	const parts = [name];
	if (first) {
		const unit = first.targetMetric === 'seconds' ? ' s' : '';
		parts.push(
			`${work.length || exercise.sets.length} × ${range(first.targetRepsMin, first.targetRepsMax)}${unit}`
		);
		if (exercise.tier === 'main') parts.push('top + backoffs');
		if (warm) parts.push(`${warm} warm-up${warm === 1 ? '' : 's'}`);
	} else parts.push('no sets');
	return parts.join(' · ');
}

/** Validation issues, located for the three screens. */
export type Issue = { path: PropertyKey[]; message: string };
export type Located = {
	program: string[];
	day: Map<number, string[]>;
	exercise: Map<string, string[]>;
};
export const exerciseKey = (day: number, exercise: number) => `${day}:${exercise}`;

export function locate(issues: Issue[]): Located {
	const out: Located = { program: [], day: new Map(), exercise: new Map() };
	const push = <K>(map: Map<K, string[]>, key: K, message: string) =>
		map.set(key, [...(map.get(key) ?? []), message]);
	for (const issue of issues) {
		const [top, d, sub, e, , s, field] = issue.path;
		if (top !== 'days' || typeof d !== 'number') {
			out.program.push(issue.message);
			continue;
		}
		if (sub !== 'exercises' || typeof e !== 'number') {
			push(out.day, d, issue.message);
			continue;
		}
		const where =
			typeof s === 'number'
				? `Set ${s + 1}${typeof field === 'string' ? ` (${field})` : ''}: `
				: '';
		push(out.exercise, exerciseKey(d, e), where + issue.message);
	}
	return out;
}

/** How many problems sit at or below a day, for the program screen's count. */
export function dayCount(located: Located, day: number): number {
	let n = located.day.get(day)?.length ?? 0;
	for (const [key, list] of located.exercise) if (key.startsWith(`${day}:`)) n += list.length;
	return n;
}
