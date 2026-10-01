<script lang="ts">
	import {
		BODY_REGION_LABELS,
		LATERALITY_LABELS,
		LOADING_TYPE_LABELS,
		confidenceBadge,
		defaultMachineLabel,
		isHttpUrl,
		resistanceLabel
	} from '$lib/catalog-labels';
	import type { ActionData, PageData } from './$types';
	let { data, form }: { data: PageData; form: ActionData } = $props();
	const m = $derived(data.model);
	const badge = $derived(confidenceBadge(data.model, data.userId));
	const mine = $derived(data.model.ownerUserId === data.userId);
</script>

<div class="mx-auto max-w-lg space-y-5 p-4">
	<a href="/equipment" class="text-indigo-300">← Equipment catalog</a>
	<h1 class="text-2xl font-semibold">{m.name}</h1>
	<p class="text-zinc-300">
		{[m.manufacturer, m.productLine].filter(Boolean).join(' · ')}
	</p>
	{#if form?.message}<p role="status" class="text-amber-300">{form.message}</p>{/if}
	{#if m.retiredAt}
		<p class="text-sm text-amber-300" data-testid="model-retired">
			No longer in the catalog: the latest manufacturer snapshot does not list this model. Machines
			already linked to it keep it; it is not offered for new machines.
		</p>
	{/if}

	<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
		<dt class="text-zinc-400">Model code</dt>
		<dd class="font-mono">{m.code || '—'}</dd>
		<dt class="text-zinc-400">Loading type</dt>
		<dd>{LOADING_TYPE_LABELS[m.loadingType] ?? m.loadingType}</dd>
		<dt class="text-zinc-400">Laterality</dt>
		<dd>{LATERALITY_LABELS[m.laterality] ?? m.laterality}</dd>
		<dt class="text-zinc-400">Body region</dt>
		<dd>{m.bodyRegion ? (BODY_REGION_LABELS[m.bodyRegion] ?? m.bodyRegion) : '—'}</dd>
		<dt class="text-zinc-400">Starting resistance</dt>
		<dd>{resistanceLabel(m)}</dd>
		<dt class="text-zinc-400">Confidence</dt>
		<dd>
			{badge.label}{#if !mine}<span class="text-zinc-400"> ({m.confidence})</span>{/if}
		</dd>
		<dt class="text-zinc-400">Source</dt>
		<dd>
			{#if isHttpUrl(m.sourceUrl)}<a
					href={m.sourceUrl}
					rel="noopener noreferrer external"
					class="break-all text-indigo-300">{m.sourceUrl}</a
				>{:else}{m.sourceUrl || '—'}{/if}
		</dd>
		<dt class="text-zinc-400">Catalog date</dt>
		<dd>{m.catalogSnapshot ?? '—'}</dd>
		<dt class="text-zinc-400">Standard stack</dt>
		<dd data-testid="model-stack">
			{m.standardStackLb != null ? `${m.standardStackLb} lb` : '—'}{#if m.standardStackNote}<span
					class="text-zinc-400"
				>
					({m.standardStackNote})</span
				>{/if}
		</dd>
		<dt class="text-zinc-400">Notes</dt>
		<dd data-testid="model-notes">{m.notes || '—'}</dd>
	</dl>
	<a href={`/equipment/${m.id}/edit`} class="inline-block text-sm text-indigo-300"
		>{mine ? 'Edit starting resistance and laterality' : 'Numbers wrong? Create your own copy'}</a
	>
	{#if badge.tone === 'unverified'}
		<p class="text-sm text-amber-300">
			Unverified: this row was inferred, not read from a catalog. Check the placard on the machine.
		</p>
	{/if}

	<section class="space-y-2">
		<h2 class="font-semibold">In your gyms</h2>
		{#if data.instances.length}
			<ul class="text-sm">
				{#each data.instances as i (i.gymEquipmentId)}<li>
						{[
							i.gymName,
							i.localLabel,
							i.stackLb && `${i.stackLb} lb stack`,
							i.incrementLb && `${i.incrementLb} lb steps`
						]
							.filter(Boolean)
							.join(' · ')}
					</li>{/each}
			</ul>
		{:else}
			<p class="text-sm text-zinc-400">None of your gyms has this model yet.</p>
		{/if}
	</section>

	{#if !m.retiredAt}
		<form method="POST" action="?/addToGym" class="space-y-3 rounded border border-zinc-700 p-4">
			<h2 class="font-semibold">Add to a gym</h2>
			{#if data.gyms.length}
				<label class="block"
					>Gym<select name="gymId" required class="mt-1 block w-full rounded bg-zinc-800 p-2"
						>{#each data.gyms as gym (gym.id)}<option value={gym.id}>{gym.name}</option
							>{/each}</select
					></label
				>
				<label class="block"
					>Local label (optional)<input
						name="localLabel"
						maxlength="120"
						placeholder={defaultMachineLabel(m)}
						aria-describedby="label-hint"
						class="mt-1 block w-full rounded bg-zinc-800 p-2"
					/></label
				>
				<p id="label-hint" class="text-sm text-zinc-400">
					Blank names it "{defaultMachineLabel(m)}". A label like "Row by the window" tells two of
					the same model apart.
				</p>
				<div class="grid grid-cols-2 gap-3">
					<label class="block"
						>Stack (lb, optional)<input
							name="stackLb"
							type="number"
							min="1"
							max="2000"
							step="1"
							inputmode="numeric"
							value={m.standardStackLb ?? ''}
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
							class="mt-1 block w-full rounded bg-zinc-800 p-2"
						/></label
					>
				</div>
				<button class="rounded bg-indigo-600 px-4 py-2">Add to gym</button>
			{:else}
				<p class="text-sm text-zinc-400">
					You have no gyms yet. <a href="/gyms" class="text-indigo-300">Create one</a> first.
				</p>
			{/if}
		</form>
	{/if}
</div>
