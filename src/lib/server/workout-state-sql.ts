/**
 * Server-side SQL spelling of the workout-state vocabulary in
 * `$lib/workout-state`. The only place the session-phase and set-completed
 * predicates are written as SQL. Each member is a function so every call
 * returns a fresh fragment that can sit inside any number of `and()`s.
 */
import { and, isNotNull, isNull } from 'drizzle-orm';
import { sessions, sets } from './db/schema';

/** Session-phase predicates; they match `sessionPhase()` exactly. */
export const sessionIs = {
	/** Neither ended nor trashed. */
	open: () => and(isNull(sessions.endedAt), isNull(sessions.deletedAt)),
	/** Ended and not trashed. */
	ended: () => and(isNotNull(sessions.endedAt), isNull(sessions.deletedAt)),
	/** Trashed, whether or not it ended. */
	trashed: () => isNotNull(sessions.deletedAt),
	/** Open or ended: anything not in the Trash. */
	notTrashed: () => isNull(sessions.deletedAt)
};

/** Set-status predicates; they match `setStatus()` for the states SQL needs. */
export const setIs = {
	/** Load and reps both saved. */
	completed: () => and(isNotNull(sets.executedLoad), isNotNull(sets.executedReps))
};

/**
 * The locked history filter from CLAUDE.md, in one place: "All history lookups
 * ... use these filters: WHERE executed_load IS NOT NULL AND executed_reps IS
 * NOT NULL AND sessions.ended_at IS NOT NULL". Also excludes trashed sessions.
 */
export const historyFilter = () => and(sessionIs.ended(), setIs.completed());
