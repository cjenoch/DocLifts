/**
 * The per-exercise menu on a live workout (plan 2026-11-08 §4, 2g). On a phone
 * it is the ⋯ beside the exercise name, opened with one thumb between sets; a
 * menu that hides its main actions has to say why in one line.
 */
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import ExerciseMenu from './ExerciseMenu.svelte';
import { workoutUi as ui } from '$lib/workout-ui';

const emptySet = { executedLoad: null, executedReps: null, executedRir: null, notes: null };
const loggedSet = { ...emptySet, executedLoad: 70, executedReps: 12 };

function open(props: { photoBlock: boolean; sets: Record<string, unknown>[] }) {
	render(ExerciseMenu as unknown as never, {
		props: {
			group: {
				exerciseId: 'ex-1',
				exerciseName: ui.placeholderExerciseName,
				sets: props.sets.map((s, i) => ({ id: `set-${i}`, prescribedSetId: null, ...s }))
			},
			occurrenceId: 'occ-1',
			index: 0,
			groupCount: 2,
			quick: true,
			photoBlock: props.photoBlock,
			editing: true,
			edits: { editSubmit: () => {}, startRemove: () => {} },
			onswap: () => {}
		} as never
	});
	const details = document.querySelector('details') as HTMLDetailsElement;
	details.open = true;
	// As rendered: Svelte drops leading whitespace inside an {#if}.
	const menu = details.querySelector('.menu-items') as HTMLElement;
	const buttons = [...menu.querySelectorAll('button')].map((b) => b.innerText);
	const note = (menu.querySelector('.menu-note') as HTMLElement | null)?.innerText ?? null;
	return { buttons, note };
}

describe('ExerciseMenu', () => {
	it('a photo block with nothing logged: Move, and the line saying why swap and remove are missing', () => {
		const { buttons, note } = open({ photoBlock: true, sets: [emptySet, emptySet] });
		expect(buttons).toEqual([ui.moveDown]);
		expect(note).toBe(ui.photoBlockMenuNote);
	});

	it('the same block once named (no longer a photo block): swap and remove, no note', () => {
		const { buttons, note } = open({ photoBlock: false, sets: [emptySet, emptySet] });
		expect(buttons).toEqual([ui.moveDown, ui.swap, ui.remove]);
		expect(note).toBeNull();
	});

	it('a photo block with a logged set: the logged-sets menu, unchanged', () => {
		const { buttons, note } = open({ photoBlock: true, sets: [loggedSet, emptySet] });
		expect(note).toBe(ui.swapLocked);
		expect(buttons).toEqual([ui.moveDown, ui.skipRest, ui.removeWithSets]);
	});
});
