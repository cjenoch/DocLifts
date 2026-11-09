/**
 * Strings of the program page that concern retired versions (owner decision,
 * 2026-11-08: a retired program version is read-only, with a link to the
 * current one). Tests read them from here.
 */
export const programUi = {
	replaced: 'This version was replaced.',
	openCurrent: (name: string) => `Open the current version: ${name}`,
	noCurrent: 'No current version of this program exists.',
	readOnlyNote: 'Past workouts stay here. Open workouts can still be resumed.',
	/** startSessionForDay's refusal on a retired version. */
	startRefused: 'This version was replaced. Start the workout from the current version.'
};
