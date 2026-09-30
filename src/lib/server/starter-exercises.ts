/**
 * The starter exercise list every new account gets.
 *
 * WHY A LIST AND NOT AN EMPTY ACCOUNT
 * -----------------------------------
 * The program builder picks exercises from `exercises`, scoped to the owner.
 * A brand-new account with no rows has nothing to pick from, so the first
 * thing it sees is an empty picker and no obvious way to add to it — the app
 * looks broken before it is used once. The list is the floor that makes the
 * first session possible.
 *
 * SCOPED PER USER, NOT A GLOBAL CATALOGUE
 * ---------------------------------------
 * `exercises` is owned (`user_id`, NOT NULL since 0011) and every read is
 * owner-scoped. That is a deliberate T3 decision — a shared catalogue would be
 * a cross-tenant table, and the whole ownership model exists so that no query
 * needs to ask whose data it is. So the list is COPIED into each new user's
 * `exercises` rather than referenced, and users may edit their own copies
 * freely without affecting anyone else. The cost is duplicated rows; the
 * benefit is that the ownership rule has no exceptions carved out of it.
 *
 * (user_id, name) is unique — that is `exercises_user_id_name_unique`, created
 * by 0010 when it dropped the global `exercises_name_unique`. So the copy is
 * naturally idempotent per user, which is what the hook's onConflictDoNothing
 * relies on, and what lets seedDemo re-run without duplicating.
 *
 * NAME MATCHING IS THE WHOLE STORY
 * --------------------------------
 * Duplicates are resolved by name, because there is no shared id to copy
 * from. So a name here is an API: changing one does not rename it for users
 * who already have it. Treat the strings as append-only.
 */
export type StarterExercise = {
	name: string;
	equipmentType:
		| 'barbell'
		| 'barbell-ez'
		| 'machine-plate'
		| 'machine-stack'
		| 'cable'
		| 'dumbbell'
		| 'smith'
		| 'bodyweight'
		| 'band';
	/** N3: lower-body movements progress by +10, everything else by +5. */
	isLowerBody?: boolean;
};

/**
 * One row per movement, grouped the way someone actually trains.
 *
 * The first nine are deliberately the same nine `seedDemo` inserts. That is not
 * duplication for its own sake: it makes the demo account receive the starter
 * list from the hook and then have seedDemo's inserts collide on
 * (user_id, name), so the `onConflictDoNothing` + select-ids-back path runs
 * against real rows in the test suite instead of only being asserted in a
 * comment. Demo exercise counts therefore stay at nine.
 */
export const STARTER_EXERCISES: readonly StarterExercise[] = [
	// Push
	{ name: 'Barbell bench press', equipmentType: 'barbell' },
	{ name: 'Incline dumbbell press', equipmentType: 'dumbbell' },
	{ name: 'Dumbbell press', equipmentType: 'dumbbell' },
	{ name: 'Cable fly', equipmentType: 'cable' },
	{ name: 'Triceps pushdown', equipmentType: 'cable' },
	{ name: 'Overhead press', equipmentType: 'barbell' },
	{ name: 'Lat pulldown', equipmentType: 'machine-stack' },

	// Pull
	{ name: 'Barbell row', equipmentType: 'barbell' },
	{ name: 'Seated cable row', equipmentType: 'cable' },
	{ name: 'Dumbbell curl', equipmentType: 'dumbbell' },
	{ name: 'Barbell curl', equipmentType: 'barbell' },
	{ name: 'Face pull', equipmentType: 'cable' },

	// Legs
	{ name: 'Back squat', equipmentType: 'barbell', isLowerBody: true },
	{ name: 'Deadlift', equipmentType: 'barbell', isLowerBody: true },
	{ name: 'Leg press', equipmentType: 'machine-plate', isLowerBody: true },
	{ name: 'Leg curl', equipmentType: 'machine-stack', isLowerBody: true },
	{ name: 'Leg extension', equipmentType: 'machine-stack', isLowerBody: true },
	{ name: 'Calf raise', equipmentType: 'machine-stack', isLowerBody: true },
	{ name: 'Goblet squat', equipmentType: 'dumbbell', isLowerBody: true },
	{ name: 'Romanian deadlift', equipmentType: 'barbell', isLowerBody: true },

	// Core
	{ name: 'Plank', equipmentType: 'bodyweight' },
	{ name: 'Cable crunch', equipmentType: 'cable' },
	{ name: 'Pallof press', equipmentType: 'cable' }
] as const;
