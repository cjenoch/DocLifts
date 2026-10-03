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
 * Later parts add their defaults here too. `defaultRestSeconds` is Part F's
 * and is not used yet.
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
	/**
	 * Photo in the workout (0.6.0, Part C). A photo opens a block at once on a
	 * placeholder machine and exercise; the read runs afterwards.
	 */
	photoNextMachine: 'Photo next machine',
	/** The button's label while the photo is sent. */
	photoAdding: 'Adding photo…',
	/** The placeholder machine's label: "Photo" and the time it was taken. */
	photoMachineLabel: (time: string) => `Photo ${time}`,
	/** The placeholder's equipment type until the model is known. */
	photoPlaceholderType: 'machine-stack',
	/** Sets a photo block opens with, and their targets. */
	photoBlockSets: 3,
	photoBlockRepsMin: 8,
	photoBlockRepsMax: 12,
	photoBlockRir: 2,
	/** While the read runs (owner's wording, 2026-10-02). */
	photoReading: 'Identifying machine…',
	/** Any read that ends without a match: failure, timeout, limit, no placard. */
	photoReadFailed: 'Could not read this photo. Name it now or later.',
	photoReadAgain: 'Read again',
	photoNameIt: 'Name it',
	photoUseThis: 'Use this',
	photoLater: 'Later',
	/** A named photo block on an open workout (0.6.1), with its undo. */
	photoNamedFrom: (label: string) => `Named from your photo: ${label}`,
	photoUndo: 'Undo',
	/** The match card's way to the review page, for a different model. */
	photoOtherMachine: 'Other machine',
	photoExerciseLabel: 'Exercise',
	photoWeightLabel: 'Record weight as',
	/** How weight is recorded on an identified machine, by equipment type. */
	photoConvention: {
		'machine-plate': 'plates_per_side',
		'machine-stack': 'displayed',
		cable: 'displayed',
		smith: 'displayed'
	} as Record<string, 'plates_per_side' | 'total_plates' | 'per_arm' | 'displayed' | 'unknown'>,
	/** Blocks still on the placeholder, on the session page and Home. */
	machinesToName: (n: number) => `${n} ${n === 1 ? 'machine' : 'machines'} to name`,
	/** Editing a live workout (editor spec, Part L): the per-exercise menu. */
	exerciseMenu: (name: string) => `Options for ${name}`,
	moveUp: 'Move up',
	moveDown: 'Move down',
	swap: 'Swap exercise',
	remove: 'Remove',
	skipRest: 'Skip the rest',
	removeWithSets: 'Remove exercise and its sets',
	/** The confirm step before logged sets are deleted. */
	confirmRemoveLogged: (name: string, n: number) =>
		`Remove ${name} and delete its ${n} logged ${n === 1 ? 'set' : 'sets'}?`,
	/** In place of a confirm: the exercise is gone, with Undo for this long. */
	removedLine: (name: string) => `${name} removed`,
	undo: 'Undo',
	undoSeconds: 5,
	swapLocked: 'Logged sets: swap is closed. Skip the rest and add the other exercise.',
	/** The swap sheet and its confirm step. */
	swapFor: (name: string) => `Swap ${name} for…`,
	swapConfirm: (from: string, to: string) => `Swap ${from} for ${to}?`,
	swapNote: 'Sets and targets stay; weights come from its own history.',
	swapToday: 'Just today',
	swapFromNow: 'From now on',
	swapFromNowNote: 'From now on changes the program when you finish this workout.',
	swapGo: 'Swap',
	/** The finished workout's page, after a "From now on" swap. */
	programUpdated: 'Your program now uses the swapped exercise from the next workout on.',
	programUpdateFailed: {
		open: 'The program was not changed: another of its workouts is still open. It is as it was.',
		changed:
			'The program was not changed: it was edited since this workout began. It is as it was.',
		invalid:
			'The program was not changed: the new version did not pass its checks. It is as it was.'
	},
	viewProgram: 'View program',
	/** Part F: rest timer default. */
	defaultRestSeconds: 90
} as const;
