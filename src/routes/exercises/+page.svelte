<script lang="ts">
	import { enhance } from '$app/forms';
	import type { ActionData, PageData } from './$types';
	import { pageTitle } from '$lib/app-shell';
	import { BODY_REGIONS, equipmentLabel, pickerUi as ui } from '$lib/picker-ui';
	let { data, form }: { data: PageData; form: ActionData } = $props();
	const groups = $derived(
		[...BODY_REGIONS, null]
			.map((region) => ({
				region,
				items: data.shown.filter((e) => (e.bodyRegion ?? null) === region)
			}))
			.filter((g) => g.items.length)
	);
</script>

<svelte:head><title>{pageTitle(ui.exercisesTitle)}</title></svelte:head>

<main class="mx-auto max-w-lg space-y-5 p-4">
	<h1 class="text-2xl font-semibold">{ui.exercisesTitle}</h1>
	<p class="text-sm text-zinc-400">{ui.exercisesIntro}</p>
	{#if form && 'message' in form && form.message}<p role="alert" class="text-amber-300">
			{form.message}
		</p>{/if}

	{#each groups as group (group.region ?? 'other')}
		<section>
			<h2 class="mb-1 text-xs font-semibold tracking-wider text-zinc-500 uppercase">
				{group.region ?? ui.other}
			</h2>
			<ul class="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
				{#each group.items as exercise (exercise.id)}
					<li>
						<details data-testid="exercise-row">
							<summary class="flex min-h-11 cursor-pointer items-center justify-between gap-3 px-3">
								<span>{exercise.name}</span>
								<span class="text-xs text-zinc-500">{equipmentLabel(exercise.equipmentType)}</span>
							</summary>
							<div class="space-y-3 px-3 pb-3">
								<form method="POST" action="?/rename" use:enhance class="flex gap-2">
									<input type="hidden" name="id" value={exercise.id} />
									<input
										name="name"
										value={exercise.name}
										maxlength="120"
										required
										aria-label={ui.rename}
										autocomplete="off"
										autocapitalize="sentences"
										class="min-w-0 flex-1 rounded bg-zinc-800 p-2"
									/>
									<button class="min-h-11 rounded border border-indigo-600 px-3">{ui.save}</button>
								</form>
								<form method="POST" action="?/region" use:enhance>
									<input type="hidden" name="id" value={exercise.id} />
									<p class="mb-1 text-sm text-zinc-400">{ui.region}</p>
									<div class="flex flex-wrap gap-2">
										{#each [...BODY_REGIONS, ''] as region (region)}
											<button
												name="bodyRegion"
												value={region}
												aria-pressed={(exercise.bodyRegion ?? '') === region}
												class="min-h-11 rounded-full border px-3 text-sm {(exercise.bodyRegion ??
													'') === region
													? 'border-indigo-400 bg-indigo-950 text-indigo-100'
													: 'border-zinc-700 text-zinc-300'}">{region || ui.other}</button
											>
										{/each}
									</div>
								</form>
								<form method="POST" action="?/hide" use:enhance>
									<input type="hidden" name="id" value={exercise.id} />
									<button class="min-h-11 text-red-300">{ui.hide}</button>
								</form>
							</div>
						</details>
					</li>
				{/each}
			</ul>
		</section>
	{/each}

	{#if data.hidden.length}
		<details data-testid="hidden-exercises">
			<summary class="min-h-11 cursor-pointer text-zinc-400"
				>{ui.hidden} ({data.hidden.length})</summary
			>
			<ul>
				{#each data.hidden as exercise (exercise.id)}
					<li class="flex min-h-11 items-center justify-between gap-2">
						<span class="text-zinc-400">{exercise.name}</span>
						<form method="POST" action="?/restore" use:enhance>
							<input type="hidden" name="id" value={exercise.id} />
							<button class="min-h-11 px-2 text-indigo-300">{ui.restore}</button>
						</form>
					</li>
				{/each}
			</ul>
		</details>
	{/if}
</main>
