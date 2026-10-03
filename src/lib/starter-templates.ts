import type { ProgramDraft } from './program-draft';
import { travelingPplDraft } from './traveling-ppl';

/**
 * The starter templates (editor spec, Part D): programs offered when a user
 * starts a new one. Each returns a fresh editable draft; nothing is saved until
 * the user saves it through saveProgramDraft like any other draft.
 *
 * Rules, all from the spec:
 * - an exercise reuses the user's library row only on an exact match of name,
 *   equipment type and lower-body flag; otherwise it is a quick-add (the rule
 *   travelingPplDraft follows: never silently retype an existing exercise);
 * - names and equipment types match the starter list where they overlap,
 *   because (user_id, name) is unique and a quick-add that collides with a
 *   differently typed row of the same name is refused on save;
 * - every set is a working set at 2 RIR; a MAIN lift is a top set followed by
 *   backoffs at the same target, because the draft validator requires that
 *   shape for MAIN;
 * - rest is 90–120 s, 120–180 s for MAIN; no starting loads.
 */

type LibraryExercise = {
	id: string;
	name: string;
	equipmentType: string;
	isLowerBody: boolean;
};

type DraftExercise = ProgramDraft['days'][number]['exercises'][number];
type EquipmentType = NonNullable<DraftExercise['newExercise']>['equipmentType'];

type Row = {
	name: string;
	equipmentType: EquipmentType;
	isLowerBody?: boolean;
	tier: DraftExercise['tier'];
	sets: number;
	reps: [number, number];
	seconds?: boolean;
	notes?: string;
};

const PER_SIDE = 'Reps are per side.';

function builder(library: LibraryExercise[]) {
	return function exercise(row: Row): DraftExercise {
		const { name, equipmentType, isLowerBody = false, tier, sets, reps, seconds = false } = row;
		const existing = library.find(
			(entry) =>
				entry.name === name &&
				entry.equipmentType === equipmentType &&
				entry.isLowerBody === isLowerBody
		);
		const main = tier === 'main';
		return {
			exerciseId: existing?.id ?? null,
			newExercise: existing ? null : { name, equipmentType, isLowerBody },
			tier,
			progressionPolicy: 'standard',
			notes: row.notes ?? null,
			sets: Array.from({ length: sets }, (_, index) => ({
				setRole: main ? (index === 0 ? 'top' : 'backoff') : 'working',
				targetMetric: seconds ? 'seconds' : 'reps',
				targetRepsMin: reps[0],
				targetRepsMax: reps[1],
				// Reps in reserve has no meaning for a timed hold.
				targetRir: seconds ? null : 2,
				restSecondsMin: main ? 120 : 90,
				restSecondsMax: main ? 180 : 120,
				initialLoad: null,
				notes: null
			}))
		};
	};
}

function day(name: string, exercises: DraftExercise[]): ProgramDraft['days'][number] {
	return { name, notes: null, alternateGroupId: null, exercises };
}

export function barbellStrengthDraft(library: LibraryExercise[] = []): ProgramDraft {
	const ex = builder(library);
	const overheadPress = (reps: [number, number]) =>
		ex({ name: 'Overhead press', equipmentType: 'barbell', tier: 'main', sets: 3, reps });
	const bench = (reps: [number, number]) =>
		ex({ name: 'Barbell bench press', equipmentType: 'barbell', tier: 'main', sets: 3, reps });
	const legCurl = (sets: number) =>
		ex({
			name: 'Leg curl',
			equipmentType: 'machine-stack',
			isLowerBody: true,
			tier: 'isolation',
			sets,
			reps: [10, 15]
		});
	return {
		name: 'Barbell Strength, 4 days',
		description:
			'Four days: two heavy, one volume and one deadlift day. Run them in order, resting as needed. Loads start blank.',
		days: [
			day('Upper heavy', [
				overheadPress([5, 5]),
				bench([5, 5]),
				ex({
					name: 'Barbell row',
					equipmentType: 'barbell',
					tier: 'secondary',
					sets: 3,
					reps: [6, 8]
				}),
				ex({
					name: 'Face pull',
					equipmentType: 'cable',
					tier: 'isolation',
					sets: 2,
					reps: [12, 20]
				})
			]),
			day('Lower heavy', [
				ex({
					name: 'Back squat',
					equipmentType: 'barbell',
					isLowerBody: true,
					tier: 'main',
					sets: 3,
					reps: [5, 5]
				}),
				ex({
					name: 'Romanian deadlift',
					equipmentType: 'barbell',
					isLowerBody: true,
					tier: 'secondary',
					sets: 2,
					reps: [8, 10]
				}),
				legCurl(2),
				ex({
					name: 'Plank',
					equipmentType: 'bodyweight',
					tier: 'isolation',
					sets: 2,
					reps: [30, 60],
					seconds: true
				})
			]),
			day('Upper volume', [
				overheadPress([8, 10]),
				bench([8, 10]),
				ex({
					name: 'Lat pulldown',
					equipmentType: 'machine-stack',
					tier: 'secondary',
					sets: 3,
					reps: [8, 12]
				}),
				ex({
					name: 'Barbell curl',
					equipmentType: 'barbell',
					tier: 'isolation',
					sets: 2,
					reps: [8, 12]
				}),
				ex({
					name: 'Triceps pushdown',
					equipmentType: 'cable',
					tier: 'isolation',
					sets: 2,
					reps: [10, 15]
				})
			]),
			day('Lower, deadlift', [
				ex({
					name: 'Deadlift',
					equipmentType: 'barbell',
					isLowerBody: true,
					tier: 'main',
					sets: 1,
					reps: [5, 5]
				}),
				ex({
					name: 'Leg press',
					equipmentType: 'machine-plate',
					isLowerBody: true,
					tier: 'secondary',
					sets: 2,
					reps: [10, 15]
				}),
				ex({
					name: 'Calf raise',
					equipmentType: 'machine-stack',
					isLowerBody: true,
					tier: 'isolation',
					sets: 2,
					reps: [10, 15]
				})
			])
		]
	};
}

export function machineFullBodyDraft(library: LibraryExercise[] = []): ProgramDraft {
	const ex = builder(library);
	const secondary = (name: string, equipmentType: EquipmentType, isLowerBody = false) =>
		ex({ name, equipmentType, isLowerBody, tier: 'secondary', sets: 3, reps: [8, 12] });
	const isolation = (name: string, equipmentType: EquipmentType, isLowerBody = false) =>
		ex({ name, equipmentType, isLowerBody, tier: 'isolation', sets: 2, reps: [10, 15] });
	return {
		name: 'Machine Full Body, 3 days a week',
		description:
			'Two full-body workouts, A and B, alternated three days a week: A, B, A one week, then B, A, B. Loads start blank.',
		days: [
			day('Workout A', [
				secondary('Leg press', 'machine-plate', true),
				secondary('Machine chest press', 'machine-stack'),
				secondary('Lat pulldown', 'machine-stack'),
				isolation('Leg curl', 'machine-stack', true),
				isolation('Triceps pushdown', 'cable')
			]),
			day('Workout B', [
				secondary('Machine shoulder press', 'machine-stack'),
				secondary('Seated row', 'machine-stack'),
				isolation('Leg extension', 'machine-stack', true),
				isolation('Calf raise', 'machine-stack', true),
				isolation('Dumbbell curl', 'dumbbell'),
				isolation('Cable crunch', 'cable')
			])
		]
	};
}

export function machinesAndDumbbellsDraft(library: LibraryExercise[] = []): ProgramDraft {
	const ex = builder(library);
	const secondary = (
		name: string,
		equipmentType: EquipmentType,
		isLowerBody = false,
		sets = 3,
		notes?: string
	) => ex({ name, equipmentType, isLowerBody, tier: 'secondary', sets, reps: [8, 12], notes });
	const isolation = (
		name: string,
		equipmentType: EquipmentType,
		isLowerBody = false,
		sets = 2,
		reps: [number, number] = [10, 15]
	) => ex({ name, equipmentType, isLowerBody, tier: 'isolation', sets, reps });
	return {
		name: 'Machines and Dumbbells, 4 days',
		description:
			'Upper and lower twice a week on machines and dumbbells: Upper A, Lower A, Upper B, Lower B. Loads start blank.',
		days: [
			day('Upper A', [
				secondary('Machine chest press', 'machine-stack'),
				secondary('Seated row', 'machine-stack'),
				secondary('Dumbbell shoulder press', 'dumbbell'),
				isolation('Dumbbell curl', 'dumbbell'),
				isolation('Triceps pushdown', 'cable')
			]),
			day('Lower A', [
				secondary('Leg press', 'machine-plate', true),
				secondary('Dumbbell Romanian deadlift', 'dumbbell', true),
				isolation('Leg extension', 'machine-stack', true),
				isolation('Leg curl', 'machine-stack', true),
				isolation('Calf raise', 'machine-stack', true)
			]),
			day('Upper B', [
				secondary('Incline dumbbell press', 'dumbbell'),
				secondary('Lat pulldown', 'machine-stack'),
				secondary('Dumbbell row', 'dumbbell', false, 3, PER_SIDE),
				isolation('Lateral raise', 'dumbbell', false, 2, [12, 20]),
				isolation('Dumbbell hammer curl', 'dumbbell')
			]),
			day('Lower B', [
				secondary('Goblet squat', 'dumbbell', true),
				isolation('Leg curl', 'machine-stack', true, 3),
				secondary('Dumbbell split squat', 'dumbbell', true, 2, PER_SIDE),
				isolation('Leg extension', 'machine-stack', true),
				isolation('Cable crunch', 'cable')
			])
		]
	};
}

/** The editor's starting points, in the order the spec lists them. */
export const STARTER_TEMPLATES = [
	{ key: 'traveling-ppl', label: 'Traveling PPL', build: travelingPplDraft },
	{ key: 'barbell-strength', label: 'Barbell Strength, 4 days', build: barbellStrengthDraft },
	{
		key: 'machine-full-body',
		label: 'Machine Full Body, 3 days a week',
		build: machineFullBodyDraft
	},
	{
		key: 'machines-and-dumbbells',
		label: 'Machines and Dumbbells, 4 days',
		build: machinesAndDumbbellsDraft
	}
] as const;
