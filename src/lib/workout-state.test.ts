import { describe, expect, it } from 'vitest';
import {
	isCompleted,
	isTouched,
	sessionPhase,
	setStatus,
	workoutCapabilities,
	type SessionPhase,
	type SetLike,
	type SetStatus,
	type WorkoutCapabilities
} from './workout-state';

const T = new Date('2026-11-08T10:00:00Z');

describe('sessionPhase', () => {
	it.each<[Date | null, Date | null, SessionPhase]>([
		[null, null, 'open'],
		[T, null, 'ended'],
		[null, T, 'trashed'],
		[T, T, 'trashed']
	])('endedAt=%s deletedAt=%s -> %s', (endedAt, deletedAt, phase) => {
		expect(sessionPhase({ endedAt, deletedAt })).toBe(phase);
	});
});

describe('setStatus', () => {
	// All 16 null / non-null combinations of (load, reps, rir, notes).
	const rows: [SetLike, SetStatus][] = [];
	for (let mask = 0; mask < 16; mask++) {
		const s: SetLike = {
			executedLoad: mask & 1 ? 100 : null,
			executedReps: mask & 2 ? 8 : null,
			executedRir: mask & 4 ? 2 : null,
			notes: mask & 8 ? 'felt heavy' : null
		};
		const expected: SetStatus =
			mask === 0 ? 'untouched' : (mask & 3) === 3 ? 'completed' : 'partial';
		rows.push([s, expected]);
	}

	it.each(rows)('%o -> %s', (s, expected) => {
		expect(setStatus(s)).toBe(expected);
		expect(isTouched(s)).toBe(expected !== 'untouched');
		expect(isCompleted(s)).toBe(expected === 'completed');
	});

	it.each<[string, SetStatus]>([
		['', 'untouched'],
		['x', 'partial']
	])('notes %j with no values -> %s', (notes, expected) => {
		const s: SetLike = { executedLoad: null, executedReps: null, executedRir: null, notes };
		expect(setStatus(s)).toBe(expected);
	});

	it('treats a zero load and zero reps as saved values', () => {
		const s: SetLike = { executedLoad: 0, executedReps: 0, executedRir: null, notes: null };
		expect(setStatus(s)).toBe('completed');
	});
});

describe('workoutCapabilities', () => {
	const phases: [SessionPhase, Date | null, Date | null][] = [
		['open', null, null],
		['ended', T, null],
		['trashed', T, T]
	];
	const cases: [SessionPhase, Date | null, Date | null, boolean, string | null][] = [];
	for (const [phase, endedAt, deletedAt] of phases) {
		for (const editEnded of [false, true]) {
			for (const gymId of [null, 'gym-1'])
				cases.push([phase, endedAt, deletedAt, editEnded, gymId]);
		}
	}

	it.each(cases)(
		'%s (ended=%s deleted=%s) editEnded=%s gymId=%s',
		(phase, endedAt, deletedAt, editEnded, gymId) => {
			const open = phase === 'open';
			const ended = phase === 'ended';
			const expected: WorkoutCapabilities = {
				phase,
				canLogSets: open || (ended && editEnded),
				canEditLive: open,
				canFinish: open,
				canTrash: ended,
				canSaveAsProgram: ended,
				photoEnabled: open && gymId !== null,
				editEnded: ended && editEnded
			};
			expect(workoutCapabilities({ endedAt, deletedAt, gymId }, { editEnded })).toEqual(expected);
		}
	);

	it('pins the literal values for the three phases', () => {
		const caps = (endedAt: Date | null, deletedAt: Date | null) =>
			workoutCapabilities({ endedAt, deletedAt, gymId: 'g' }, { editEnded: true });
		expect(caps(null, null)).toEqual({
			phase: 'open',
			canLogSets: true,
			canEditLive: true,
			canFinish: true,
			canTrash: false,
			canSaveAsProgram: false,
			photoEnabled: true,
			editEnded: false
		});
		expect(caps(T, null)).toEqual({
			phase: 'ended',
			canLogSets: true,
			canEditLive: false,
			canFinish: false,
			canTrash: true,
			canSaveAsProgram: true,
			photoEnabled: false,
			editEnded: true
		});
		expect(caps(null, T)).toEqual({
			phase: 'trashed',
			canLogSets: false,
			canEditLive: false,
			canFinish: false,
			canTrash: false,
			canSaveAsProgram: false,
			photoEnabled: false,
			editEnded: false
		});
	});
});
