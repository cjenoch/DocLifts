/**
 * The one workout-state vocabulary. Every rule about whether a workout is open,
 * ended or trashed, and whether a set is untouched, partial or completed, lives
 * here. Shared by client and server: no DB imports.
 */

/** Where a session is in its life: open (live), ended (finished) or trashed. */
export type SessionPhase = 'open' | 'ended' | 'trashed';

/** The two timestamps a session's phase is read from. */
export type SessionLike = { endedAt: Date | null; deletedAt: Date | null };

/**
 * A session is trashed when `deletedAt` is set (whether or not it ended),
 * ended when only `endedAt` is set, and open when neither is.
 */
export function sessionPhase(s: SessionLike): SessionPhase {
	if (s.deletedAt != null) return 'trashed';
	if (s.endedAt != null) return 'ended';
	return 'open';
}

/** How far a set has been logged: nothing, something, or load and reps both. */
export type SetStatus = 'untouched' | 'partial' | 'completed';

/** The four user-written fields a set's status is read from. */
export type SetLike = {
	executedLoad: number | null;
	executedReps: number | null;
	executedRir: number | null;
	notes: string | null;
};

/**
 * Completed when load and reps are both saved. Untouched when load, reps and
 * RIR are null and there is no note (an empty note counts as none). Else partial.
 */
export function setStatus(s: SetLike): SetStatus {
	if (s.executedLoad != null && s.executedReps != null) return 'completed';
	if (s.executedLoad != null || s.executedReps != null || s.executedRir != null || s.notes) {
		return 'partial';
	}
	return 'untouched';
}

/** True when any executed value or a non-empty note is saved on the set. */
export const isTouched = (s: SetLike) => setStatus(s) !== 'untouched';

/** True when both load and reps are saved on the set. */
export const isCompleted = (s: SetLike) => setStatus(s) === 'completed';

/** What the workout page may do with a session, decided once from its phase. */
export type WorkoutCapabilities = {
	phase: SessionPhase;
	canLogSets: boolean; // open, or ended with editEnded
	canEditLive: boolean; // open: add/remove/move/swap/bind/photo
	canFinish: boolean; // open
	canTrash: boolean; // ended
	canSaveAsProgram: boolean; // ended
	photoEnabled: boolean; // open && gymId != null
	editEnded: boolean; // ended && ?edit=1
};

/**
 * An open workout can log, edit, finish and take photos (photos need a gym). An
 * ended one can be trashed or saved as a program, and logs sets only with
 * `editEnded`. A trashed one can do nothing.
 */
export function workoutCapabilities(
	s: SessionLike & { gymId: string | null },
	opts: { editEnded: boolean }
): WorkoutCapabilities {
	const phase = sessionPhase(s);
	const open = phase === 'open';
	const ended = phase === 'ended';
	const editEnded = ended && opts.editEnded;
	return {
		phase,
		canLogSets: open || editEnded,
		canEditLive: open,
		canFinish: open,
		canTrash: ended,
		canSaveAsProgram: ended,
		photoEnabled: open && s.gymId != null,
		editEnded
	};
}
