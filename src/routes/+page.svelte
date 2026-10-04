<script lang="ts">
	import type { PageData } from './$types';
	import { workoutUi } from '$lib/workout-ui';
	import { appShell, pageTitle } from '$lib/app-shell';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head><title>{pageTitle('Workout')}</title></svelte:head>

<div class="mx-auto max-w-md px-4 py-6">
	<h1 class="mb-2 text-2xl font-semibold tracking-tight">Workout</h1>
	<p class="mb-5 text-sm text-zinc-400">Document your lifts, one set at a time.</p>

	<p class="mb-5 text-xs text-zinc-400">
		Open a workout to choose Guided, Set table, Notebook or Tap sets.
	</p>

	{#if data.firstRun}
		<!-- A fresh account (0.5.5): what to do, and one button to do it. -->
		<ol class="mb-6 list-decimal space-y-2 pl-6 text-lg text-zinc-200" data-testid="first-run">
			{#each appShell.firstRunSteps as step (step)}<li>{step}</li>{/each}
		</ol>
		<a
			href="/workout/start"
			class="block rounded-lg bg-emerald-600 px-4 py-4 text-center text-lg font-semibold text-white"
			>{workoutUi.startWorkout}</a
		>
		<a
			href="/programs/new"
			class="mt-3 flex min-h-11 items-center justify-center text-sm text-indigo-300"
			>Explore starter programs</a
		>
	{:else}
		{#if data.toName.count && data.toName.latestSessionId}<a
				href="/sessions/{data.toName.latestSessionId}"
				class="mb-3 flex min-h-11 items-center justify-between rounded-lg border border-amber-700/60 bg-amber-950/40 px-4 font-semibold text-amber-200"
				data-testid="machines-to-name"
				>{workoutUi.machinesToName(data.toName.count)} <span aria-hidden="true">→</span></a
			>{/if}
		{#if data.openQuickSessionId}
			<a
				href="/sessions/{data.openQuickSessionId}"
				class="mb-3 block rounded-lg bg-emerald-600 px-4 py-4 text-center text-lg font-semibold text-white"
				>{workoutUi.resumeWorkout}</a
			>
		{:else}
			<a
				href="/workout/start"
				class="mb-3 block rounded-lg bg-emerald-600 px-4 py-4 text-center text-lg font-semibold text-white"
				>{workoutUi.startWorkout}</a
			>
		{/if}

		<details class="mb-5 rounded-xl border border-zinc-800 px-4" data-testid="program-tools">
			<summary class="min-h-12 cursor-pointer py-3 text-sm font-semibold text-zinc-300"
				>Program tools</summary
			>
			<p class="mb-3 text-sm text-zinc-400">
				Start with a routine, or build one around the way you train.
			</p>
			<a
				href="/programs/new"
				class="mb-4 flex min-h-11 items-center justify-center rounded-lg border border-indigo-500 px-4 font-semibold text-indigo-200"
				>Create program</a
			>
		</details>

		{#if data.hasImported}
			<a
				href="/imported-history"
				class="mb-5 block rounded-lg border border-zinc-700 bg-zinc-900 p-4 text-indigo-300"
				>Imported workout history →</a
			>
		{/if}

		<h2 class="mb-3 text-sm font-semibold tracking-wider text-zinc-500 uppercase">Programs</h2>
		{#if data.programs.length === 0}
			<p class="text-zinc-500">No active programs.</p>
		{:else}
			<ul class="space-y-2">
				{#each data.programs as program (program.id)}
					<li>
						<a
							href="/programs/{program.id}"
							class="block rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 transition active:scale-[0.99] active:bg-zinc-900"
						>
							<div class="font-medium text-zinc-100">{program.name}</div>
							{#if program.description}
								<div class="mt-1 text-sm text-zinc-400">{program.description}</div>
							{/if}
						</a>
					</li>
				{/each}
			</ul>
		{/if}
	{/if}
</div>
