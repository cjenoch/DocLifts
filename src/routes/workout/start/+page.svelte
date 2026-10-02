<script lang="ts">
	import type { ActionData, PageData } from './$types';
	import { workoutUi } from '$lib/workout-ui';

	let { data, form }: { data: PageData; form: ActionData } = $props();
	let busy = $state(false);
</script>

<svelte:head><title>{workoutUi.startWorkout} · DocLifts</title></svelte:head>

<div class="mx-auto max-w-md px-4 py-6">
	<a href="/" class="text-sm text-indigo-400 active:underline">← Workout</a>
	<h1 class="mt-2 text-2xl font-semibold tracking-tight">{workoutUi.gymStepHeading}</h1>

	<form method="POST" class="mt-5 space-y-4" onsubmit={() => (busy = true)}>
		{#if data.gyms.length}
			<fieldset class="space-y-2">
				<legend class="mb-2 text-sm text-zinc-400">{workoutUi.gymStepChoose}</legend>
				{#each data.gyms as gym (gym.id)}
					<label
						class="flex min-h-12 items-center gap-3 rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-3"
					>
						<input
							type="radio"
							name="gymId"
							value={gym.id}
							checked={gym.id === data.defaultGymId}
							class="size-5"
						/>
						<span class="text-zinc-100">{gym.name}</span>
					</label>
				{/each}
			</fieldset>
		{/if}
		<label class="block text-sm text-zinc-300"
			>{workoutUi.gymStepNewName}
			<input
				name="newGymName"
				maxlength="120"
				required={!data.gyms.length}
				placeholder={workoutUi.gymStepNewNamePlaceholder}
				class="mt-1 block w-full rounded-lg border border-zinc-600 bg-zinc-900 px-3 py-3 text-base text-zinc-100"
			/>
		</label>
		{#if form?.message}<p role="alert" class="text-rose-300">{form.message}</p>{/if}
		<button
			disabled={busy}
			class="block w-full rounded-lg bg-emerald-600 px-4 py-4 text-lg font-semibold text-white disabled:opacity-60"
			>{workoutUi.gymStepSubmit}</button
		>
	</form>
</div>
