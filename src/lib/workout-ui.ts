/**
 * Every user-visible default for workouts started without a program (0.5.1,
 * spec 0.5.0 Part B), in one place. Owner rule: each default is a one-line
 * change here, and tests read the strings from this object rather than from
 * literals, so changing a value never needs a test edit.
 *
 * `quickProgramName` and `quickDayName` are written into the database when a
 * user's quick program is first created; changing them later renames nothing
 * already stored. Everything else is read at render time.
 *
 * Later parts add their defaults here too. `placeholderExerciseName` and
 * `defaultRestSeconds` are settings for those parts and are not used yet.
 */
export const workoutUi = {
	/** Home's primary button when no quick workout is open. */
	startWorkout: 'Start workout',
	/** The same button while a quick workout is open. */
	resumeWorkout: 'Resume workout',
	/** Name of the hidden system program that holds quick workouts. */
	quickProgramName: 'Quick workouts',
	/** Name of that program's single day. */
	quickDayName: 'Workout',
	/** Heading on a quick workout's session page, shown with the date. */
	sessionHeading: 'Workout',
	/** Label for a quick workout in History and Reports. */
	quickWorkoutLabel: 'Quick workout',
	/** The gym step before a quick workout opens. */
	gymStepHeading: 'Which gym?',
	gymStepChoose: 'Gym',
	gymStepNewName: 'New gym name',
	gymStepNewNamePlaceholder: 'e.g. Your gym or Home',
	gymStepSubmit: 'Start',
	/** Trash on History (0.5.2): every trashed workout, quick or program. */
	historyTrashHeading: 'Trash',
	historyTrashEmpty: 'Trash is empty.',
	historyTrashIntro: 'Restore a workout or delete it for good.',
	historyTrashTruncated: (shown: number) => `Showing the ${shown} most recently trashed.`,
	historyTrashSets: (n: number) => `${n} ${n === 1 ? 'set' : 'sets'} logged`,
	historyTrashRestore: 'Restore',
	historyTrashDelete: 'Delete permanently',
	/** Mirrors the program page's confirmation, with the History label. */
	historyTrashConfirmDelete: (label: string, date: string) =>
		`Permanently delete ${label} from ${date}? This cannot be undone.`,
	/** Part C: name of an exercise logged before its machine is identified. */
	placeholderExerciseName: 'Unidentified machine',
	/** Part F: rest timer default. */
	defaultRestSeconds: 90
} as const;
