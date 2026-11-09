/**
 * "+30 s" on a rest that has already run out (audit of main, 2026-11-08).
 * On a phone: glanced at between sets, so the line under the clock must match
 * the clock; "Rest finished" under a rest counting down again says the opposite.
 */
import { afterEach, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import RestTimer from './RestTimer.svelte';
import { workoutUi as ui } from './workout-ui';

const sessionId = 'sess-timer';
const restKey = `doclifts:rest:${sessionId}`;

afterEach(() => localStorage.clear());

it('+30 s on a finished rest runs 30 s from now and clears the finished line', async () => {
	// The shortest rest the settings offer, so it runs out during the test.
	localStorage.setItem('doclifts:timer:user-1', JSON.stringify({ duration: 5 }));
	render(RestTimer, { props: { sessionId, userId: 'user-1' } });
	await page.getByRole('button', { name: 'Start rest' }).click();
	await expect
		.poll(() => document.body.innerText.includes(ui.restFinished), { timeout: 9000 })
		.toBe(true);

	await page.getByRole('button', { name: ui.restAdd, exact: true }).click();
	expect(document.body.innerText.includes(ui.restFinished)).toBe(false);
	expect(document.body.innerText.includes(ui.restFinishedNoSound)).toBe(false);
	const clock = document.querySelector('[data-testid="rest-clock"]') as HTMLElement;
	expect(clock.innerText).toMatch(/^0:(30|29)$/);
	const stored = JSON.parse(localStorage.getItem(restKey) ?? 'null');
	expect(stored.seconds).toBe(ui.restAddSeconds);
	expect(Date.now() - stored.startedAt).toBeLessThan(5000);
});

it('closeSettings closes the settings panel (the page calls it when a sheet opens)', async () => {
	const screen = render(RestTimer, { props: { sessionId, userId: 'user-1' } });
	await page.getByRole('button', { name: 'Timer settings' }).click();
	await expect.element(page.getByRole('region', { name: 'Rest timer settings' })).toBeVisible();
	screen.component.closeSettings();
	await expect.poll(() => document.querySelector('.timer-settings')).toBeNull();
});
