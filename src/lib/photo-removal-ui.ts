/**
 * What the photo review page says about removing an image. The only place
 * these strings live; tests read them from here.
 *
 * Two sources, never mixed:
 * - after a removal or discard POST, the outcome of that request's own
 *   `runDeletion` batch (`removalOutcomeMessage`). `busy` is only ever known
 *   here: another runner holds the job or one of its objects, which is not
 *   stored anywhere and is not a failure.
 * - on load, the stored job state from `deletionJobState()` (`removalStatusLine`).
 */
export type RemovalRunOutcome = 'busy' | 'pending' | 'failed';
export type StoredRemovalState = 'pending' | 'needs_retry';

export const photoRemovalUi = {
	disabled: 'Photo removal is not enabled yet.',
	confirmRequired: 'Confirm that you want to remove this image.',
	notAcknowledged:
		'Removal could not be durably acknowledged. The image may already be hidden; contact support before retrying.',
	outcome: {
		busy: 'Photo hidden. Removal is in progress. Check back in a minute.',
		pending: 'Photo hidden. Removal has started and has not finished yet.',
		failed:
			'Photo hidden. Removal failed and is waiting for an operator retry; it has not finished.'
	} satisfies Record<RemovalRunOutcome, string>,
	status: {
		pending: 'Discarded from view. Removal has started and has not finished yet.',
		needs_retry: 'Discarded from view. Removal failed and is waiting for an operator retry.',
		done: 'Discarded. The image is hidden. Backup copies expire separately.'
	} satisfies Record<StoredRemovalState | 'done', string>
} as const;

export function removalOutcomeMessage(state: RemovalRunOutcome): string {
	return photoRemovalUi.outcome[state];
}

export function removalStatusLine(state: StoredRemovalState | null): string {
	return photoRemovalUi.status[state ?? 'done'];
}
