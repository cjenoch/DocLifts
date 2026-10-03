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
 * relies on.
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
	/** The picker's group (0.7.0); migration 0019 backfills the same values by name. */
	bodyRegion: 'legs' | 'back' | 'chest' | 'arms' | 'shoulders' | 'glutes' | 'core' | 'full body';
};

/**
 * One row per movement, grouped the way someone actually trains.
 *
 */
export const STARTER_EXERCISES: readonly StarterExercise[] = [
	// Push
	{ name: 'Barbell bench press', equipmentType: 'barbell', bodyRegion: 'chest' },
	{ name: 'Incline dumbbell press', equipmentType: 'dumbbell', bodyRegion: 'chest' },
	{ name: 'Dumbbell press', equipmentType: 'dumbbell', bodyRegion: 'chest' },
	{ name: 'Cable fly', equipmentType: 'cable', bodyRegion: 'chest' },
	{ name: 'Triceps pushdown', equipmentType: 'cable', bodyRegion: 'arms' },
	{ name: 'Overhead press', equipmentType: 'barbell', bodyRegion: 'shoulders' },
	{ name: 'Lat pulldown', equipmentType: 'machine-stack', bodyRegion: 'back' },

	// Pull
	{ name: 'Barbell row', equipmentType: 'barbell', bodyRegion: 'back' },
	{ name: 'Seated cable row', equipmentType: 'cable', bodyRegion: 'back' },
	{ name: 'Dumbbell curl', equipmentType: 'dumbbell', bodyRegion: 'arms' },
	{ name: 'Barbell curl', equipmentType: 'barbell', bodyRegion: 'arms' },
	{ name: 'Face pull', equipmentType: 'cable', bodyRegion: 'shoulders' },

	// Legs
	{ name: 'Back squat', equipmentType: 'barbell', isLowerBody: true, bodyRegion: 'legs' },
	{ name: 'Deadlift', equipmentType: 'barbell', isLowerBody: true, bodyRegion: 'legs' },
	{ name: 'Leg press', equipmentType: 'machine-plate', isLowerBody: true, bodyRegion: 'legs' },
	{ name: 'Leg curl', equipmentType: 'machine-stack', isLowerBody: true, bodyRegion: 'legs' },
	{ name: 'Leg extension', equipmentType: 'machine-stack', isLowerBody: true, bodyRegion: 'legs' },
	{ name: 'Calf raise', equipmentType: 'machine-stack', isLowerBody: true, bodyRegion: 'legs' },
	{ name: 'Goblet squat', equipmentType: 'dumbbell', isLowerBody: true, bodyRegion: 'legs' },
	{ name: 'Romanian deadlift', equipmentType: 'barbell', isLowerBody: true, bodyRegion: 'legs' },

	// Core
	{ name: 'Plank', equipmentType: 'bodyweight', bodyRegion: 'core' },
	{ name: 'Cable crunch', equipmentType: 'cable', bodyRegion: 'core' },
	{ name: 'Pallof press', equipmentType: 'cable', bodyRegion: 'core' }
] as const;
