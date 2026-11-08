/**
 * Equivalence tests pinning the vocabulary refactor (864246a). Each old inline
 * predicate is written here literally, next to the vocabulary call that
 * replaced it, and both are run over every null combination. Where the two
 * differ the divergence is asserted explicitly and explained. Plan:
 * docs/plans/2026-11-08-workout-state-vocabulary.md §3.8 item 2 (keep these:
 * they are the spec) and §6 items 1-4.
 *
 * Pure: no DB, no network. This is a *.test.ts, so the seam test allowlists
 * the raw spellings below.
 */
import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {
	isCompleted,
	isTouched,
	sessionPhase,
	workoutCapabilities,
	type SessionLike,
	type SetLike
} from './workout-state';
import { historyFilter, sessionIs, setIs } from './server/workout-state-sql';

const D = new Date('2026-11-08T12:00:00Z');

type SessionRow = SessionLike & { gymId: string | null };
type SessionLabel = 'open' | 'ended' | 'open+trashed' | 'ended+trashed';

const SESSIONS: Record<SessionLabel, SessionRow> = {
	open: { endedAt: null, deletedAt: null, gymId: null },
	ended: { endedAt: D, deletedAt: null, gymId: null },
	'open+trashed': { endedAt: null, deletedAt: D, gymId: null },
	'ended+trashed': { endedAt: D, deletedAt: D, gymId: null }
};

const SESSION_LABELS = Object.keys(SESSIONS) as SessionLabel[];

/** Labels of the rows where `oldFn` and `newFn` disagree. */
function sessionDivergence(
	oldFn: (s: SessionRow) => boolean,
	newFn: (s: SessionRow) => boolean
): SessionLabel[] {
	return SESSION_LABELS.filter((l) => oldFn(SESSIONS[l]) !== newFn(SESSIONS[l]));
}

describe('session phase vs. the old inline booleans', () => {
	describe('"live" on the workout page: old !s.endedAt vs canEditLive', () => {
		const oldLive = (s: SessionRow) => !s.endedAt;
		const newLive = (s: SessionRow) => workoutCapabilities(s, { editEnded: false }).canEditLive;

		it.each([
			['open', true, true],
			['ended', false, false],
			['open+trashed', true, false],
			['ended+trashed', false, false]
		] as const)('%s: old %s, new %s', (label, oldValue, newValue) => {
			const s = SESSIONS[label];

			expect(oldLive(s)).toBe(oldValue);
			expect(newLive(s)).toBe(newValue);
		});

		it('diverges only on the open+trashed row', () => {
			// The old check read only endedAt and would have called an open+trashed
			// row editable. The page loads with loadSession(..., 'not-trashed'), which
			// returns no trashed row, so the divergence is unreachable from the page.
			expect(sessionDivergence(oldLive, newLive)).toEqual(['open+trashed']);
		});
	});

	describe('"ended": old s.endedAt != null vs sessionPhase(s) === "ended"', () => {
		const oldEnded = (s: SessionRow) => s.endedAt != null;
		const newEnded = (s: SessionRow) => sessionPhase(s) === 'ended';

		it.each([
			['open', false, false],
			['ended', true, true],
			['open+trashed', false, false],
			['ended+trashed', true, false]
		] as const)('%s: old %s, new %s', (label, oldValue, newValue) => {
			const s = SESSIONS[label];

			expect(oldEnded(s)).toBe(oldValue);
			expect(newEnded(s)).toBe(newValue);
		});

		it('diverges only on the ended+trashed row', () => {
			// A trashed row is 'trashed' in the vocabulary even when it ended. Every
			// caller of the old check loaded with a not-trashed filter, so it never
			// saw this row.
			expect(sessionDivergence(oldEnded, newEnded)).toEqual(['ended+trashed']);
		});
	});

	describe('workout-sets lock: old !s || s.endedAt || s.deletedAt', () => {
		const oldLocked = (s: SessionRow | undefined) => Boolean(!s || s.endedAt || s.deletedAt);
		const newLocked = (s: SessionRow | undefined) => !s || sessionPhase(s) !== 'open';

		it.each([
			['missing', undefined, true],
			['open', SESSIONS.open, false],
			['ended', SESSIONS.ended, true],
			['open+trashed', SESSIONS['open+trashed'], true],
			['ended+trashed', SESSIONS['ended+trashed'], true]
		] as const)('%s: both give locked = %s', (_label, s, locked) => {
			expect(oldLocked(s)).toBe(locked);
			expect(newLocked(s)).toBe(locked);
		});
	});

	describe('photo-workout lockActive: old check order vs sessionPhase', () => {
		type LockLabel = 'not found' | 'ended' | 'ok';

		const oldLock = (s: SessionRow | undefined): LockLabel => {
			if (!s || s.deletedAt) return 'not found';
			if (s.endedAt) return 'ended';
			return 'ok';
		};
		const newLock = (s: SessionRow | undefined): LockLabel => {
			if (!s) return 'not found';
			const phase = sessionPhase(s);
			if (phase === 'trashed') return 'not found';
			if (phase === 'ended') return 'ended';
			return 'ok';
		};

		it.each([
			['missing', undefined, 'not found'],
			['open', SESSIONS.open, 'ok'],
			['ended', SESSIONS.ended, 'ended'],
			['open+trashed', SESSIONS['open+trashed'], 'not found'],
			['ended+trashed', SESSIONS['ended+trashed'], 'not found']
		] as const)('%s: both give %s', (_label, s, expected) => {
			expect(oldLock(s)).toBe(expected);
			expect(newLock(s)).toBe(expected);
		});
	});
});

/** Every null/non-null combination of the four set fields, plus edge rows. */
function setFixture(): { label: string; set: SetLike }[] {
	const rows: { label: string; set: SetLike }[] = [];
	for (let mask = 0; mask < 16; mask++) {
		const set: SetLike = {
			executedLoad: mask & 1 ? 100 : null,
			executedReps: mask & 2 ? 5 : null,
			executedRir: mask & 4 ? 2 : null,
			notes: mask & 8 ? 'felt heavy' : null
		};
		rows.push({ label: describeSet(set), set });
	}
	for (let mask = 0; mask < 8; mask++) {
		const set: SetLike = {
			executedLoad: mask & 1 ? 100 : null,
			executedReps: mask & 2 ? 5 : null,
			executedRir: mask & 4 ? 2 : null,
			notes: ''
		};
		rows.push({ label: describeSet(set), set });
	}
	return rows;
}

function describeSet(s: SetLike): string {
	const part = (name: string, v: unknown) => `${name}=${v === null ? 'null' : JSON.stringify(v)}`;
	return [
		part('load', s.executedLoad),
		part('reps', s.executedReps),
		part('rir', s.executedRir),
		part('notes', s.notes)
	].join(' ');
}

const SETS = setFixture();
const NOTES_ONLY: SetLike = {
	executedLoad: null,
	executedReps: null,
	executedRir: null,
	notes: 'felt heavy'
};

describe('set status vs. the old chains', () => {
	it('the fixture covers 16 null combinations plus 8 empty-note rows', () => {
		expect(SETS).toHaveLength(24);
		expect(new Set(SETS.map((r) => r.label)).size).toBe(24);
	});

	describe('old 4-field "touched" chain vs isTouched', () => {
		const oldTouched = (s: SetLike) =>
			Boolean(
				s.executedLoad != null || s.executedReps != null || s.executedRir != null || s.notes
			);

		it.each(SETS)('$label', ({ set }) => {
			expect(isTouched(set)).toBe(oldTouched(set));
		});
	});

	describe('old 2-field "completed" chain vs isCompleted', () => {
		const oldCompleted = (s: SetLike) => s.executedLoad != null && s.executedReps != null;

		it.each(SETS)('$label', ({ set }) => {
			expect(isCompleted(set)).toBe(oldCompleted(set));
		});
	});

	describe('workout-to-program 3-field "saved" (no notes) vs isTouched', () => {
		// Deliberately NOT migrated: plan §5 decision 1 keeps notes-only sets out of
		// a program built from a workout. This pins that the two differ, and where.
		const oldSaved = (s: SetLike) =>
			s.executedLoad != null || s.executedReps != null || s.executedRir != null;

		it('differs on exactly the notes-only row', () => {
			const differing = SETS.filter(({ set }) => oldSaved(set) !== isTouched(set));

			expect(differing.map((r) => r.set)).toEqual([NOTES_ONLY]);
			expect(oldSaved(NOTES_ONLY)).toBe(false);
			expect(isTouched(NOTES_ONLY)).toBe(true);
		});
	});

	describe('exports/formats.ts "completed" with reps > 0 vs isCompleted', () => {
		// Deliberately NOT migrated: plan §5 decision 3 keeps the reps > 0 rule
		// for the Strong CSV export, since a 0-rep set breaks third-party import.
		const oldExportable = (s: SetLike) =>
			s.executedLoad !== null && s.executedReps !== null && s.executedReps > 0;

		const withZeroReps: SetLike[] = SETS.filter(({ set }) => set.executedReps !== null).map(
			({ set }) => ({ ...set, executedReps: 0 })
		);
		const rows = [...SETS.map((r) => r.set), ...withZeroReps];

		it('differs exactly on completed rows with reps === 0', () => {
			const differing = rows.filter((s) => oldExportable(s) !== isCompleted(s));
			const expected = rows.filter((s) => s.executedLoad !== null && s.executedReps === 0);

			expect(expected).toHaveLength(6);
			expect(differing).toEqual(expected);
			for (const s of differing) {
				expect(oldExportable(s)).toBe(false);
				expect(isCompleted(s)).toBe(true);
			}
		});
	});
});

describe('SQL fragments render the literal predicates CLAUDE.md names', () => {
	const dialect = new PgDialect();
	const render = (fragment: SQL | undefined) => {
		if (!fragment) throw new Error('fragment rendered as undefined');
		const q = dialect.sqlToQuery(fragment);
		return { sql: q.sql.replace(/\s+/g, ' ').trim(), params: q.params };
	};

	it.each([
		['sessionIs.open', sessionIs.open, '("sessions"."ended_at" is null and "sessions"."deleted_at" is null)'],
		[
			'sessionIs.ended',
			sessionIs.ended,
			'("sessions"."ended_at" is not null and "sessions"."deleted_at" is null)'
		],
		['sessionIs.trashed', sessionIs.trashed, '"sessions"."deleted_at" is not null'],
		['sessionIs.notTrashed', sessionIs.notTrashed, '"sessions"."deleted_at" is null'],
		[
			'setIs.completed',
			setIs.completed,
			'("sets"."executed_load" is not null and "sets"."executed_reps" is not null)'
		],
		[
			'historyFilter',
			historyFilter,
			'(("sessions"."ended_at" is not null and "sessions"."deleted_at" is null) and ' +
				'("sets"."executed_load" is not null and "sets"."executed_reps" is not null))'
		]
	] as const)('%s renders the pinned predicate', (_name, build, expected) => {
		expect(render(build())).toEqual({ sql: expected, params: [] });
	});

	it('historyFilter excludes trashed sessions (deleted_at is null is present)', () => {
		expect(render(historyFilter()).sql).toContain('"sessions"."deleted_at" is null');
	});
});
