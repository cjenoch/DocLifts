<script lang="ts">
	import { enhance } from '$app/forms';
	import { workoutUi } from '$lib/workout-ui';
	import { isLogged, type WorkoutEdits } from './workout-edits.svelte';
	import type { PageData } from './$types';
	let {
		group,
		occurrenceId,
		index,
		groupCount,
		quick,
		photoBlock,
		editing,
		edits,
		onswap
	}: {
		group: PageData['groups'][number];
		occurrenceId: string;
		index: number;
		groupCount: number;
		quick: boolean;
		photoBlock: boolean;
		editing: boolean;
		edits: WorkoutEdits;
		onswap: (target: {
			occurrenceId: string;
			exerciseId: string;
			exerciseName: string;
			planned: boolean;
		}) => void;
	} = $props();
	const loggedCount = $derived(group.sets.filter(isLogged).length);
</script>

<details class="exercise-menu" data-testid="exercise-menu" class:tool-hidden={!editing}>
	<summary aria-label={workoutUi.exerciseMenu(group.exerciseName)}>⋯</summary>
	<div class="menu-items">
		{#each [['up', workoutUi.moveUp, index > 0], ['down', workoutUi.moveDown, index < groupCount - 1]] as const as [direction, label, show] (direction)}
			{#if show}
				<form method="POST" action="?/moveExercise" use:enhance={edits.editSubmit}>
					<input type="hidden" name="occurrenceId" value={occurrenceId} />
					<input type="hidden" name="direction" value={direction} />
					<button>{label}</button>
				</form>
			{/if}
		{/each}
		{#if loggedCount === 0 && !photoBlock}
			<button
				type="button"
				onclick={(e) => {
					(e.currentTarget.closest('details') as HTMLDetailsElement).open = false;
					onswap({
						occurrenceId,
						exerciseId: group.exerciseId,
						exerciseName: group.exerciseName,
						planned: !quick && group.sets.some((x) => x.prescribedSetId != null)
					});
				}}>{workoutUi.swap}</button
			>
			<button
				type="button"
				class="danger"
				onclick={(e) => {
					(e.currentTarget.closest('details') as HTMLDetailsElement).open = false;
					edits.startRemove(occurrenceId, group.exerciseName);
				}}>{workoutUi.remove}</button
			>
		{:else if loggedCount > 0}
			<p class="menu-note">{workoutUi.swapLocked}</p>
			{#if loggedCount < group.sets.length}
				<form method="POST" action="?/skipRest" use:enhance={edits.editSubmit}>
					<input type="hidden" name="occurrenceId" value={occurrenceId} />
					<button>{workoutUi.skipRest}</button>
				</form>
			{/if}
			<form method="POST" action="?/removeExercise" use:enhance={edits.editSubmit}>
				<input type="hidden" name="occurrenceId" value={occurrenceId} />
				<input type="hidden" name="loggedCount" value={loggedCount} />
				<input type="hidden" name="exerciseName" value={group.exerciseName} />
				<button class="danger">{workoutUi.removeWithSets}</button>
			</form>
		{/if}
	</div>
</details>

<style>
	.tool-hidden {
		display: none !important;
	}
	button {
		cursor: pointer;
	}
	.exercise-menu {
		position: relative;
	}
	.exercise-menu summary {
		list-style: none;
		display: grid;
		place-items: center;
		min-width: 44px;
		min-height: 44px;
		font-size: 22px;
		color: #c7d2fe;
		cursor: pointer;
	}
	.exercise-menu summary::-webkit-details-marker {
		display: none;
	}
	.menu-items {
		position: absolute;
		right: 0;
		z-index: 20;
		width: min(16rem, calc(100vw - 48px));
		padding: 6px;
		border: 1px solid #3f3f46;
		border-radius: 12px;
		background: #18181b;
	}
	.menu-items button {
		display: block;
		width: 100%;
		min-height: 44px;
		padding: 0 12px;
		text-align: left;
		color: #e4e4e7;
	}
	.menu-items .danger {
		color: #fca5a5;
	}
	.menu-note {
		margin-top: 5px;
		padding: 8px 12px;
		font-size: 13px;
		color: #a1a1aa;
	}
</style>
