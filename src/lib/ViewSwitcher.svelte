<script lang="ts">
	import { getContext } from 'svelte';
	import { WORKOUT_VIEW, type WorkoutView } from '$lib/workout-view.svelte';
	const view = getContext<WorkoutView>(WORKOUT_VIEW);
</script>

<div
	class="flex rounded-full border border-zinc-700 bg-zinc-900 p-1"
	role="group"
	aria-label="Workout view"
>
	{#each ['simple', 'advanced'] as const as mode (mode)}
		<button
			type="button"
			aria-label={`${mode === 'simple' ? 'Simple' : 'Advanced'} view`}
			aria-pressed={view.mode === mode}
			onclick={() => view.choose(mode)}
			class="min-h-11 rounded-full px-3 text-xs font-semibold {view.mode === mode
				? 'bg-indigo-200 text-indigo-950'
				: 'text-zinc-400 hover:text-zinc-100'}">{mode === 'simple' ? 'Simple' : 'Advanced'}</button
		>
	{/each}
</div>
