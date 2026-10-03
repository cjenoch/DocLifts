import { beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import SetRow from './SetRow.svelte';
import { workoutUi as ui } from '$lib/workout-ui';

const baseSet = {
	id: 'set-1',
	exerciseId: 'ex-1',
	exerciseName: 'Bench Press',
	position: 1,
	setRole: 'top',
	targetMetric: 'reps',
	prescribedLoad: 100,
	prescribedRepsMin: 3,
	prescribedRepsMax: 5,
	prescribedRir: 1,
	suggestionReasoning: '+5: top set hit 5 reps at RIR 1',
	executedLoad: null,
	executedReps: null,
	executedRir: null,
	notes: null,
	history: {
		executedLoad: 95,
		executedReps: 5,
		executedRir: 1,
		prescribedRepsMax: 5,
		prescribedRir: 1,
		endedAt: new Date('2026-05-29T12:00:00.000Z')
	}
};

function renderSetRow(props: Record<string, unknown>) {
	// ondirty was added by the inline-sets refactor and is required in every
	// render path; default it to a recording stub so tests exercise the real
	// dirtiness contract. Override by passing ondirty in props when asserted.
	const onDirty = props.ondirty ?? (() => {});
	return render(SetRow as unknown as never, {
		props: { ondirty: onDirty, ...props } as never
	});
}

beforeEach(() => {
	// Every test uses set-1, so one test's kept draft would reach the next.
	sessionStorage.clear();
});

describe('SetRow component', () => {
	it('keeps the captured identity with unsaved inputs after another row invalidates the page', async () => {
		const props = {
			set: { ...baseSet, gymEquipmentId: 'machine-a', loadConvention: 'total_plates' },
			sessionEnded: false,
			allowEndedSessionEdit: false,
			rowError: null,
			rowMessage: null
		};
		const view = renderSetRow(props);
		await view.rerender({
			set: { ...props.set, gymEquipmentId: 'machine-b', prescribedLoad: 200 }
		} as never);
		expect(document.querySelector<HTMLInputElement>('input[name="expectedIdentity"]')?.value).toBe(
			'machine-a:total_plates'
		);
	});
	it('renders prescribed and history row details', async () => {
		renderSetRow({
			set: baseSet,
			sessionEnded: false,
			allowEndedSessionEdit: false,
			rowError: null,
			rowMessage: null
		});

		await expect.element(page.getByText('Target: 100 × 3–5 · 1 RIR')).toBeInTheDocument();
		await expect.element(page.getByText('Last: 95 × 5 · 1 RIR')).toBeInTheDocument();
		await expect.element(page.getByText('+5: top set hit 5 reps at RIR 1')).toBeInTheDocument();
		await expect.element(page.getByRole('button', { name: 'Save' })).toBeInTheDocument();
	});

	it('hides editable inputs for ended sessions unless edit mode is enabled', async () => {
		renderSetRow({
			set: {
				...baseSet,
				executedLoad: 100,
				executedReps: 5,
				executedRir: 1,
				notes: 'felt solid'
			},
			sessionEnded: true,
			allowEndedSessionEdit: false,
			rowError: null,
			rowMessage: null
		});

		await expect.element(page.getByText('100 × 5 · 1 RIR')).toBeInTheDocument();
		await expect.element(page.getByText('felt solid')).toBeInTheDocument();
		await expect.element(page.getByRole('button', { name: 'Save' })).not.toBeInTheDocument();
	});

	const live = (set: Record<string, unknown>) =>
		renderSetRow({
			set: {
				...baseSet,
				gymEquipmentId: null,
				loadConvention: 'legacy',
				incrementLb: null,
				...set
			},
			sessionEnded: false,
			allowEndedSessionEdit: false
		});
	const field = (name: string) =>
		document.querySelector<HTMLInputElement>(`input[name="${name}"]`)!.value;
	const submitted = () =>
		Object.fromEntries(new FormData(document.querySelector('form')!)) as Record<string, string>;

	it('one tap: the prefilled weight and the bottom of the rep range are what the check saves', async () => {
		live({});
		expect(field('executedLoad')).toBe('100');
		expect(field('executedReps')).toBe('3');
		// Shown numbers are not an edit: the row is Ready, and the check posts them.
		await expect.element(page.getByText('Ready', { exact: true })).toBeInTheDocument();
		const save = page.getByRole('button', { name: ui.saveSet(1), exact: true });
		await expect.element(save).toHaveTextContent('✓');
		expect((save.element() as HTMLButtonElement).type).toBe('submit');
		expect(submitted()).toMatchObject({ executedLoad: '100', executedReps: '3', executedRir: '' });
	});

	it('a logged set shows what was logged, not the prefill', async () => {
		live({ executedLoad: 105, executedReps: 5, executedRir: 1 });
		expect(field('executedLoad')).toBe('105');
		expect(field('executedReps')).toBe('5');
		await expect.element(page.getByText('✓ Saved', { exact: true })).toBeInTheDocument();
	});

	it.each([
		['the machine increment', { incrementLb: 10, loadConvention: 'displayed' }, '110', '90'],
		['per-side plates without one', { loadConvention: 'plates_per_side' }, '102.5', '97.5'],
		['the default', { loadConvention: 'displayed' }, '105', '95']
	])('weight steps by %s, with no keyboard', async (_, set, up, down) => {
		live(set);
		await page.getByRole('button', { name: ui.moreWeight, exact: true }).click();
		expect(field('executedLoad')).toBe(up);
		await page.getByRole('button', { name: ui.lessWeight, exact: true }).click();
		await page.getByRole('button', { name: ui.lessWeight, exact: true }).click();
		expect(field('executedLoad')).toBe(down);
		expect(document.activeElement?.tagName).not.toBe('INPUT');
		await expect.element(page.getByText('Unsaved', { exact: true })).toBeInTheDocument();
	});

	it('reps step by one, seconds by five, and never below zero', async () => {
		live({ prescribedRepsMin: 1, prescribedRepsMax: 1 });
		await page.getByRole('button', { name: ui.moreReps(false), exact: true }).click();
		expect(field('executedReps')).toBe('2');
		for (let i = 0; i < 4; i++)
			await page.getByRole('button', { name: ui.lessReps(false), exact: true }).click();
		expect(field('executedReps')).toBe('0');
	});

	it('a timed set steps its seconds', async () => {
		live({ targetMetric: 'seconds', prescribedRepsMin: 30, prescribedRepsMax: 60 });
		expect(field('executedReps')).toBe('30');
		await page.getByRole('button', { name: ui.moreReps(true), exact: true }).click();
		expect(field('executedReps')).toBe('35');
		await expect
			.element(page.getByRole('spinbutton', { name: 'Seconds', exact: true }))
			.toBeInTheDocument();
	});

	it('RIR stays, optional and empty until typed', async () => {
		live({});
		const rir = page.getByRole('spinbutton', { name: 'RIR' });
		await expect.element(rir).toHaveValue(null);
		await rir.fill('2');
		expect(submitted().executedRir).toBe('2');
	});
});
