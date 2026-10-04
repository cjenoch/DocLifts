<script lang="ts">
	import { enhance } from '$app/forms';
	import PhotoNotice from '$lib/PhotoNotice.svelte';
	import { workoutUi } from '$lib/workout-ui';
	import type { WorkoutPhotos } from './workout-photos.svelte';
	let { photos, accepted }: { photos: WorkoutPhotos; accepted: boolean } = $props();
	let photoForm: HTMLFormElement | undefined = $state();
</script>

{#if !accepted}
	<PhotoNotice collapsed />
{:else}
	<form
		method="POST"
		action="?/photo"
		enctype="multipart/form-data"
		class="photo-form"
		bind:this={photoForm}
		use:enhance={photos.photoSubmit}
	>
		<input type="hidden" name="requestId" value={photos.photoRequestId} />
		<!-- No capture attribute: the phone offers camera, library and files (0.4.2). -->
		<label class="photo-next" class:busy={photos.photoStage !== null}
			>{photos.photoStage ?? workoutUi.photoNextMachine}<input
				type="file"
				name="photo"
				id="photo-next-input"
				accept="image/jpeg,image/png,image/webp"
				class="sr-only"
				disabled={photos.photoStage !== null}
				onchange={() => photoForm?.requestSubmit()}
			/></label
		>
		{#if photos.photoError}<p role="alert" class="photo-error">{photos.photoError}</p>{/if}
	</form>
{/if}

<style>
	.photo-form {
		margin-bottom: 8px;
	}
	.photo-next {
		min-height: 48px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 10px;
		background: #059669;
		color: #fff;
		font-weight: 700;
		font-size: 15px;
		cursor: pointer;
	}
	.photo-next.busy {
		opacity: 0.7;
	}
	.photo-error {
		color: #fda4af;
		font-size: 12px;
		text-align: center;
		margin-top: 6px;
		margin-bottom: 8px;
	}
</style>
