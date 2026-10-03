/**
 * The add sheet and the Exercises page (0.8.0, machines spec Parts I and J):
 * every user-visible string and default in one place. Pages and tests read
 * them from here.
 */
import { workoutUi } from './workout-ui';

/** The eight groups (the 0019 CHECK), in the order the picker shows them; null = Other. */
export const BODY_REGIONS = [
	'legs',
	'back',
	'chest',
	'arms',
	'shoulders',
	'glutes',
	'core',
	'full body'
] as const;
export const MACHINE_TYPES = ['machine-stack', 'machine-plate', 'cable', 'smith'] as const;
export const FREE_TYPES = ['dumbbell', 'barbell', 'barbell-ez', 'bodyweight', 'band'] as const;

export const equipmentLabel = (type: string) =>
	({
		'machine-stack': 'Weight stack',
		'machine-plate': 'Plate-loaded',
		cable: 'Cable',
		smith: 'Smith',
		dumbbell: 'Dumbbell',
		barbell: 'Barbell',
		'barbell-ez': 'EZ bar',
		bodyweight: 'Bodyweight',
		band: 'Band'
	})[type] ?? type;

export const conventionLabel = (c: string) =>
	({
		plates_per_side: 'Plates per side',
		total_plates: 'All plates combined',
		per_arm: 'Per hand / arm',
		displayed: 'Total or displayed weight',
		unknown: 'Not sure — keep separate'
	})[c] ?? c;

/** The weight formats offered for a type, and the one preselected the first time. */
export function conventionsFor(type: string): { options: string[]; preset: string } {
	const plate = type === 'machine-plate';
	const options = [
		...(plate ? ['plates_per_side', 'total_plates'] : []),
		'per_arm',
		'displayed',
		'unknown'
	];
	const preset =
		(workoutUi.photoConvention as Record<string, string>)[type] ??
		({ dumbbell: 'per_arm', band: 'unknown' } as Record<string, string>)[type] ??
		'displayed';
	return { options, preset };
}

/** Regions whose exercises progress as lower body (+10). */
export const lowerBodyRegion = (region: string | null) => region === 'legs' || region === 'glutes';

export const pickerUi = {
	addExercise: 'Add exercise',
	close: 'Close',
	machinesTab: 'Machines',
	exercisesTab: 'Exercises',
	switchGym: 'Switch gym',
	photoMachine: 'Photo a machine',
	addByName: 'Add by name',
	machineName: 'Machine name',
	recentHere: 'Recent here',
	recent: 'Recent',
	other: 'Other',
	searchMachines: 'Search machines',
	searchExercises: 'Search exercises',
	noMachines: 'No machines at this gym yet. Photo one, or add it by name.',
	anotherExercise: 'Another exercise',
	suggested: 'Suggested for this machine',
	lastHere: (label: string) => `Last time here: ${label}`,
	create: (name: string) => `Create "${name}"`,
	equipment: 'Equipment',
	region: 'Body region',
	lowerBody: 'Lower body (bigger steps)',
	weightFormat: 'How do you record weight?',
	add: 'Add',
	back: 'Back',
	useMachine: (label: string) => `Use ${label}`,
	last: (date: string, load: number, reps: number) => `${date} · ${load} × ${reps}`,
	manageExercises: 'Manage exercises',
	// The Exercises page
	exercisesTitle: 'Exercises',
	exercisesIntro:
		'Rename an exercise, set its body region, or hide it from the picker. Past workouts keep the names they recorded.',
	rename: 'Rename',
	save: 'Save',
	hide: 'Hide',
	hidden: 'Hidden',
	restore: 'Restore',
	setsDefault: { setCount: 3, repsMin: 8, repsMax: 12, rir: 2 }
} as const;
