import type { ProgramDraft } from './program-draft';

type LibraryExercise = {
	id: string;
	name: string;
	equipmentType: string;
	isLowerBody: boolean;
};

type DraftExercise = ProgramDraft['days'][number]['exercises'][number];

type Prescription = {
	name: string;
	equipmentType: NonNullable<DraftExercise['newExercise']>['equipmentType'];
	isLowerBody?: boolean;
	tier: DraftExercise['tier'];
	count?: number;
	reps: [number, number];
	progressionPolicy?: DraftExercise['progressionPolicy'];
	longRest?: boolean;
	notes?: string;
};

/** Editable generic structure only; saving uses the same validation path as a blank draft. */
export function travelingPplDraft(library: LibraryExercise[] = []): ProgramDraft {
	function exercise(prescription: Prescription): DraftExercise {
		const {
			name,
			equipmentType,
			isLowerBody = false,
			tier,
			count = 2,
			reps,
			progressionPolicy = 'standard',
			longRest = false,
			notes = null
		} = prescription;
		// Name alone is insufficient: equipment and lower-body metadata affect progression.
		// Leave incompatible collisions as quick-adds for the save validator to reject;
		// never silently retype an existing library definition.
		const existing = library.find(
			(entry) =>
				entry.name === name &&
				entry.equipmentType === equipmentType &&
				entry.isLowerBody === isLowerBody
		);
		return {
			exerciseId: existing?.id ?? null,
			newExercise: existing ? null : { name, equipmentType, isLowerBody },
			tier,
			progressionPolicy,
			notes,
			sets: Array.from({ length: count }, () => ({
				setRole: 'working',
				targetMetric: 'reps',
				targetRepsMin: reps[0],
				targetRepsMax: reps[1],
				targetRir: 2,
				restSecondsMin: longRest ? 120 : 90,
				restSecondsMax: longRest ? 180 : 120,
				initialLoad: null,
				notes: null
			}))
		};
	}

	const pendulumSquat = (count: number) =>
		exercise({
			name: 'Pendulum squat',
			equipmentType: 'machine-plate',
			isLowerBody: true,
			tier: 'secondary',
			count,
			reps: [8, 12],
			longRest: true,
			notes: 'Hack squat or leg press are alternatives.'
		});
	const legCurl = () =>
		exercise({
			name: 'Seated leg curl',
			equipmentType: 'machine-stack',
			isLowerBody: true,
			tier: 'isolation',
			reps: [10, 15]
		});
	const kickback = () =>
		exercise({
			name: 'Glute kickback',
			equipmentType: 'machine-stack',
			isLowerBody: true,
			tier: 'isolation',
			reps: [10, 15],
			notes: 'Perform the prescribed reps per side if unilateral.'
		});
	const calfRaise = () =>
		exercise({
			name: 'Seated calf raise',
			equipmentType: 'machine-plate',
			isLowerBody: true,
			tier: 'isolation',
			count: 3,
			reps: [10, 15]
		});

	return {
		name: 'Traveling PPL',
		description:
			'Rolling Push → Pull → ONE Legs variant; rest as needed. Choose Legs A or Legs B for each Legs turn, not both. Equipment defaults are generic and editable; select the physical machine during the workout. Loads start blank.',
		days: [
			{
				name: 'Push',
				notes: 'Optional second triceps exercise: 1–2 × 10–15; add only if wanted.',
				alternateGroupId: null,
				exercises: [
					exercise({
						name: 'Standing strict barbell overhead press',
						equipmentType: 'barbell',
						tier: 'secondary',
						progressionPolicy: 'cautious',
						count: 3,
						reps: [4, 6],
						longRest: true,
						notes:
							'First-priority lift. SECONDARY is engine semantics, not exercise priority: straight working sets. Warmup: use an appropriate bar plus a brief intermediate ramp as needed; no assumed bar weight or seeded loads.'
					}),
					exercise({
						name: 'Flat plate-loaded chest press',
						equipmentType: 'machine-plate',
						tier: 'secondary',
						reps: [8, 12]
					}),
					exercise({
						name: 'Chest fly',
						equipmentType: 'machine-stack',
						tier: 'isolation',
						reps: [10, 15],
						notes: 'Alternative: another press angle.'
					}),
					exercise({
						name: 'Lateral raise',
						equipmentType: 'dumbbell',
						tier: 'isolation',
						progressionPolicy: 'cautious',
						reps: [12, 20]
					}),
					exercise({
						name: 'Triceps pushdown',
						equipmentType: 'cable',
						tier: 'isolation',
						reps: [10, 15],
						notes: 'A triceps extension is an alternative.'
					})
				]
			},
			{
				name: 'Pull',
				notes:
					'May reverse the first two exercises (pullover and lat pulldown). Optional abs: 2 × 10–15; add only if wanted.',
				alternateGroupId: null,
				exercises: [
					exercise({
						name: 'Pullover',
						equipmentType: 'machine-stack',
						tier: 'isolation',
						reps: [10, 15]
					}),
					exercise({
						name: 'Lat pulldown',
						equipmentType: 'machine-stack',
						tier: 'secondary',
						reps: [8, 12]
					}),
					exercise({
						name: 'Seated ISO/chest-supported row',
						equipmentType: 'machine-plate',
						tier: 'secondary',
						reps: [8, 12]
					}),
					exercise({
						name: 'Rear-delt fly',
						equipmentType: 'machine-stack',
						tier: 'isolation',
						reps: [12, 20]
					}),
					exercise({
						name: 'Preacher curl',
						equipmentType: 'machine-stack',
						tier: 'isolation',
						reps: [8, 12]
					}),
					exercise({
						name: 'Dumbbell hammer curl',
						equipmentType: 'dumbbell',
						tier: 'isolation',
						reps: [8, 12]
					})
				]
			},
			{
				name: 'Legs A - Deadlift',
				notes:
					'Choose this OR Legs B on a Legs turn. Optional leg extension if fresh; add only if wanted.',
				alternateGroupId: 'legs',
				exercises: [
					exercise({
						name: 'Conventional deadlift',
						equipmentType: 'barbell',
						isLowerBody: true,
						tier: 'secondary',
						progressionPolicy: 'hold',
						reps: [4, 6],
						longRest: true,
						notes:
							'First-priority lift. SECONDARY is engine semantics, not exercise priority: straight working sets. Hold policy leaves load progression to your input.'
					}),
					pendulumSquat(2),
					legCurl(),
					kickback(),
					calfRaise()
				]
			},
			{
				name: 'Legs B - Machines',
				notes:
					'Choose this OR Legs A on a Legs turn. RDL is an acceptable fallback, not the default; edit only if needed.',
				alternateGroupId: 'legs',
				exercises: [
					pendulumSquat(3),
					legCurl(),
					kickback(),
					exercise({
						name: 'Leg extension',
						equipmentType: 'machine-stack',
						isLowerBody: true,
						tier: 'isolation',
						reps: [10, 15]
					}),
					calfRaise()
				]
			}
		]
	};
}
