<script lang="ts">
	import { LATERALITY_LABELS } from '$lib/catalog-labels';
	import type { ActionData, PageData } from './$types';
	import { pageTitle } from '$lib/app-shell';
	let { data, form }: { data: PageData; form: ActionData } = $props();
	const m = $derived(data.model);
	const title = $derived([m.manufacturer, m.code, m.name].filter(Boolean).join(' '));
</script>

<svelte:head
	><title>{pageTitle(data.editable ? 'Edit your model' : 'Create your own copy')}</title
	></svelte:head
>

<div class="mx-auto max-w-lg space-y-5 p-4">
	<a href={`/equipment/${m.id}`} class="text-indigo-300">← {m.name}</a>
	<h1 class="text-2xl font-semibold">
		{data.editable ? 'Edit your model' : 'Create your own copy'}
	</h1>
	<p class="text-zinc-300">{title}</p>
	{#if !data.editable}
		<p class="text-sm text-zinc-400">
			This is a catalog row, shared by everyone, so it is not edited in place. Saving creates your
			own copy with your numbers; the catalog stays as it is for everyone else.
		</p>
	{/if}
	{#if form?.message}<p role="status" class="text-amber-300">{form.message}</p>{/if}

	<form
		method="POST"
		action={data.editable ? '?/update' : '?/copy'}
		class="space-y-3 rounded border border-zinc-700 p-4"
	>
		<label class="block"
			>Starting resistance (lb)<input
				name="startingResistance"
				type="number"
				min="0"
				max="2000"
				step="0.5"
				inputmode="decimal"
				value={m.startingResistance ?? ''}
				class="mt-1 block w-full rounded bg-zinc-800 p-2"
			/></label
		>
		<label class="block"
			>Basis<select name="startingResistanceBasis" class="mt-1 block w-full rounded bg-zinc-800 p-2"
				><option value="">Not stated</option><option
					value="total"
					selected={m.startingResistanceBasis === 'total'}>Total</option
				><option value="per_arm" selected={m.startingResistanceBasis === 'per_arm'}>Per arm</option
				></select
			></label
		>
		<label class="block"
			>Laterality<select name="laterality" class="mt-1 block w-full rounded bg-zinc-800 p-2"
				>{#each Object.entries(LATERALITY_LABELS) as [value, label]}<option
						{value}
						selected={value === m.laterality}>{label}</option
					>{/each}</select
			></label
		>
		<button class="rounded bg-indigo-600 px-4 py-2"
			>{data.editable ? 'Save' : 'Create my own copy'}</button
		>
	</form>
</div>
