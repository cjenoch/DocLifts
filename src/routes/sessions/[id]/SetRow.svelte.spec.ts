import { describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import SetRow from './SetRow.svelte';

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
	return render(SetRow as unknown as never, { props } as never);
}

describe('SetRow component', () => {
	it('renders prescribed and history row details', async () => {
		renderSetRow({
			set: baseSet,
			sessionEnded: false,
			allowEndedSessionEdit: false,
			rowError: null,
			rowMessage: null
		});

		await expect.element(page.getByText('TOP', { exact: true })).toBeInTheDocument();
		await expect.element(page.getByText('Last: 95 × 5 @ RIR 1')).toBeInTheDocument();
		await expect
			.element(page.getByText('Suggested: +5: top set hit 5 reps at RIR 1'))
			.toBeInTheDocument();
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

		await expect.element(page.getByText('Executed')).toBeInTheDocument();
		await expect.element(page.getByText('felt solid')).toBeInTheDocument();
		await expect.element(page.getByRole('button', { name: 'Save' })).not.toBeInTheDocument();
	});
});
