import { describe, expect, it } from 'vitest';
import { travelingPplDraft } from './traveling-ppl';
import { programDraftSchema } from './program-draft';

// Approved working prescriptions: name, sets, rep range, equipment, lower-body, tier.
const approved = [
	[
		['Standing strict barbell overhead press', 3, 4, 6, 'barbell', false, 'secondary'],
		['Flat plate-loaded chest press', 2, 8, 12, 'machine-plate', false, 'secondary'],
		['Chest fly', 2, 10, 15, 'machine-stack', false, 'isolation'],
		['Lateral raise', 2, 12, 20, 'dumbbell', false, 'isolation'],
		['Triceps pushdown', 2, 10, 15, 'cable', false, 'isolation']
	],
	[
		['Pullover', 2, 10, 15, 'machine-stack', false, 'isolation'],
		['Lat pulldown', 2, 8, 12, 'machine-stack', false, 'secondary'],
		['Seated ISO/chest-supported row', 2, 8, 12, 'machine-plate', false, 'secondary'],
		['Rear-delt fly', 2, 12, 20, 'machine-stack', false, 'isolation'],
		['Preacher curl', 2, 8, 12, 'machine-stack', false, 'isolation'],
		['Dumbbell hammer curl', 2, 8, 12, 'dumbbell', false, 'isolation']
	],
	[
		['Conventional deadlift', 2, 4, 6, 'barbell', true, 'secondary'],
		['Pendulum squat', 2, 8, 12, 'machine-plate', true, 'secondary'],
		['Seated leg curl', 2, 10, 15, 'machine-stack', true, 'isolation'],
		['Glute kickback', 2, 10, 15, 'machine-stack', true, 'isolation'],
		['Seated calf raise', 3, 10, 15, 'machine-plate', true, 'isolation']
	],
	[
		['Pendulum squat', 3, 8, 12, 'machine-plate', true, 'secondary'],
		['Seated leg curl', 2, 10, 15, 'machine-stack', true, 'isolation'],
		['Glute kickback', 2, 10, 15, 'machine-stack', true, 'isolation'],
		['Leg extension', 2, 10, 15, 'machine-stack', true, 'isolation'],
		['Seated calf raise', 3, 10, 15, 'machine-plate', true, 'isolation']
	]
] as const;

const exercises = () => travelingPplDraft().days.flatMap((day) => day.exercises);

function exercise(name: string) {
	const result = exercises().find((entry) => entry.newExercise?.name === name);
	if (!result) throw new Error(`Missing exercise: ${name}`);
	return result;
}

describe('travelingPplDraft', () => {
	it('passes the shared creation validator with new definitions and compatible library references', () => {
		const draft = travelingPplDraft();
		expect(programDraftSchema.parse(draft)).toEqual(draft);
		const libraryDraft = travelingPplDraft([
			{
				id: '11111111-1111-4111-8111-111111111111',
				name: 'Pendulum squat',
				equipmentType: 'machine-plate',
				isLowerBody: true
			}
		]);
		expect(programDraftSchema.parse(libraryDraft)).toEqual(libraryDraft);
	});

	it('uses a rolling Push/Pull/one Legs rotation, not four mandatory consecutive days', () => {
		const draft = travelingPplDraft();
		expect(draft.name).toBe('Traveling PPL');
		expect(draft.days.map(({ name, alternateGroupId }) => [name, alternateGroupId])).toEqual([
			['Push', null],
			['Pull', null],
			['Legs A - Deadlift', 'legs'],
			['Legs B - Machines', 'legs']
		]);
		expect(draft.description).toMatch(/rolling.*push.*pull.*one legs/i);
		expect(draft.description).toMatch(/rest as needed/i);
	});

	it('contains exactly the approved ordered exercises and working prescriptions', () => {
		const draft = travelingPplDraft();
		expect(draft.days.map((day) => day.exercises.length)).toEqual([5, 6, 5, 5]);
		expect(
			draft.days.map((day) => day.exercises.reduce((n, row) => n + row.sets.length, 0))
		).toEqual([11, 12, 11, 12]);
		for (const [dayIndex, rows] of approved.entries()) {
			for (const [
				index,
				[name, count, min, max, equipmentType, isLowerBody, tier]
			] of rows.entries()) {
				const row = draft.days[dayIndex].exercises[index];
				expect(row.exerciseId).toBeNull();
				expect(row.newExercise).toEqual({ name, equipmentType, isLowerBody });
				expect(row.tier).toBe(tier);
				const longerRest = [
					'Standing strict barbell overhead press',
					'Conventional deadlift',
					'Pendulum squat'
				].includes(name);
				const policy =
					name === 'Conventional deadlift'
						? 'hold'
						: ['Standing strict barbell overhead press', 'Lateral raise'].includes(name)
							? 'cautious'
							: 'standard';
				expect(row.progressionPolicy).toBe(policy);
				expect(row.sets).toEqual(
					Array.from({ length: count }, () => ({
						setRole: 'working',
						targetMetric: 'reps',
						targetRepsMin: min,
						targetRepsMax: max,
						targetRir: 2,
						restSecondsMin: longerRest ? 120 : 90,
						restSecondsMax: longerRest ? 180 : 120,
						initialLoad: null,
						notes: null
					}))
				);
			}
		}
	});

	it('explains engine tier versus priority and keeps overhead warmups unweighted notes', () => {
		const press = exercise('Standing strict barbell overhead press');
		expect(press.notes).toMatch(/engine.*not.*priority/i);
		expect(press.notes).toMatch(/straight working sets/i);
		expect(press.notes).toMatch(/warm.?up.*bar.*intermediate.*ramp.*as needed/i);
		expect(press.notes).toMatch(/no assumed bar weight/i);
		expect(press.notes).not.toMatch(/\b(44|45|95)\b/);
		expect(exercise('Conventional deadlift').notes).toMatch(/engine.*not.*priority/i);
	});

	it('keeps all alternatives and optional additions in notes only', () => {
		const draft = travelingPplDraft();
		expect(draft.days[0].notes).toMatch(/optional.*second triceps.*1.?2.*10.?15/i);
		expect(draft.days[1].notes).toMatch(/optional.*abs.*2.*10.?15/i);
		expect(draft.days[1].notes).toMatch(/reverse.*first two/i);
		expect(draft.days[2].notes).toMatch(/optional.*leg extension.*if fresh/i);
		expect(draft.days[3].notes).toMatch(/RDL.*fallback.*not.*default/i);
		expect(exercise('Chest fly').notes).toMatch(/another press angle/i);
		expect(exercise('Triceps pushdown').notes).toMatch(/extension.*alternative/i);
		for (const day of draft.days.slice(2)) {
			expect(
				day.exercises.find((row) => row.newExercise?.name === 'Pendulum squat')?.notes
			).toMatch(/hack.*leg press.*alternative/i);
			expect(
				day.exercises.find((row) => row.newExercise?.name === 'Glute kickback')?.notes
			).toMatch(/per side if unilateral/i);
		}
		expect(
			exercises()
				.map((row) => row.newExercise?.name)
				.join(' ')
		).not.toMatch(/RDL|power row|abs|second triceps/i);
	});

	it('has no physical machine binding, manufacturer/model claim, or seeded loads', () => {
		const draft = travelingPplDraft();
		const serialized = JSON.stringify(draft);
		expect(serialized).not.toMatch(
			/gymEquipmentId|machineId|equipmentModel|manufacturer|loadConvention|currentLoad|Hammer Strength|Nautilus|Booty Blaster/i
		);
		for (const row of exercises()) {
			expect(Object.keys(row).sort()).toEqual([
				'exerciseId',
				'newExercise',
				'notes',
				'progressionPolicy',
				'sets',
				'tier'
			]);
			for (const set of row.sets) expect(set.initialLoad).toBeNull();
		}
	});

	it('reuses a compatible exact-name library entry in both Legs alternatives without changing it', () => {
		const definition = {
			id: '11111111-1111-4111-8111-111111111111',
			name: 'Pendulum squat',
			equipmentType: 'machine-plate',
			isLowerBody: true
		};
		const library = [definition];
		const before = structuredClone(library);
		const draft = travelingPplDraft(library);
		const rows = draft.days
			.flatMap((day) => day.exercises)
			.filter((row) => row.exerciseId === definition.id);
		expect(rows).toHaveLength(2);
		for (const row of rows) expect(row.newExercise).toBeNull();
		expect(rows.map((row) => row.sets.length)).toEqual([2, 3]);
		expect(library).toEqual(before);
	});

	it('does not select incompatible same-name equipment or lower-body metadata', () => {
		const library = [
			{
				id: '11111111-1111-4111-8111-111111111111',
				name: 'Pendulum squat',
				equipmentType: 'machine-stack',
				isLowerBody: true
			},
			{
				id: '22222222-2222-4222-8222-222222222222',
				name: 'Pendulum squat',
				equipmentType: 'machine-plate',
				isLowerBody: false
			}
		];
		const before = structuredClone(library);
		const draft = travelingPplDraft(library);
		expect(draft.days.flatMap((day) => day.exercises).every((row) => row.exerciseId === null)).toBe(
			true
		);
		expect(library).toEqual(before);
		expect(draft.days[2].exercises[1].newExercise).toEqual({
			name: 'Pendulum squat',
			equipmentType: 'machine-plate',
			isLowerBody: true
		});
	});

	it('selects a verified compatible match even after an incompatible duplicate', () => {
		const draft = travelingPplDraft([
			{
				id: '11111111-1111-4111-8111-111111111111',
				name: 'Pendulum squat',
				equipmentType: 'machine-stack',
				isLowerBody: true
			},
			{
				id: '22222222-2222-4222-8222-222222222222',
				name: 'Pendulum squat',
				equipmentType: 'machine-plate',
				isLowerBody: true
			}
		]);
		expect(draft.days[2].exercises[1].exerciseId).toBe('22222222-2222-4222-8222-222222222222');
		expect(draft.days[3].exercises[0].exerciseId).toBe('22222222-2222-4222-8222-222222222222');
	});

	it('does not fuzzy-match differently named library entries', () => {
		const draft = travelingPplDraft([
			{
				id: '11111111-1111-4111-8111-111111111111',
				name: 'pendulum squat',
				equipmentType: 'machine-plate',
				isLowerBody: true
			}
		]);
		expect(draft.days[2].exercises[1].exerciseId).toBeNull();
	});

	it('returns independent editable objects with consistent repeated definitions', () => {
		const draft = travelingPplDraft();
		const next = travelingPplDraft();
		const squatA = draft.days[2].exercises[1];
		const squatB = draft.days[3].exercises[0];
		expect(squatA.newExercise).toEqual(squatB.newExercise);
		expect(squatA.newExercise).not.toBe(squatB.newExercise);
		squatA.sets[0].initialLoad = 50;
		squatA.newExercise!.name = 'Edited squat';
		expect(squatA.sets[1].initialLoad).toBeNull();
		expect(squatB.sets[0].initialLoad).toBeNull();
		expect(squatB.newExercise?.name).toBe('Pendulum squat');
		expect(next.days[2].exercises[1].sets[0].initialLoad).toBeNull();
		expect(next.days[2].exercises[1].newExercise?.name).toBe('Pendulum squat');
	});
});
