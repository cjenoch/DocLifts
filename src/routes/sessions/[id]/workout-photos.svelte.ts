import { onMount } from 'svelte';
import { requestId as newRequestId } from '$lib/request-id';
import { photoClientSettings, resizeForUpload } from '$lib/photo-client';
import { workoutUi } from '$lib/workout-ui';
import type { SubmitFunction } from '@sveltejs/kit';
/** One instance per workout page, retained while server data is invalidated. */
export class WorkoutPhotos {
	autoRead = $state<string[]>([]);
	readingIds = $state<string[]>([]);
	laterIds = $state<string[]>([]);
	photoStage = $state<string | null>(null);
	photoError = $state('');
	photoRequestId = $state('');
	constructor() {
		onMount(() => {
			this.photoRequestId = newRequestId();
		});
	}
	photoSubmit: SubmitFunction = async ({ formData, cancel }) => {
		if (this.photoStage) return cancel();
		this.photoError = '';
		this.photoStage = photoClientSettings.labels.preparing;
		const chosen = formData.get('photo');
		if (!(chosen instanceof File) || chosen.size === 0) {
			this.photoStage = null;
			return cancel();
		}
		const sent = await resizeForUpload(chosen);
		formData.set('photo', sent, sent.name);
		formData.set('clientOriginalBytes', String(chosen.size));
		formData.set('clientResized', sent === chosen ? '0' : '1');
		// The phone's own clock for the placeholder's label ("Photo 2:32 PM").
		formData.set(
			'timeLabel',
			new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
		);
		this.photoStage = workoutUi.photoAdding;
		return async ({ result, update }) => {
			try {
				if (result.type === 'success' && result.data?.photoId) {
					this.autoRead = [...this.autoRead, String(result.data.photoId)];
					this.photoRequestId = newRequestId();
				} else if (result.type === 'failure') {
					this.photoError = String(result.data?.message ?? workoutUi.photoReadFailed);
				} else if (result.type === 'error') {
					this.photoError = 'The photo did not get through. Try again.';
					return;
				}
				await update({ reset: true });
			} finally {
				this.photoStage = null;
			}
		};
	};

	readSubmit =
		(photoId: string): SubmitFunction =>
		() => {
			this.readingIds = [...this.readingIds, photoId];
			this.autoRead = this.autoRead.filter((id) => id !== photoId);
			return async ({ update }) => {
				try {
					await update();
				} finally {
					this.readingIds = this.readingIds.filter((id) => id !== photoId);
				}
			};
		};
}
