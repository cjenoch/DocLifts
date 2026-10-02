<script lang="ts">
	import { defaultMachineLabel } from '$lib/catalog-labels';
	import type { ActionData, PageData } from './$types';
	import { pageTitle } from '$lib/app-shell';
	let { data, form }: { data: PageData; form: ActionData } = $props();
	const m = $derived(data.machine);
	const fallback = $derived(data.model ? defaultMachineLabel(data.model) : null);
</script>

<svelte:head><title>{pageTitle('Edit machine')}</title></svelte:head>

<div class="mx-auto max-w-lg space-y-5 p-4">
	<a href={`/gyms?gym=${data.gym.id}`} class="text-indigo-300">← {data.gym.name}</a>
	<h1 class="text-2xl font-semibold">Edit machine</h1>
	<p class="text-zinc-300">
		{m.equipmentType} ·
		{#if data.model}<a href={`/equipment/${data.model.id}`} class="text-indigo-300"
				>{[data.model.manufacturer, data.model.code, data.model.name].filter(Boolean).join(' ')}</a
			>{:else}Unknown model{/if}
	</p>
	{#if form?.message}<p role="status" class="text-amber-300">{form.message}</p>{/if}

	<form method="POST" action="?/update" class="space-y-3 rounded border border-zinc-700 p-4">
		<label class="block"
			>{fallback ? 'Local label (optional)' : 'Local label'}<input
				name="localLabel"
				maxlength="120"
				required={!fallback}
				value={m.localLabel}
				placeholder={fallback ?? 'e.g. Press near window'}
				class="mt-1 block w-full rounded bg-zinc-800 p-2"
			/></label
		>
		{#if fallback}
			<p class="text-sm text-zinc-400">Blank names it "{fallback}".</p>
		{/if}
		<div class="grid grid-cols-2 gap-3">
			<label class="block"
				>Stack (lb, optional)<input
					name="stackLb"
					type="number"
					min="1"
					max="2000"
					step="1"
					inputmode="numeric"
					value={m.stackLb ?? ''}
					class="mt-1 block w-full rounded bg-zinc-800 p-2"
				/></label
			>
			<label class="block"
				>Increment (lb, optional)<input
					name="incrementLb"
					type="number"
					min="1"
					max="2000"
					step="1"
					inputmode="numeric"
					value={m.incrementLb ?? ''}
					class="mt-1 block w-full rounded bg-zinc-800 p-2"
				/></label
			>
		</div>
		<button class="rounded bg-indigo-600 px-4 py-2">Save</button>
	</form>
	<p class="text-sm text-zinc-400">
		History stays with the machine: renaming it does not change any logged set.
	</p>
</div>
