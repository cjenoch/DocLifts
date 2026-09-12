import { expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import MachinePicker from './MachinePicker.svelte';

it('offers explicit gym, machine and convention selection without guessing a model', async () => {
	const screen = render(MachinePicker, {
		gyms: [
			{ id: 'gym-a', name: 'Gym A' },
			{ id: 'gym-b', name: 'Gym B' }
		],
		machines: [
			{
				id: 'machine-a',
				gymId: 'gym-a',
				localLabel: 'Unknown press',
				equipmentType: 'machine-plate'
			},
			{ id: 'machine-b', gymId: 'gym-b', localLabel: 'Other press', equipmentType: 'machine-plate' }
		]
	});
	await expect.element(screen.getByLabelText('Gym', { exact: true })).toBeVisible();
	await screen.getByLabelText('Gym', { exact: true }).selectOptions('gym-a');
	await expect.element(screen.getByRole('option', { name: 'Unknown press' })).toBeInTheDocument();
	await expect.element(screen.getByRole('option', { name: 'Other press' })).not.toBeInTheDocument();
	await expect.element(screen.getByLabelText('Load convention')).toBeVisible();
	await expect
		.element(screen.getByText('Starting resistance is descriptive; no automatic conversion.'))
		.toBeVisible();
});
