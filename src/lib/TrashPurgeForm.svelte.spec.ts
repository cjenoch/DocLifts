/**
 * The typed PURGE confirmation (owner decision + audit finding, 2026-09-26;
 * audit of main, 2026-11-08). On a phone: "Empty Trash" is one thumb tap away
 * from History's list, so after a Cancel the second attempt must ask for the
 * word again, or the ceremony is one tap.
 */
import { expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import TrashPurgeForm from './TrashPurgeForm.svelte';

it('Cancel forgets what was typed; reopening asks for PURGE again', async () => {
	render(TrashPurgeForm, {
		props: { action: '?/purge', expectedCount: 2, confirmation: 'Delete 2 workouts for good?' }
	});
	await page.getByRole('button', { name: 'Empty Trash (2)' }).click();
	const input = page.getByLabelText('Type PURGE to confirm');
	await input.fill('PURGE');
	await expect.element(page.getByRole('button', { name: 'Permanently delete' })).not.toBeDisabled();
	await page.getByRole('button', { name: 'Cancel' }).click();

	await page.getByRole('button', { name: 'Empty Trash (2)' }).click();
	await expect.element(input).toHaveValue('');
	await expect.element(page.getByRole('button', { name: 'Permanently delete' })).toBeDisabled();
});
