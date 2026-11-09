/**
 * The add sheet's ways out and its half-made choices (audit of main, 2026-11-08).
 * On a phone: a full-screen sheet worked one-handed between sets, so every step
 * needs a way back that keeps what was chosen, a stale choice must never be
 * added by the next tap, and a hurried double tap adds one exercise, not two.
 * (Escape is the keyboard and assistive-tech path to the same close button.)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import AddSheet from './AddSheet.svelte';
import { pickerUi as ui } from './picker-ui';
import type { PickerData } from './server/picker';

const machine = (id: string, gymId: string, label: string) => ({
	id,
	gymId,
	label,
	equipmentType: 'machine-stack',
	modelName: null,
	modelCode: null,
	bodyRegion: 'legs',
	photoId: null,
	lastUsedAt: null,
	lastExerciseId: null,
	lastTop: null,
	exerciseIds: ['ex-curl']
});
const exercise = (id: string, name: string, equipmentType: string) => ({
	id,
	name,
	equipmentType,
	isLowerBody: false,
	bodyRegion: 'legs',
	lastTop: null
});

const picker: PickerData = {
	gyms: [
		{ id: 'gym-a', name: 'Gym A' },
		{ id: 'gym-b', name: 'Gym B' }
	],
	gymId: 'gym-a',
	machines: [machine('m-a', 'gym-a', 'Curl A'), machine('m-b', 'gym-b', 'Curl B')],
	exercises: [
		exercise('ex-curl', 'Leg curl', 'machine-stack'),
		exercise('ex-db', 'Dumbbell curl', 'dumbbell')
	],
	recentExerciseIds: [],
	recentMachineIds: {},
	// No weight format remembered for Leg curl: the format step is asked.
	conventions: {},
	lastMachineAt: {}
};

function show(data: PickerData = picker) {
	return render(AddSheet, { props: { picker: data, sessionId: 'sess-1', open: true } });
}
/**
 * Remembered formats: Leg curl has one with no machine (the key a free weight
 * uses) and another on Curl A; Dumbbell curl has its free-weight one. Each
 * differs from the type's preset, so a remembered one is told from a default.
 */
const remembering: PickerData = {
	...picker,
	conventions: { 'ex-curl|': 'unknown', 'ex-curl|m-a': 'unknown', 'ex-db|': 'displayed' }
};
/** Every add posts; the spy never answers, so the sheet stays as it was. */
const spyAdds = () =>
	vi.spyOn(window, 'fetch').mockImplementation(() => new Promise<Response>(() => {}));
const posted = (spy: ReturnType<typeof spyAdds>) =>
	spy.mock.calls.map(([, init]) => Object.fromEntries((init?.body as FormData).entries()));
async function nameNewMachine(label: string) {
	await page.getByRole('button', { name: ui.addByName }).click();
	await page.getByRole('textbox', { name: ui.machineName }).fill(label);
	await page.getByRole('button', { name: ui.add, exact: true }).click();
}
const dialog = () => page.getByRole('dialog', { name: ui.addExercise });
const tab = (name: string) => page.getByRole('tab', { name, exact: true });
const machineRow = (label: string) =>
	page.getByTestId('machine-row').filter({ hasText: label }).first();
const isOpen = () => document.querySelector('[role="dialog"]') !== null;

afterEach(() => {
	sessionStorage.clear();
	vi.restoreAllMocks();
});

describe('AddSheet', () => {
	it('Escape closes the sheet; in a search field with text it clears the text first', async () => {
		show();
		await expect.element(dialog()).toBeVisible();
		await page.getByRole('searchbox', { name: ui.searchMachines }).fill('Cur');
		await userEvent.keyboard('{Escape}');
		expect(isOpen()).toBe(true);
		await page.getByRole('heading', { name: ui.addExercise }).click();
		await userEvent.keyboard('{Escape}');
		await expect.poll(isOpen).toBe(false);
	});

	it('Back from the weight-format step returns to the machine, which stays chosen', async () => {
		show();
		await machineRow('Curl A').click();
		await page.getByRole('button', { name: 'Leg curl' }).click();
		await expect.element(page.getByText(ui.weightFormat)).toBeVisible();
		await page.getByRole('button', { name: ui.back, exact: true }).click();
		// The machine step again: its exercises and "Another exercise".
		await expect.element(page.getByRole('button', { name: ui.anotherExercise })).toBeVisible();
		await expect.element(page.getByText('Curl A', { exact: true })).toBeVisible();
	});

	it('Back from the weight-format step keeps the exercise looking for a machine', async () => {
		show();
		await tab(ui.exercisesTab).click();
		await page.getByTestId('exercise-row').filter({ hasText: 'Leg curl' }).click();
		await expect.element(page.getByTestId('exercise-context')).toBeVisible();
		await machineRow('Curl A').click();
		await expect.element(page.getByText(ui.weightFormat)).toBeVisible();
		await page.getByRole('button', { name: ui.back, exact: true }).last().click();
		await expect.element(page.getByTestId('exercise-context')).toHaveTextContent('Leg curl');
		await expect.element(machineRow('Curl A')).toBeVisible();
	});

	it('changing tab drops the other flow’s hidden choice', async () => {
		show();
		await tab(ui.exercisesTab).click();
		await page.getByTestId('exercise-row').filter({ hasText: 'Leg curl' }).click();
		await expect.element(page.getByTestId('exercise-context')).toBeVisible();
		await tab(ui.exercisesTab).click();
		await tab(ui.machinesTab).click();
		expect(document.querySelector('[data-testid="exercise-context"]')).toBeNull();
		// A machine tap now opens the machine, not "Leg curl on Curl A".
		await machineRow('Curl A').click();
		await expect.element(page.getByRole('button', { name: ui.anotherExercise })).toBeVisible();
	});

	it('switching gym drops a machine chosen at the old gym', async () => {
		show();
		await machineRow('Curl A').click();
		await page.getByRole('button', { name: ui.anotherExercise }).click();
		await expect.element(page.getByTestId('machine-context')).toHaveTextContent('Curl A');
		await page.getByText(ui.switchGym).click();
		await page.getByRole('button', { name: 'Gym B', exact: true }).click();
		await expect.element(page.getByTestId('sheet-gym')).toHaveTextContent('Gym B');
		expect(document.querySelector('[data-testid="machine-context"]')).toBeNull();
	});

	it('a double tap on a free weight submits once', async () => {
		// The add never answers: the sheet stays busy, as on a slow gym network.
		const fetchSpy = vi.spyOn(window, 'fetch').mockImplementation(() => new Promise(() => {}));
		show();
		await tab(ui.exercisesTab).click();
		const row = page.getByTestId('exercise-row').filter({ hasText: 'Dumbbell curl' });
		await row.click();
		await row.click();
		await expect.poll(() => fetchSpy.mock.calls.length).toBe(1);
		await new Promise((r) => setTimeout(r, 200));
		expect(fetchSpy.mock.calls.length).toBe(1);
		// While busy, Escape leaves the sheet for the result to close.
		await userEvent.keyboard('{Escape}');
		expect(isOpen()).toBe(true);
	});

	describe('a remembered weight format', () => {
		it('an exercise on a machine named just now asks for its format, and posts the one chosen', async () => {
			const spy = spyAdds();
			show(remembering);
			await tab(ui.exercisesTab).click();
			await page.getByTestId('exercise-row').filter({ hasText: 'Leg curl' }).click();
			await nameNewMachine('New curl');
			await expect.element(page.getByText(ui.weightFormat)).toBeVisible();
			expect(spy).not.toHaveBeenCalled();
			// Neither the remembered 'unknown' nor the preset 'displayed': the choice is what posts.
			await page.getByRole('button', { name: 'Per hand / arm' }).click();
			await page.getByRole('button', { name: ui.add, exact: true }).click();
			await expect.poll(() => spy.mock.calls.length).toBe(1);
			expect(posted(spy)[0]).toMatchObject({
				exerciseId: 'ex-curl',
				newMachineName: 'New curl',
				loadConvention: 'per_arm'
			});
			expect(posted(spy)[0].gymEquipmentId).toBeUndefined();
		});

		it('a machine named first, then the exercise, asks too', async () => {
			const spy = spyAdds();
			show(remembering);
			await nameNewMachine('New curl');
			await page.getByTestId('exercise-row').filter({ hasText: 'Leg curl' }).click();
			await expect.element(page.getByText(ui.weightFormat)).toBeVisible();
			expect(spy).not.toHaveBeenCalled();
		});

		it('an existing machine with a remembered format adds at once, in that format', async () => {
			const spy = spyAdds();
			show(remembering);
			await machineRow('Curl A').click();
			await page.getByRole('button', { name: 'Leg curl' }).click();
			await expect.poll(() => spy.mock.calls.length).toBe(1);
			expect(posted(spy)[0]).toMatchObject({
				exerciseId: 'ex-curl',
				gymEquipmentId: 'm-a',
				loadConvention: 'unknown'
			});
			expect(document.body.innerText).not.toContain(ui.weightFormat);
		});

		it('a free weight with a remembered format adds at once, in that format', async () => {
			const spy = spyAdds();
			show(remembering);
			await tab(ui.exercisesTab).click();
			await page.getByTestId('exercise-row').filter({ hasText: 'Dumbbell curl' }).click();
			await expect.poll(() => spy.mock.calls.length).toBe(1);
			expect(posted(spy)[0]).toMatchObject({ exerciseId: 'ex-db', loadConvention: 'displayed' });
			expect(posted(spy)[0].gymEquipmentId).toBeUndefined();
		});
	});
});
