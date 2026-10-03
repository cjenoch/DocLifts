import { beforeEach, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ProgramEditor from './ProgramEditor.svelte';
import { programDraftSchema, type ProgramDraft } from '$lib/program-draft';
import { STARTER_TEMPLATES } from '$lib/starter-templates';
import { editorUi as ui } from '$lib/editor-ui';

const library = [
	{
		id: '11111111-1111-4111-8111-111111111111',
		name: 'Test press',
		equipmentType: 'dumbbell',
		isLowerBody: false
	},
	{
		id: '44444444-4444-4444-8444-444444444444',
		name: 'Leg press',
		equipmentType: 'machine-plate',
		isLowerBody: true
	}
];
const set = () => ({
	setRole: 'working' as const,
	targetMetric: 'reps' as const,
	targetRepsMin: 8,
	targetRepsMax: 12,
	targetRir: 2,
	restSecondsMin: 90,
	restSecondsMax: 120,
	initialLoad: null,
	notes: null
});
const exercise = () => ({
	exerciseId: library[0].id,
	newExercise: null,
	tier: 'secondary' as const,
	progressionPolicy: 'standard' as const,
	notes: null,
	sets: [set()]
});
const data = (sourceProgramId: string | null = null, draft?: ProgramDraft) => ({
	library,
	requestId: '22222222-2222-4222-8222-222222222222',
	sourceProgramId,
	draft: draft ?? {
		name: 'Synthetic program',
		description: null,
		days: [{ name: 'Push', notes: null, alternateGroupId: null, exercises: [exercise()] }]
	}
});
const payload = () =>
	JSON.parse((document.querySelector('input[name="payload"]') as HTMLInputElement).value);

beforeEach(() => {
	sessionStorage.clear();
});

it('requires review before save and invalidates review after edits', async () => {
	const screen = render(ProgramEditor, { data: data() });
	await expect
		.element(screen.getByRole('button', { name: ui.save, exact: true }))
		.not.toBeInTheDocument();
	await screen.getByRole('button', { name: ui.review, exact: true }).click();
	await expect.element(screen.getByRole('heading', { name: 'Review program' })).toBeVisible();
	await expect.element(screen.getByRole('button', { name: ui.save, exact: true })).toBeVisible();
	await screen.getByRole('button', { name: ui.backToEditing }).click();
	await screen.getByLabelText(ui.programName, { exact: true }).fill('Revised draft');
	await expect
		.element(screen.getByRole('button', { name: ui.save, exact: true }))
		.not.toBeInTheDocument();
	expect(payload().name).toBe('Revised draft');
	expect((document.querySelector('input[name="requestId"]') as HTMLInputElement).value).toBe(
		data().requestId
	);
});

it('builds a two-day program on three screens, a standard exercise in four fields', async () => {
	const blank: ProgramDraft = {
		name: '',
		description: null,
		days: [
			{
				name: 'Day 1',
				notes: null,
				alternateGroupId: null,
				exercises: [{ ...exercise(), exerciseId: null }]
			}
		]
	};
	const screen = render(ProgramEditor, { data: data(null, blank) });
	// A new program starts with no exercise rows.
	expect(payload().days[0].exercises).toEqual([]);
	await screen.getByLabelText(ui.programName, { exact: true }).fill('Phone program');
	await screen.getByRole('button', { name: new RegExp(`^${ui.openDay('Day 1')}`) }).click();
	await screen.getByLabelText(ui.dayName(1), { exact: true }).fill('Legs');
	await screen.getByRole('button', { name: ui.addExercise, exact: true }).click();
	await screen
		.getByRole('dialog')
		.getByRole('button', { name: /^Leg press/ })
		.click();
	// The exercise screen: four fields, each rewriting every set.
	await screen.getByRole('button', { name: ui.more('sets'), exact: true }).click();
	await screen.getByLabelText(ui.repsMin, { exact: true }).fill('10');
	await screen.getByLabelText(ui.repsMax, { exact: true }).fill('15');
	await screen.getByRole('button', { name: ui.less('reps in reserve'), exact: true }).click();
	await screen.getByRole('button', { name: ui.restLong, exact: true }).click();
	await screen
		.getByRole('button', { name: ui.backToDay('Legs'), exact: true })
		.first()
		.click();
	await expect
		.element(screen.getByText('Leg press · 4 × 10–15 · RIR 1', { exact: true }))
		.toBeVisible();
	// A new exercise: equipment and lower body are asked only here.
	await screen.getByRole('button', { name: ui.addExercise, exact: true }).click();
	await screen.getByRole('searchbox', { name: ui.search }).fill('Goblet hold');
	await screen.getByRole('button', { name: ui.create('Goblet hold') }).click();
	await screen.getByRole('button', { name: ui.equipmentLabels.bodyweight, exact: true }).click();
	await screen.getByLabelText(ui.lowerBody).click();
	await screen.getByRole('button', { name: ui.use, exact: true }).click();
	await screen
		.getByRole('button', { name: ui.backToDay('Legs'), exact: true })
		.first()
		.click();
	await screen.getByRole('button', { name: ui.backToProgram, exact: true }).click();
	await screen.getByRole('button', { name: ui.addDay, exact: true }).click();
	await screen.getByLabelText(ui.dayName(2), { exact: true }).fill('Upper');
	await screen.getByRole('button', { name: ui.addExercise, exact: true }).click();
	await screen
		.getByRole('dialog')
		.getByRole('button', { name: /^Test press/ })
		.click();
	await screen
		.getByRole('button', { name: ui.backToDay('Upper'), exact: true })
		.first()
		.click();
	await screen.getByRole('button', { name: ui.backToProgram, exact: true }).click();
	await screen.getByRole('button', { name: ui.review, exact: true }).click();
	await expect.element(screen.getByRole('button', { name: ui.save, exact: true })).toBeVisible();
	const pattern = (count: number, min: number, max: number, rir: number, long: boolean) =>
		Array.from({ length: count }, () => ({
			...set(),
			targetRepsMin: min,
			targetRepsMax: max,
			targetRir: rir,
			restSecondsMin: long ? 120 : 90,
			restSecondsMax: long ? 180 : 120
		}));
	// Exactly the draft the old editor would have produced for the same program.
	expect(payload()).toEqual({
		name: 'Phone program',
		description: null,
		days: [
			{
				name: 'Legs',
				notes: null,
				alternateGroupId: null,
				exercises: [
					{ ...exercise(), exerciseId: library[1].id, sets: pattern(4, 10, 15, 1, true) },
					{
						...exercise(),
						exerciseId: null,
						newExercise: { name: 'Goblet hold', equipmentType: 'bodyweight', isLowerBody: true },
						sets: pattern(3, 8, 12, 2, false)
					}
				]
			},
			{
				name: 'Upper',
				notes: null,
				alternateGroupId: null,
				exercises: [{ ...exercise(), sets: pattern(3, 8, 12, 2, false) }]
			}
		]
	});
	expect(document.querySelectorAll('select')).toHaveLength(0);
});

it('builds a top set with backoffs and a warm-up under "Customize sets"', async () => {
	const screen = render(ProgramEditor, { data: data() });
	await screen.getByRole('button', { name: new RegExp(`^${ui.openDay('Push')}`) }).click();
	await screen.getByRole('button', { name: /^Test press/ }).click();
	await screen.getByText(ui.advanced).click();
	await screen.getByRole('button', { name: ui.tiers.main, exact: true }).click();
	// MAIN cannot be equal working sets: the sets open one by one, re-roled.
	await expect.element(screen.getByText(ui.customNote)).toBeVisible();
	await screen.getByRole('button', { name: ui.addSet, exact: true }).click();
	await screen.getByRole('button', { name: ui.addSet, exact: true }).click();
	await screen
		.getByRole('button', { name: `${ui.set(1)} ${ui.roles.warmup}`, exact: true })
		.click();
	await screen.getByRole('button', { name: `${ui.set(2)} ${ui.roles.top}`, exact: true }).click();
	await screen.getByLabelText(`${ui.set(1)} ${ui.initialLoad}`, { exact: true }).fill('45');
	await screen.getByLabelText(`${ui.set(3)} ${ui.targetMin}`, { exact: true }).fill('10');
	const sets = payload().days[0].exercises[0].sets;
	expect(sets.map((s: { setRole: string }) => s.setRole)).toEqual(['warmup', 'top', 'backoff']);
	expect(sets[0].initialLoad).toBe(45);
	expect(sets[2].targetRepsMin).toBe(10);
	expect(programDraftSchema.safeParse(payload()).success).toBe(true);
	await screen
		.getByRole('button', { name: ui.backToDay('Push'), exact: true })
		.first()
		.click();
	await expect
		.element(screen.getByText('Test press · 2 × 8–12 · top + backoffs · 1 warm-up'))
		.toBeVisible();
});

it('saves an unchanged draft with every feature exactly as it was given', async () => {
	const complex: ProgramDraft = {
		name: 'Everything',
		description: 'All the shapes',
		days: [
			{
				name: 'Legs A',
				notes: 'Choose A or B',
				alternateGroupId: 'legs',
				exercises: [
					{
						...exercise(),
						tier: 'main',
						progressionPolicy: 'hold',
						notes: 'Wave',
						sets: [
							{ ...set(), setRole: 'warmup', targetRir: null, initialLoad: 95, notes: 'Easy' },
							{
								...set(),
								setRole: 'top',
								targetRepsMin: 3,
								targetRepsMax: 5,
								restSecondsMin: 180,
								restSecondsMax: 300
							},
							{ ...set(), setRole: 'backoff', targetRir: 3 }
						]
					},
					{
						...exercise(),
						exerciseId: null,
						newExercise: { name: 'Hold', equipmentType: 'bodyweight', isLowerBody: false },
						tier: 'isolation',
						progressionPolicy: 'cautious',
						sets: [
							{
								...set(),
								targetMetric: 'seconds',
								targetRepsMin: 30,
								targetRepsMax: 60,
								targetRir: null,
								restSecondsMin: null,
								restSecondsMax: null
							}
						]
					}
				]
			},
			{
				name: 'Legs B',
				notes: null,
				alternateGroupId: 'legs',
				exercises: [{ ...exercise(), exerciseId: library[1].id }]
			}
		]
	};
	expect(programDraftSchema.parse(complex)).toEqual(complex);
	const screen = render(ProgramEditor, { data: data(library[0].id, complex) });
	// Opening every screen changes nothing.
	for (const [d, name] of [
		[0, 'Legs A'],
		[1, 'Legs B']
	] as const) {
		await screen.getByRole('button', { name: new RegExp(`^${ui.openDay(name)}`) }).click();
		for (let e = 0; e < complex.days[d].exercises.length; e++) {
			await screen.getByTestId('exercise-row').nth(e).getByRole('button').first().click();
			await screen
				.getByRole('button', { name: ui.backToDay(name), exact: true })
				.first()
				.click();
		}
		await screen.getByRole('button', { name: ui.backToProgram, exact: true }).click();
	}
	await screen.getByRole('button', { name: ui.review, exact: true }).click();
	await expect
		.element(screen.getByRole('button', { name: ui.saveVersion, exact: true }))
		.toBeVisible();
	expect(payload()).toEqual(complex);
});

it('keeps the draft and the screen through a reload, and per program', async () => {
	const first = render(ProgramEditor, { data: data() });
	await first.getByLabelText(ui.programName, { exact: true }).fill('Survives');
	await first.getByRole('button', { name: new RegExp(`^${ui.openDay('Push')}`) }).click();
	first.unmount();
	const again = render(ProgramEditor, { data: data() });
	await expect.element(again.getByRole('heading', { name: 'Push' })).toBeVisible();
	await again.getByRole('button', { name: ui.backToProgram, exact: true }).click();
	await expect
		.element(again.getByLabelText(ui.programName, { exact: true }))
		.toHaveValue('Survives');
	again.unmount();
	// Editing another program does not pick up this one's draft.
	const other = render(ProgramEditor, { data: data(library[0].id) });
	await expect
		.element(other.getByLabelText(ui.programName, { exact: true }))
		.toHaveValue('Synthetic program');
});

it('shows each problem on its screen, with a count on the level above', async () => {
	const bad = data();
	bad.draft.days[0].exercises[0].sets[0].targetRepsMin = 20;
	const screen = render(ProgramEditor, { data: bad });
	await screen.getByRole('button', { name: ui.review, exact: true }).click();
	await expect.element(screen.getByRole('alert')).toHaveTextContent(ui.fixFirst);
	await expect.element(screen.getByRole('alert')).toHaveTextContent(ui.problems(1));
	await expect
		.element(screen.getByRole('button', { name: ui.save, exact: true }))
		.not.toBeInTheDocument();
	await screen.getByRole('button', { name: new RegExp(`^${ui.openDay('Push')}`) }).click();
	await expect.element(screen.getByTestId('exercise-row')).toHaveTextContent(ui.problems(1));
	await screen.getByTestId('exercise-row').getByRole('button').first().click();
	await expect
		.element(screen.getByRole('alert'))
		.toHaveTextContent('Set 1 (targetRepsMax): Maximum target must be at least minimum target');
	// Fixing it clears the problem where it was.
	// Equal working sets, so the fix is in the four-field view.
	await screen.getByLabelText(ui.repsMin, { exact: true }).fill('8');
	// The phone's "Done": the four fields apply on leaving the field.
	(document.activeElement as HTMLElement).blur();
	await expect.element(screen.getByRole('alert')).not.toBeInTheDocument();
});

it('sets a day to alternate with another, and back to none', async () => {
	const two = data();
	two.draft.days.push({
		name: 'Pull',
		notes: null,
		alternateGroupId: null,
		exercises: [exercise()]
	});
	const screen = render(ProgramEditor, { data: two });
	await screen.getByRole('button', { name: new RegExp(`^${ui.openDay('Pull')}`) }).click();
	await screen.getByRole('button', { name: 'Push', exact: true }).click();
	const [a, b] = payload().days.map((d: { alternateGroupId: string | null }) => d.alternateGroupId);
	expect(a).toBeTruthy();
	expect(b).toBe(a);
	await screen.getByRole('button', { name: ui.noAlternate, exact: true }).click();
	expect(payload().days[1].alternateGroupId).toBeNull();
});

it('reorders and removes days, exercises and sets with buttons', async () => {
	const two = data();
	two.draft.days.push({
		name: 'Pull',
		notes: null,
		alternateGroupId: null,
		exercises: [exercise(), { ...exercise(), exerciseId: library[1].id }]
	});
	const screen = render(ProgramEditor, { data: two });
	await screen.getByRole('button', { name: ui.moveUp('day 2'), exact: true }).click();
	expect(payload().days.map((d: { name: string }) => d.name)).toEqual(['Pull', 'Push']);
	await screen.getByRole('button', { name: new RegExp(`^${ui.openDay('Pull')}`) }).click();
	await screen.getByRole('button', { name: ui.moveUp('Leg press'), exact: true }).click();
	expect(payload().days[0].exercises[0].exerciseId).toBe(library[1].id);
	await screen.getByRole('button', { name: ui.remove('Test press'), exact: true }).click();
	expect(payload().days[0].exercises).toHaveLength(1);
	await screen.getByRole('button', { name: ui.backToProgram, exact: true }).click();
	await screen.getByRole('button', { name: ui.remove('day 2'), exact: true }).click();
	expect(payload().days.map((d: { name: string }) => d.name)).toEqual(['Pull']);
});

it.each([null, library[0].id])(
	'keeps an oversized schema-valid draft editable and unsaveable (source %s)',
	async (sourceProgramId) => {
		const initial = data(sourceProgramId);
		const draft: ProgramDraft = {
			...initial.draft,
			days: [
				{
					...initial.draft.days[0],
					exercises: Array.from({ length: 2 }, () => ({
						...exercise(),
						sets: Array.from({ length: 25 }, (_, index) => ({
							...set(),
							notes: `${index}:` + 'x'.repeat(4997)
						}))
					}))
				}
			]
		};
		expect(programDraftSchema.safeParse(draft).success).toBe(true);
		expect(JSON.stringify(draft).length).toBeGreaterThan(250_000);
		const screen = render(ProgramEditor, { data: { ...initial, draft } });
		await screen.getByLabelText(ui.programName, { exact: true }).fill('  Keep all my edits  ');
		const beforeReview = payload();
		await screen.getByRole('button', { name: ui.review, exact: true }).click();
		await expect
			.element(screen.getByRole('alert'))
			.toHaveTextContent(/too large.*250,000 characters/i);
		await expect
			.element(screen.getByLabelText(ui.programName, { exact: true }))
			.toHaveValue('  Keep all my edits  ');
		await expect.element(screen.getByRole('button', { name: /^Save/ })).not.toBeInTheDocument();
		expect(payload()).toEqual(beforeReview);
		const form = document.querySelector('form')!;
		expect(form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))).toBe(
			false
		);
		// Reducing the draft makes review and save available again.
		await screen.getByRole('button', { name: new RegExp(`^${ui.openDay('Push')}`) }).click();
		await screen
			.getByRole('button', { name: ui.remove('Test press'), exact: true })
			.first()
			.click();
		await screen.getByRole('button', { name: ui.backToProgram, exact: true }).click();
		await screen.getByRole('button', { name: ui.review, exact: true }).click();
		await expect
			.element(
				screen.getByRole('button', {
					name: sourceProgramId ? ui.saveVersion : ui.save,
					exact: true
				})
			)
			.toBeVisible();
	}
);

it('keeps Unicode set notes below the JSON cap but above the form cap editable', async () => {
	const initial = data();
	const draft: ProgramDraft = structuredClone(initial.draft);
	draft.days[0].exercises[0].sets = Array.from({ length: 12 }, () => ({
		...set(),
		notes: '界'.repeat(5000)
	}));
	expect(JSON.stringify(draft).length).toBeLessThan(250_000);
	const currentRequestId = '33333333-3333-4333-8333-333333333333';
	const screen = render(ProgramEditor, {
		data: { ...initial, draft },
		form: { requestId: currentRequestId }
	});
	const form = document.querySelector('form')!;
	const values = new FormData(form);
	expect(Array.from(values.keys())).toEqual(['payload', 'requestId']);
	expect(values.get('requestId')).toBe(currentRequestId);
	await screen.getByRole('button', { name: ui.review, exact: true }).click();
	await expect.element(screen.getByRole('alert')).toHaveTextContent(/too large.*500,000 bytes/i);
	expect(form.acceptCharset).toBe('UTF-8');
	await screen.getByRole('button', { name: new RegExp(`^${ui.openDay('Push')}`) }).click();
	await screen.getByRole('button', { name: /^Test press/ }).click();
	await expect
		.element(screen.getByLabelText(`${ui.set(1)} ${ui.setNotes}`, { exact: true }))
		.toHaveValue('界'.repeat(5000));
	await screen.getByRole('button', { name: ui.remove('set 12'), exact: true }).click();
	await screen
		.getByRole('button', { name: ui.backToDay('Push'), exact: true })
		.first()
		.click();
	await screen.getByRole('button', { name: ui.backToProgram, exact: true }).click();
	await screen.getByRole('button', { name: ui.review, exact: true }).click();
	await expect.element(screen.getByRole('button', { name: /^Save/ })).toBeVisible();
});

it('offers Start blank and every starter template as an unsaved draft', async () => {
	const screen = render(ProgramEditor, { data: data() });
	for (const template of STARTER_TEMPLATES) {
		await screen.getByRole('button', { name: ui.useTemplate(template.label), exact: true }).click();
		await expect
			.element(screen.getByLabelText(ui.programName, { exact: true }))
			.toHaveValue(template.label);
		expect(payload().days).toHaveLength(template.build([]).days.length);
	}
	await screen.getByRole('button', { name: ui.startBlank, exact: true }).click();
	expect(payload()).toEqual({
		name: '',
		description: null,
		days: [{ name: 'Day 1', notes: null, alternateGroupId: null, exercises: [] }]
	});
	await expect
		.element(screen.getByRole('button', { name: ui.save, exact: true }))
		.not.toBeInTheDocument();
});

it('preserves submitted values and labels duplicate-on-edit explicitly', async () => {
	const initial = data(library[0].id);
	const submitted = { ...initial.draft, name: 'Keep submitted name' };
	const screen = render(ProgramEditor, {
		data: initial,
		form: { error: 'Please fix the draft', draft: submitted, requestId: initial.requestId }
	});
	await expect.element(screen.getByRole('alert')).toHaveTextContent('Please fix the draft');
	await expect
		.element(screen.getByLabelText(ui.programName, { exact: true }))
		.toHaveValue('Keep submitted name');
	// Editing a program offers no starting points.
	await expect
		.element(screen.getByRole('button', { name: ui.startBlank, exact: true }))
		.not.toBeInTheDocument();
	await screen.getByRole('button', { name: ui.review, exact: true }).click();
	await expect
		.element(screen.getByRole('button', { name: ui.saveVersion, exact: true }))
		.toBeVisible();
	await expect.element(screen.getByText(ui.editNote, { exact: true })).toBeVisible();
});

it.each([
	{ newExercise: 'invalid quick-add' },
	{ newExercise: 42 },
	{ newExercise: ['not an exercise'] }
])(
	'recovers malformed quick-add $newExercise from a failed POST without crashing',
	async ({ newExercise }) => {
		const initial = data();
		const screen = render(ProgramEditor, {
			data: initial,
			form: {
				error: 'Please fix the draft',
				draft: {
					...initial.draft,
					days: [{ ...initial.draft.days[0], exercises: [{ ...exercise(), newExercise }] }]
				}
			}
		});
		await expect.element(screen.getByRole('alert')).toHaveTextContent('Please fix the draft');
		expect(payload().days[0].exercises[0].newExercise).toBeNull();
		await screen.getByLabelText(ui.programName, { exact: true }).fill('Recovered program');
		await screen.getByRole('button', { name: ui.review, exact: true }).click();
		await expect.element(screen.getByRole('heading', { name: 'Review program' })).toBeVisible();
		expect(payload().name).toBe('Recovered program');
	}
);

it('recovers malformed nested rows independently while preserving valid quick-add values', async () => {
	const initial = data();
	const screen = render(ProgramEditor, {
		data: initial,
		form: {
			error: 'Please fix the draft',
			draft: {
				...initial.draft,
				days: [
					{ name: 'First', exercises: null },
					{ name: 'Second', exercises: false },
					{
						name: 'Third',
						exercises: [
							{
								...exercise(),
								exerciseId: null,
								newExercise: { name: 'Keep hold', equipmentType: 'bodyweight', isLowerBody: false },
								sets: [null, { ...set(), targetRepsMin: 20, notes: 'Keep notes' }]
							}
						]
					}
				]
			}
		}
	});
	expect(payload().days[2].exercises[0]).toMatchObject({
		newExercise: { name: 'Keep hold', equipmentType: 'bodyweight', isLowerBody: false },
		sets: [set(), { ...set(), targetRepsMin: 20, notes: 'Keep notes' }]
	});
	await screen.getByRole('button', { name: ui.review, exact: true }).click();
	await expect.element(screen.getByRole('alert')).toHaveTextContent(ui.fixFirst);
	await expect
		.element(screen.getByRole('button', { name: ui.save, exact: true }))
		.not.toBeInTheDocument();
	await screen.getByRole('button', { name: new RegExp(`^${ui.openDay('Third')}`) }).click();
	await screen.getByRole('button', { name: /^Keep hold/ }).click();
	await expect
		.element(screen.getByRole('alert'))
		.toHaveTextContent('Maximum target must be at least minimum target');
});
