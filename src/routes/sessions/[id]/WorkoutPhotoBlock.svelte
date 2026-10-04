<script lang="ts">
	import { enhance } from '$app/forms';
	import { workoutUi } from '$lib/workout-ui';
	import type { Action } from 'svelte/action';
	import type { PageData } from './$types';
	import type { WorkoutPhotos } from './workout-photos.svelte';
	let {
		occurrenceId,
		block,
		named,
		live,
		photos
	}: {
		occurrenceId: string;
		block?: PageData['photoBlocks'][string];
		named?: PageData['namedPhotoBlocks'][string];
		live: boolean;
		photos: WorkoutPhotos;
	} = $props();
	/** Only a newly uploaded photo is automatically read; reloads require a tap. */
	const readOnce: Action<HTMLFormElement, boolean> = (form, go) => {
		if (go) form.requestSubmit();
	};
</script>

{#if block}
	{@const pb = block}
	<div class="photo-block" data-testid="photo-block">
		{#if pb.kind === 'reading' && (photos.readingIds.includes(pb.photoId) || photos.autoRead.includes(pb.photoId))}
			<p class="photo-line" aria-live="polite">{workoutUi.photoReading}</p>
		{:else if pb.kind === 'match' && !photos.laterIds.includes(occurrenceId)}
			<form method="POST" action="?/identify" use:enhance class="identify">
				<p class="model">{pb.modelLabel}</p>
				<input type="hidden" name="occurrenceId" value={occurrenceId} />
				<input type="hidden" name="modelId" value={pb.modelId} />
				<label
					>{workoutUi.photoExerciseLabel}<input
						name="exerciseName"
						value={pb.exerciseName}
						maxlength="120"
						autocomplete="off"
						autocapitalize="words"
						spellcheck="false"
					/></label
				>
				<label
					>{workoutUi.photoWeightLabel}<select name="loadConvention">
						{#if pb.equipmentType === 'machine-plate'}<option
								value="plates_per_side"
								selected={pb.loadConvention === 'plates_per_side'}>Plates per side</option
							><option value="total_plates" selected={pb.loadConvention === 'total_plates'}
								>All plates combined</option
							>{/if}
						<option value="per_arm" selected={pb.loadConvention === 'per_arm'}
							>Per hand / arm</option
						><option value="displayed" selected={pb.loadConvention === 'displayed'}
							>Total or displayed weight</option
						><option value="unknown" selected={pb.loadConvention === 'unknown'}
							>Not sure — keep separate</option
						>
					</select></label
				>
				<div class="identify-actions">
					<button class="use">{workoutUi.photoUseThis}</button><button
						type="button"
						class="later"
						onclick={() => (photos.laterIds = [...photos.laterIds, occurrenceId])}
						>{workoutUi.photoLater}</button
					>
				</div>
				<a class="other" href="/photos/{pb.photoId}/review">{workoutUi.photoOtherMachine}</a>
			</form>
		{:else if pb.kind !== 'match'}
			<p class="photo-line">{workoutUi.photoReadFailed}</p>
		{/if}
		{#if pb.kind === 'reading'}
			<form
				method="POST"
				action="?/readPhoto"
				class="photo-actions"
				use:enhance={photos.readSubmit(pb.photoId)}
				use:readOnce={photos.autoRead.includes(pb.photoId)}
			>
				<input type="hidden" name="photoId" value={pb.photoId} />
				{#if !photos.readingIds.includes(pb.photoId) && !photos.autoRead.includes(pb.photoId)}<button
						>{workoutUi.photoReadAgain}</button
					><a href="/photos/{pb.photoId}/review">{workoutUi.photoNameIt}</a>{/if}
			</form>
		{:else if pb.kind === 'none' || photos.laterIds.includes(occurrenceId)}
			<div class="photo-actions">
				<a href="/photos/{pb.photoId}/review">{workoutUi.photoNameIt}</a>
			</div>
		{/if}
	</div>
{/if}
{#if live && named}
	<form
		method="POST"
		action="?/undoIdentify"
		class="photo-named"
		data-testid="photo-named"
		use:enhance={({ formData }) => {
			// The new placeholder's label carries the phone's own time.
			formData.set(
				'timeLabel',
				new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
			);
		}}
	>
		<input type="hidden" name="occurrenceId" value={occurrenceId} />
		<span>{workoutUi.photoNamedFrom(named.modelLabel)}</span><button>{workoutUi.photoUndo}</button>
	</form>
{/if}

<style>
	button {
		cursor: pointer;
	}
	.photo-block {
		margin-bottom: 14px;
		font-size: 14px;
	}
	.photo-line {
		color: #b6c5da;
	}
	.photo-actions {
		display: flex;
		gap: 16px;
		align-items: center;
		margin-top: 6px;
	}
	.photo-actions a,
	.photo-actions button {
		min-height: 44px;
		display: inline-flex;
		align-items: center;
		color: #c7d2fe;
		font-weight: 600;
	}
	.identify {
		display: grid;
		gap: 10px;
		border: 1px solid #3b4a63;
		border-radius: 12px;
		padding: 12px;
	}
	.identify .model {
		font-weight: 600;
		color: #e2e8f0;
	}
	.identify label {
		display: grid;
		gap: 4px;
		color: #b6c5da;
		font-size: 13px;
	}
	.identify input,
	.identify select {
		background: #0b1220;
		color: #e2e8f0;
		border: 1px solid #46546b;
		border-radius: 9px;
		padding: 10px;
		font-size: 16px;
	}
	.identify-actions {
		display: flex;
		gap: 8px;
	}
	.identify-actions button {
		min-height: 44px;
		flex: 1;
		border-radius: 9px;
		font-weight: 600;
	}
	.identify-actions .use {
		background: #c7d2fe;
		color: #182044;
	}
	.identify-actions .later {
		border: 1px solid #46546b;
		color: #c7d2fe;
	}
	.identify .other {
		min-height: 44px;
		display: inline-flex;
		align-items: center;
		color: #c7d2fe;
		font-size: 13px;
		font-weight: 600;
	}
	.photo-named {
		display: flex;
		gap: 12px;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 12px;
		font-size: 13px;
		color: #b6c5da;
	}
	.photo-named button {
		min-height: 44px;
		color: #c7d2fe;
		font-weight: 600;
		flex: none;
	}
</style>
