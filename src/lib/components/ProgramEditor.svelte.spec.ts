import { expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ProgramEditor from './ProgramEditor.svelte';
import { programDraftSchema, type ProgramDraft } from '$lib/program-draft';

const library = [
	{
		id: '11111111-1111-4111-8111-111111111111',
		name: 'Test press',
		equipmentType: 'dumbbell',
		isLowerBody: false
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
const data = (sourceProgramId: string | null = null) => ({
	library,
	requestId: '22222222-2222-4222-8222-222222222222',
	sourceProgramId,
	draft: {
		name: 'Synthetic program',
		description: null,
		days: [{ name: 'Push', notes: null, alternateGroupId: null, exercises: [exercise()] }]
	}
});
const payload = () =>
	JSON.parse((document.querySelector('input[name="payload"]') as HTMLInputElement).value);

it('requires review before save and invalidates review after edits', async () => {
	const screen = render(ProgramEditor, { data: data() });
	await expect
		.element(screen.getByRole('button', { name: 'Save program', exact: true }))
		.not.toBeInTheDocument();
	await screen.getByRole('button', { name: 'Review program', exact: true }).click();
	await expect.element(screen.getByRole('heading', { name: 'Review program' })).toBeVisible();
	await expect
		.element(screen.getByRole('button', { name: 'Save program', exact: true }))
		.toBeVisible();
	await screen.getByRole('button', { name: 'Back to editing' }).click();
	await screen.getByLabelText('Program name', { exact: true }).fill('Revised draft');
	await expect
		.element(screen.getByRole('button', { name: 'Save program', exact: true }))
		.not.toBeInTheDocument();
	expect(payload().name).toBe('Revised draft');
	expect((document.querySelector('input[name="requestId"]') as HTMLInputElement).value).toBe(
		data().requestId
	);
});

it('adds, reorders and removes only draft days, exercises and sets', async () => {
	const screen = render(ProgramEditor, { data: data() });
	await screen.getByRole('button', { name: 'Add day', exact: true }).click();
	await screen.getByLabelText('Day 2 name', { exact: true }).fill('Pull');
	await screen.getByRole('button', { name: 'Move day 2 up', exact: true }).click();
	expect(payload().days.map((d: { name: string }) => d.name)).toEqual(['Pull', 'Push']);
	await screen.getByRole('button', { name: 'Remove draft day 1', exact: true }).click();
	await screen.getByRole('button', { name: 'Add exercise to day 1', exact: true }).click();
	await screen
		.getByLabelText('Day 1 exercise 2 library exercise', { exact: true })
		.selectOptions(library[0].id);
	await screen.getByLabelText('Day 1 exercise 2 notes', { exact: true }).fill('Second movement');
	await screen.getByRole('button', { name: 'Move day 1 exercise 2 up', exact: true }).click();
	expect(payload().days[0].exercises[0].notes).toBe('Second movement');
	await screen.getByRole('button', { name: 'Remove draft day 1 exercise 2', exact: true }).click();
	await screen.getByRole('button', { name: 'Add set to day 1 exercise 1', exact: true }).click();
	await screen.getByLabelText('Day 1 exercise 1 set 2 minimum target', { exact: true }).fill('10');
	await screen.getByRole('button', { name: 'Move day 1 exercise 1 set 2 up', exact: true }).click();
	expect(payload().days[0].exercises[0].sets[0].targetRepsMin).toBe(10);
	await screen
		.getByRole('button', { name: 'Remove draft day 1 exercise 1 set 2', exact: true })
		.click();
	expect(payload().days[0].exercises[0].sets).toHaveLength(1);
});

it('supports quick-add metadata and seconds targets without a machine default', async () => {
	const screen = render(ProgramEditor, { data: data() });
	await screen
		.getByLabelText('Day 1 exercise 1 library exercise', { exact: true })
		.selectOptions('new');
	await screen
		.getByLabelText('Day 1 exercise 1 new exercise name', { exact: true })
		.fill('Synthetic hold');
	await screen
		.getByLabelText('Day 1 exercise 1 equipment type', { exact: true })
		.selectOptions('bodyweight');
	await screen.getByLabelText('Day 1 exercise 1 lower body', { exact: true }).selectOptions('true');
	await screen
		.getByLabelText('Day 1 exercise 1 set 1 target metric', { exact: true })
		.selectOptions('seconds');
	await screen.getByLabelText('Day 1 exercise 1 set 1 initial load', { exact: true }).fill('0');
	const ex = payload().days[0].exercises[0];
	expect(ex.exerciseId).toBeNull();
	expect(ex.newExercise).toEqual({
		name: 'Synthetic hold',
		equipmentType: 'bodyweight',
		isLowerBody: true
	});
	expect(ex.sets[0].targetMetric).toBe('seconds');
	expect(ex.sets[0].initialLoad).toBe(0);
	expect(ex).not.toHaveProperty('gymEquipmentId');
});

it('shows invalid nested prescription errors before allowing review', async () => {
	const screen = render(ProgramEditor, { data: data() });
	await screen.getByLabelText('Day 1 exercise 1 set 1 minimum target', { exact: true }).fill('20');
	await screen.getByRole('button', { name: 'Review program', exact: true }).click();
	await expect.element(screen.getByRole('alert')).toBeVisible();
	await expect
		.element(screen.getByRole('button', { name: 'Save program', exact: true }))
		.not.toBeInTheDocument();
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
		await screen.getByLabelText('Program name', { exact: true }).fill('  Keep all my edits  ');
		const beforeReview = payload();
		await screen.getByRole('button', { name: 'Review program', exact: true }).click();
		await expect
			.element(screen.getByRole('alert'))
			.toHaveTextContent(/too large.*250,000 characters/i);
		await expect
			.element(screen.getByLabelText('Program name', { exact: true }))
			.toHaveValue('  Keep all my edits  ');
		await expect
			.element(screen.getByRole('heading', { name: 'Review program' }))
			.not.toBeInTheDocument();
		await expect.element(screen.getByRole('button', { name: /^Save/ })).not.toBeInTheDocument();
		expect(payload()).toEqual(beforeReview);
		const form = document.querySelector('form')!;
		expect(form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))).toBe(
			false
		);
		expect((document.querySelector('input[name="requestId"]') as HTMLInputElement).value).toBe(
			initial.requestId
		);
		// Reducing the draft clears the error and makes review/save available again.
		await screen
			.getByRole('button', { name: 'Remove draft day 1 exercise 2', exact: true })
			.click();
		await screen.getByRole('button', { name: 'Review program', exact: true }).click();
		await expect
			.element(
				screen.getByRole('button', {
					name: sourceProgramId ? 'Save as new version' : 'Save program',
					exact: true
				})
			)
			.toBeVisible();
	}
);

it.each([null, library[0].id])(
	'keeps Unicode notes below the JSON cap but above the form cap editable (source %s)',
	async (sourceProgramId) => {
		const initial = data(sourceProgramId);
		const draft: ProgramDraft = structuredClone(initial.draft);
		draft.days[0].exercises[0].sets = Array.from({ length: 12 }, () => ({
			...set(),
			notes: '界'.repeat(5000)
		}));
		expect(programDraftSchema.safeParse(draft).success).toBe(true);
		expect(JSON.stringify(draft).length).toBeLessThan(250_000);
		const currentRequestId = '33333333-3333-4333-8333-333333333333';
		const screen = render(ProgramEditor, {
			data: { ...initial, draft },
			form: { requestId: currentRequestId }
		});
		await screen.getByLabelText('Program name', { exact: true }).fill('  Keep Unicode edits  ');
		const beforeReview = payload();
		const form = document.querySelector('form')!;
		const values = new FormData(form);
		expect(Array.from(values.keys())).toEqual(['payload', 'requestId']);
		expect(values.get('requestId')).toBe(currentRequestId);
		const encoded = new URLSearchParams(values as unknown as Record<string, string>).toString();
		expect(new TextEncoder().encode(encoded).byteLength).toBeGreaterThan(512 * 1024);
		await screen.getByRole('button', { name: 'Review program', exact: true }).click();
		await expect.element(screen.getByRole('alert')).toHaveTextContent(/too large.*500,000 bytes/i);
		await expect
			.element(screen.getByLabelText('Program name', { exact: true }))
			.toHaveValue('  Keep Unicode edits  ');
		await expect
			.element(screen.getByLabelText('Day 1 exercise 1 set 1 notes', { exact: true }))
			.toHaveValue('界'.repeat(5000));
		await expect
			.element(screen.getByRole('heading', { name: 'Review program' }))
			.not.toBeInTheDocument();
		await expect.element(screen.getByRole('button', { name: /^Save/ })).not.toBeInTheDocument();
		expect(payload()).toEqual(beforeReview);
		expect(form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))).toBe(
			false
		);
		expect(form.acceptCharset).toBe('UTF-8');
		await screen
			.getByRole('button', { name: 'Remove draft day 1 exercise 1 set 12', exact: true })
			.click();
		await screen.getByRole('button', { name: 'Review program', exact: true }).click();
		await expect.element(screen.getByRole('button', { name: /^Save/ })).toBeVisible();
	}
);

it('loads Traveling PPL as an editable unsaved draft', async () => {
	const screen = render(ProgramEditor, { data: data() });
	await screen.getByRole('button', { name: 'Use Traveling PPL preset', exact: true }).click();
	await expect
		.element(screen.getByLabelText('Program name', { exact: true }))
		.toHaveValue('Traveling PPL');
	expect(payload().days).toHaveLength(4);
	await expect
		.element(screen.getByRole('button', { name: 'Save program', exact: true }))
		.not.toBeInTheDocument();
	await expect.element(screen.getByText(/SECONDARY.*engine semantics/)).toBeVisible();
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
		.element(screen.getByLabelText('Program name', { exact: true }))
		.toHaveValue('Keep submitted name');
	await screen.getByRole('button', { name: 'Review program', exact: true }).click();
	await expect
		.element(screen.getByRole('button', { name: 'Save as new version', exact: true }))
		.toBeVisible();
	const versionMessage =
		'Saving creates a new version and archives this source program. Past workouts stay unchanged.';
	await expect.element(screen.getByText(versionMessage, { exact: true })).toBeVisible();
});

it('gives every dynamic select an exact accessible label', async () => {
	const initial = data();
	const submitted = structuredClone(initial.draft);
	const screen = render(ProgramEditor, {
		data: initial,
		form: {
			draft: {
				...submitted,
				days: [
					{
						...submitted.days[0],
						exercises: [
							{
								...exercise(),
								exerciseId: null,
								newExercise: {
									name: 'Synthetic squat',
									equipmentType: 'bodyweight',
									isLowerBody: true
								}
							}
						]
					}
				]
			}
		}
	});
	for (const label of [
		'library exercise',
		'equipment type',
		'lower body',
		'tier',
		'progression policy',
		'set 1 role',
		'set 1 target metric'
	]) {
		await expect
			.element(
				screen.getByRole('combobox', {
					name: `Day 1 exercise 1 ${label}`,
					exact: true
				})
			)
			.toBeVisible();
	}
	await screen.getByLabelText('Day 1 exercise 1 tier', { exact: true }).selectOptions('main');
	await screen
		.getByLabelText('Day 1 exercise 1 progression policy', { exact: true })
		.selectOptions('hold');
	await screen.getByLabelText('Day 1 exercise 1 set 1 role', { exact: true }).selectOptions('top');
	expect(payload().days[0].exercises[0]).toMatchObject({
		tier: 'main',
		progressionPolicy: 'hold',
		sets: [{ setRole: 'top' }]
	});
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
		await screen.getByLabelText('Program name', { exact: true }).fill('Recovered program');
		await screen.getByRole('button', { name: 'Review program', exact: true }).click();
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
	await screen.getByLabelText('Day 1 exercise 1 notes', { exact: true }).fill('Only first');
	expect(payload().days[1].exercises[0].notes).toBeNull();
	expect(payload().days[2].exercises[0]).toMatchObject({
		newExercise: { name: 'Keep hold', equipmentType: 'bodyweight', isLowerBody: false },
		sets: [set(), { ...set(), targetRepsMin: 20, notes: 'Keep notes' }]
	});
	await screen.getByRole('button', { name: 'Review program', exact: true }).click();
	await expect
		.element(screen.getByRole('alert'))
		.toHaveTextContent('Maximum target must be at least minimum target');
	await expect
		.element(screen.getByRole('button', { name: 'Save program', exact: true }))
		.not.toBeInTheDocument();
});
