import { describe, expect, it } from 'vitest';
import { programDraftSchema, type ProgramDraft } from './program-draft';
import {
	STARTER_TEMPLATES,
	barbellStrengthDraft,
	machineFullBodyDraft,
	machinesAndDumbbellsDraft
} from './starter-templates';
import { travelingPplDraft } from './traveling-ppl';

// The spec's tables (editor spec, Part D): day, then [name, sets, min, max, tier].
type Table = [string, [string, number, number, number, string][]][];

const barbellStrength: Table = [
	[
		'Upper heavy',
		[
			['Overhead press', 3, 5, 5, 'main'],
			['Barbell bench press', 3, 5, 5, 'main'],
			['Barbell row', 3, 6, 8, 'secondary'],
			['Face pull', 2, 12, 20, 'isolation']
		]
	],
	[
		'Lower heavy',
		[
			['Back squat', 3, 5, 5, 'main'],
			['Romanian deadlift', 2, 8, 10, 'secondary'],
			['Leg curl', 2, 10, 15, 'isolation'],
			['Plank', 2, 30, 60, 'isolation']
		]
	],
	[
		'Upper volume',
		[
			['Overhead press', 3, 8, 10, 'main'],
			['Barbell bench press', 3, 8, 10, 'main'],
			['Lat pulldown', 3, 8, 12, 'secondary'],
			['Barbell curl', 2, 8, 12, 'isolation'],
			['Triceps pushdown', 2, 10, 15, 'isolation']
		]
	],
	[
		'Lower, deadlift',
		[
			['Deadlift', 1, 5, 5, 'main'],
			['Leg press', 2, 10, 15, 'secondary'],
			['Calf raise', 2, 10, 15, 'isolation']
		]
	]
];

const machineFullBody: Table = [
	[
		'Workout A',
		[
			['Leg press', 3, 8, 12, 'secondary'],
			['Machine chest press', 3, 8, 12, 'secondary'],
			['Lat pulldown', 3, 8, 12, 'secondary'],
			['Leg curl', 2, 10, 15, 'isolation'],
			['Triceps pushdown', 2, 10, 15, 'isolation']
		]
	],
	[
		'Workout B',
		[
			['Machine shoulder press', 3, 8, 12, 'secondary'],
			['Seated row', 3, 8, 12, 'secondary'],
			['Leg extension', 2, 10, 15, 'isolation'],
			['Calf raise', 2, 10, 15, 'isolation'],
			['Dumbbell curl', 2, 10, 15, 'isolation'],
			['Cable crunch', 2, 10, 15, 'isolation']
		]
	]
];

const machinesAndDumbbells: Table = [
	[
		'Upper A',
		[
			['Machine chest press', 3, 8, 12, 'secondary'],
			['Seated row', 3, 8, 12, 'secondary'],
			['Dumbbell shoulder press', 3, 8, 12, 'secondary'],
			['Dumbbell curl', 2, 10, 15, 'isolation'],
			['Triceps pushdown', 2, 10, 15, 'isolation']
		]
	],
	[
		'Lower A',
		[
			['Leg press', 3, 8, 12, 'secondary'],
			['Dumbbell Romanian deadlift', 3, 8, 12, 'secondary'],
			['Leg extension', 2, 10, 15, 'isolation'],
			['Leg curl', 2, 10, 15, 'isolation'],
			['Calf raise', 2, 10, 15, 'isolation']
		]
	],
	[
		'Upper B',
		[
			['Incline dumbbell press', 3, 8, 12, 'secondary'],
			['Lat pulldown', 3, 8, 12, 'secondary'],
			['Dumbbell row', 3, 8, 12, 'secondary'],
			['Lateral raise', 2, 12, 20, 'isolation'],
			['Dumbbell hammer curl', 2, 10, 15, 'isolation']
		]
	],
	[
		'Lower B',
		[
			['Goblet squat', 3, 8, 12, 'secondary'],
			['Leg curl', 3, 10, 15, 'isolation'],
			['Dumbbell split squat', 2, 8, 12, 'secondary'],
			['Leg extension', 2, 10, 15, 'isolation'],
			['Cable crunch', 2, 10, 15, 'isolation']
		]
	]
];

const cases: [string, () => ProgramDraft, Table][] = [
	['Barbell Strength, 4 days', () => barbellStrengthDraft(), barbellStrength],
	['Machine Full Body, 3 days a week', () => machineFullBodyDraft(), machineFullBody],
	['Machines and Dumbbells, 4 days', () => machinesAndDumbbellsDraft(), machinesAndDumbbells]
];

const rows = (draft: ProgramDraft) => draft.days.flatMap((day) => day.exercises);
const named = (draft: ProgramDraft, name: string) =>
	rows(draft).filter((row) => row.newExercise?.name === name);

describe('starter templates', () => {
	it('offers the four templates in the spec order, Traveling PPL unchanged', () => {
		expect(STARTER_TEMPLATES.map((t) => t.label)).toEqual([
			'Traveling PPL',
			'Barbell Strength, 4 days',
			'Machine Full Body, 3 days a week',
			'Machines and Dumbbells, 4 days'
		]);
		expect(STARTER_TEMPLATES[0].build).toBe(travelingPplDraft);
		for (const template of STARTER_TEMPLATES) {
			const draft = template.build([]);
			expect(programDraftSchema.parse(draft)).toEqual(draft);
			expect(draft.name).toBe(template.label);
		}
	});

	it.each(cases)('%s matches the spec table', (name, build, table) => {
		const draft = build();
		expect(draft.name).toBe(name);
		expect(draft.days.map((day) => day.name)).toEqual(table.map(([dayName]) => dayName));
		for (const [dayIndex, [, expected]] of table.entries()) {
			const actual = draft.days[dayIndex].exercises.map((row) => [
				row.newExercise?.name,
				row.sets.length,
				row.sets[0].targetRepsMin,
				row.sets[0].targetRepsMax,
				row.tier
			]);
			expect(actual).toEqual(expected);
		}
		// Alternating A/B is a rotation, not an either-or group.
		expect(draft.days.every((day) => day.alternateGroupId === null)).toBe(true);
	});

	it.each(cases)(
		'%s: working sets at 2 RIR, MAIN as top plus backoffs, rest by tier, no loads',
		(_, build) => {
			for (const row of rows(build())) {
				const main = row.tier === 'main';
				expect(row.progressionPolicy).toBe('standard');
				for (const [index, set] of row.sets.entries()) {
					expect(set.setRole).toBe(main ? (index === 0 ? 'top' : 'backoff') : 'working');
					expect(set.restSecondsMin).toBe(main ? 120 : 90);
					expect(set.restSecondsMax).toBe(main ? 180 : 120);
					expect(set.initialLoad).toBeNull();
					expect(set.targetRir).toBe(set.targetMetric === 'seconds' ? null : 2);
					// Every set of an exercise has the same target.
					expect(set.targetRepsMin).toBe(row.sets[0].targetRepsMin);
					expect(set.targetRepsMax).toBe(row.sets[0].targetRepsMax);
				}
			}
		}
	);

	it('accepts a single-set MAIN lift: the deadlift is one top set of 5', () => {
		const [deadlift] = named(barbellStrengthDraft(), 'Deadlift');
		expect(deadlift.sets).toHaveLength(1);
		expect(deadlift.sets[0]).toMatchObject({
			setRole: 'top',
			targetRepsMin: 5,
			targetRepsMax: 5
		});
		expect(deadlift.newExercise).toEqual({
			name: 'Deadlift',
			equipmentType: 'barbell',
			isLowerBody: true
		});
		expect(programDraftSchema.safeParse(barbellStrengthDraft()).success).toBe(true);
	});

	it('the plank is timed: seconds as its target, 30 to 60', () => {
		const [plank] = named(barbellStrengthDraft(), 'Plank');
		expect(plank.newExercise).toEqual({
			name: 'Plank',
			equipmentType: 'bodyweight',
			isLowerBody: false
		});
		for (const set of plank.sets)
			expect(set).toMatchObject({ targetMetric: 'seconds', targetRepsMin: 30, targetRepsMax: 60 });
		const timed = cases.flatMap(([, build]) =>
			rows(build()).flatMap((row) => row.sets.filter((set) => set.targetMetric === 'seconds'))
		);
		expect(timed).toHaveLength(2);
	});

	it('marks the one-sided dumbbell exercises as reps per side', () => {
		const draft = machinesAndDumbbellsDraft();
		for (const name of ['Dumbbell row', 'Dumbbell split squat'])
			expect(named(draft, name)[0].notes).toMatch(/per side/i);
	});

	it('reuses a library row only on an exact name, equipment and lower-body match', () => {
		const library = [
			{
				id: '11111111-1111-4111-8111-111111111111',
				name: 'Leg press',
				equipmentType: 'machine-plate',
				isLowerBody: true
			},
			{
				id: '22222222-2222-4222-8222-222222222222',
				name: 'Leg curl',
				equipmentType: 'machine-plate',
				isLowerBody: true
			},
			{
				id: '33333333-3333-4333-8333-333333333333',
				name: 'calf raise',
				equipmentType: 'machine-stack',
				isLowerBody: true
			}
		];
		const before = structuredClone(library);
		const draft = machineFullBodyDraft(library);
		const legPress = draft.days[0].exercises[0];
		expect(legPress).toMatchObject({ exerciseId: library[0].id, newExercise: null });
		// Same name, different equipment type: a quick-add, never a retype.
		expect(draft.days[0].exercises[3]).toMatchObject({
			exerciseId: null,
			newExercise: { name: 'Leg curl', equipmentType: 'machine-stack', isLowerBody: true }
		});
		// No case-insensitive matching.
		expect(draft.days[1].exercises[3].exerciseId).toBeNull();
		expect(library).toEqual(before);
		expect(programDraftSchema.safeParse(draft).success).toBe(true);
	});

	it('returns a fresh draft every time, so editing one changes no other', () => {
		for (const [, build] of cases) {
			const first = build();
			const second = build();
			first.days[0].exercises[0].sets[0].targetRepsMax = 99;
			first.days[0].exercises[0].newExercise!.name = 'Edited';
			expect(second.days[0].exercises[0].sets[0].targetRepsMax).not.toBe(99);
			expect(second.days[0].exercises[0].newExercise?.name).not.toBe('Edited');
			expect(build()).toEqual(second);
		}
	});

	it('names no physical machine, manufacturer or load', () => {
		for (const [, build] of cases)
			expect(JSON.stringify(build())).not.toMatch(
				/gymEquipmentId|machineId|equipmentModel|manufacturer|loadConvention|currentLoad|Hammer Strength|Nautilus/i
			);
	});
});
