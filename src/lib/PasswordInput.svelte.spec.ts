import { expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import PasswordInput from './PasswordInput.svelte';

// Spec §2 item 2: "Test: toggle flips `type`."

it('starts masked, and the toggle flips type to text and back', async () => {
	const screen = render(PasswordInput, { id: 'pw', label: 'Password', name: 'password' });
	const input = screen.getByLabelText('Password', { exact: true });
	await expect.element(input).toHaveAttribute('type', 'password');

	await screen.getByRole('button', { name: 'Show password' }).click();
	await expect.element(input).toHaveAttribute('type', 'text');
	await expect
		.element(screen.getByRole('button', { name: 'Hide password' }))
		.toHaveAttribute('aria-pressed', 'true');

	await screen.getByRole('button', { name: 'Hide password' }).click();
	await expect.element(input).toHaveAttribute('type', 'password');
	await expect
		.element(screen.getByRole('button', { name: 'Show password' }))
		.toHaveAttribute('aria-pressed', 'false');
});

it('keeps what was typed across a toggle, and still submits under its name', async () => {
	const screen = render(PasswordInput, {
		id: 'cur',
		label: 'Current password',
		name: 'currentPassword',
		autocomplete: 'current-password'
	});
	const input = screen.getByLabelText('Current password', { exact: true });
	await input.fill('P@ss with spaces ');

	await screen.getByRole('button', { name: 'Show current password' }).click();
	await expect.element(input).toHaveValue('P@ss with spaces ');
	await expect.element(input).toHaveAttribute('name', 'currentPassword');
	await expect.element(input).toHaveAttribute('autocomplete', 'current-password');
});

it('is a button, not a submit: toggling never posts the form', async () => {
	const screen = render(PasswordInput, { id: 'x', label: 'Password', name: 'password' });
	await expect
		.element(screen.getByRole('button', { name: 'Show password' }))
		.toHaveAttribute('type', 'button');
});

it('never lets the phone capitalize or autocorrect what is typed, masked or shown', async () => {
	// 2026-10-01: the owner changed his password on an iPhone with Show on, and
	// the password he then typed to sign in did not match the one stored. A
	// shown password is a plain text field, and without these iOS capitalizes
	// the first letter and autocorrects words — identically in both "new
	// password" boxes, so the match check passes and a different password is
	// saved.
	const screen = render(PasswordInput, { id: 'np', label: 'New password', name: 'newPassword' });
	const input = screen.getByLabelText('New password', { exact: true });
	for (const toggle of [null, 'Show new password']) {
		if (toggle) await screen.getByRole('button', { name: toggle }).click();
		await expect.element(input).toHaveAttribute('autocapitalize', 'none');
		await expect.element(input).toHaveAttribute('autocorrect', 'off');
		await expect.element(input).toHaveAttribute('spellcheck', 'false');
	}
	await expect.element(input).toHaveAttribute('type', 'text');
});
