/**
 * The photo block's line and actions for each state (plan 2026-11-08 §4, 2f).
 * On a phone: one line under the block's title and at most two 44 px actions,
 * read between sets with one thumb, so every state must leave a way forward.
 */
import { describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import WorkoutPhotoBlock from './WorkoutPhotoBlock.svelte';
import { workoutUi as ui } from '$lib/workout-ui';

const photoId = '00000000-0000-4000-8000-0000000000aa';

/** The page's WorkoutPhotos, without its onMount: only the lists the block reads. */
function photos(
	over: Partial<Record<'readingIds' | 'autoRead' | 'laterIds' | 'failedIds', string[]>> = {}
) {
	return {
		readingIds: [],
		autoRead: [],
		laterIds: [],
		failedIds: [],
		readSubmit: () => () => {},
		...over
	};
}

function show(block: Record<string, unknown>, list = photos()) {
	return render(WorkoutPhotoBlock as unknown as never, {
		props: { occurrenceId: 'occ-1', block, live: true, photos: list } as never
	});
}

const readAgain = () => page.getByRole('button', { name: ui.photoReadAgain, exact: true });
const nameIt = () => page.getByRole('link', { name: ui.photoNameIt, exact: true });
/** As rendered: Svelte drops leading whitespace inside an {#if}. */
const line = () => (document.querySelector('.photo-line') as HTMLElement | null)?.innerText ?? null;

describe('WorkoutPhotoBlock', () => {
	it('failed: the failure line, Read again and Name it', async () => {
		show({ kind: 'failed', photoId });
		await expect.element(readAgain()).toBeInTheDocument();
		await expect.element(nameIt()).toHaveAttribute('href', `/photos/${photoId}/review`);
		expect(line()).toBe(ui.photoReadFailed);
	});

	it('reading, not running (after a reload): a neutral line, Read again and Name it', async () => {
		show({ kind: 'reading', photoId });
		await expect.element(readAgain()).toBeInTheDocument();
		await expect.element(nameIt()).toBeInTheDocument();
		expect(line()).toBe(ui.photoNotRead);
	});

	it('reading, failed from this page: the failure line, with both actions', async () => {
		show({ kind: 'reading', photoId }, photos({ failedIds: [photoId] }));
		await expect.element(readAgain()).toBeInTheDocument();
		await expect.element(nameIt()).toBeInTheDocument();
		expect(line()).toBe(ui.photoReadFailed);
	});

	it.each(['reading', 'failed'])('%s while a read runs: only the reading line', async (kind) => {
		show({ kind, photoId }, photos({ readingIds: [photoId] }));
		expect(line()).toBe(ui.photoReading);
		await expect.element(readAgain()).not.toBeInTheDocument();
		await expect.element(nameIt()).not.toBeInTheDocument();
	});

	it('none: the failure line and Name it only (unchanged)', async () => {
		show({ kind: 'none', photoId });
		await expect.element(nameIt()).toBeInTheDocument();
		await expect.element(readAgain()).not.toBeInTheDocument();
		expect(line()).toBe(ui.photoReadFailed);
	});

	it('match: the Use this card, no line (unchanged)', async () => {
		show({
			kind: 'match',
			photoId,
			modelId: '00000000-0000-4000-8000-0000000000bb',
			modelLabel: 'Hammer Strength Iso-Lateral Row',
			exerciseName: 'Iso-Lateral Row',
			loadConvention: 'plates_per_side',
			equipmentType: 'machine-plate'
		});
		await expect
			.element(page.getByRole('button', { name: ui.photoUseThis, exact: true }))
			.toBeInTheDocument();
		await expect.element(readAgain()).not.toBeInTheDocument();
		expect(line()).toBeNull();
	});
});
