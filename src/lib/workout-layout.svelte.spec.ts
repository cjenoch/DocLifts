import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkoutLayoutPreferences } from './workout-layout.svelte';

afterEach(() => {
	localStorage.clear();
	vi.restoreAllMocks();
});
describe('workout display preferences', () => {
	it('separates accounts and programs and restores the original choice', () => {
		const view = new WorkoutLayoutPreferences();
		view.restore('alice', 'strength', false);
		expect(view.layout).toBe('table');
		view.layout = 'tap';
		view.rir = 'hide';
		view.notes = true;
		view.save();
		view.restore('alice', 'travel', true);
		expect([view.layout, view.rir, view.notes]).toEqual(['guided', 'program', false]);
		view.restore('bob', 'strength', false);
		expect([view.layout, view.rir, view.notes]).toEqual(['table', 'program', false]);
		view.restore('alice', 'strength', false);
		expect([view.layout, view.rir, view.notes]).toEqual(['tap', 'hide', true]);
	});
	it('ignores invalid preferences and remains usable when storage is refused', () => {
		localStorage.setItem(
			'doclifts:workout-layout:alice:strength',
			JSON.stringify({ layout: 'broken', rir: 'broken', notes: 'false' })
		);
		const view = new WorkoutLayoutPreferences();
		view.restore('alice', 'strength', false);
		expect([view.layout, view.rir, view.notes]).toEqual(['table', 'program', false]);
		vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
			throw new Error('Storage refused');
		});
		view.layout = 'notebook';
		view.save();
		expect(view.layout).toBe('notebook');
		expect(view.storageAvailable).toBe(false);
	});
});
