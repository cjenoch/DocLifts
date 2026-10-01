<script lang="ts">
	import {
		BODY_REGION_LABELS,
		LATERALITY_LABELS,
		LOADING_TYPE_LABELS,
		confidenceBadge,
		isHttpUrl,
		resistanceLabel
	} from '$lib/catalog-labels';
	import type { PageData } from './$types';
	let { data }: { data: PageData } = $props();

	// Pagination links keep every filter; only `page` changes.
	function pageHref(page: number) {
		const p = new URLSearchParams();
		for (const [k, v] of Object.entries(data.filters))
			if (k !== 'page' && v !== undefined && v !== '') p.set(k, String(v));
		p.set('page', String(page));
		return `/equipment?${p}`;
	}
	const status = $derived(
		`${data.total} ${data.total === 1 ? 'model' : 'models'}` +
			(data.pages > 1 ? ` · page ${data.page} of ${data.pages}` : '')
	);
	const badgeClass = {
		verified: 'border-emerald-700 text-emerald-300',
		unverified: 'border-amber-700 text-amber-300',
		yours: 'border-indigo-600 text-indigo-200'
	} as const;
</script>

<div class="mx-auto max-w-3xl space-y-4 p-4">
	<a href="/" class="text-indigo-300">← Home</a>
	<h1 class="text-2xl font-semibold">Equipment catalog</h1>
	<p class="text-sm text-zinc-400">
		Manufacturer models, read from their catalogs on the snapshot date, plus any you entered
		yourself. "Unverified" rows were inferred; check the placard on the machine.
	</p>

	<form method="GET" class="grid gap-3 rounded border border-zinc-700 p-4 sm:grid-cols-2">
		<label class="block"
			>Manufacturer<select name="manufacturer" class="mt-1 block w-full rounded bg-zinc-800 p-2"
				><option value="">All manufacturers</option>{#each data.facets.manufacturers as m}<option
						value={m}
						selected={m === data.filters.manufacturer}>{m}</option
					>{/each}</select
			></label
		>
		{#if data.filters.manufacturer}
			<label class="block"
				>Product line<select name="line" class="mt-1 block w-full rounded bg-zinc-800 p-2"
					><option value="">All lines</option>{#each data.facets.lines as l}<option
							value={l}
							selected={l === data.filters.line}>{l}</option
						>{/each}</select
				></label
			>
		{:else}
			<p class="self-end text-xs text-zinc-400">
				Choose a manufacturer and apply to filter by product line.
			</p>
		{/if}
		<label class="block"
			>Loading type<select name="loadingType" class="mt-1 block w-full rounded bg-zinc-800 p-2"
				><option value="">Any</option
				>{#each Object.entries(LOADING_TYPE_LABELS) as [value, label]}<option
						{value}
						selected={value === data.filters.loadingType}>{label}</option
					>{/each}</select
			></label
		>
		<label class="block"
			>Body region<select name="bodyRegion" class="mt-1 block w-full rounded bg-zinc-800 p-2"
				><option value="">Any</option>{#each data.facets.bodyRegions as r}<option
						value={r}
						selected={r === data.filters.bodyRegion}>{BODY_REGION_LABELS[r] ?? r}</option
					>{/each}</select
			></label
		>
		<label class="block sm:col-span-2"
			>Search name or model code<input
				name="q"
				type="search"
				maxlength="120"
				value={data.filters.q ?? ''}
				placeholder="e.g. IL-ROW or leg press"
				class="mt-1 block w-full rounded bg-zinc-800 p-2"
			/></label
		>
		<div class="flex gap-3 sm:col-span-2">
			<button class="rounded bg-indigo-600 px-4 py-2">Apply</button>
			<a href="/equipment" class="self-center text-sm text-indigo-300">Clear filters</a>
		</div>
	</form>

	<p role="status" class="text-sm text-zinc-300">{status}</p>

	<ul class="divide-y divide-zinc-800">
		{#each data.rows as model (model.id)}
			{@const badge = confidenceBadge(model, data.userId)}
			<li class="py-3">
				<div class="flex flex-wrap items-baseline gap-x-2">
					<a href={`/equipment/${model.id}`} class="font-semibold text-indigo-200">{model.name}</a>
					{#if model.code}<span class="font-mono text-sm text-zinc-300">{model.code}</span>{/if}
					<span class={`rounded border px-1.5 text-xs ${badgeClass[badge.tone]}`}
						>{badge.label}</span
					>
				</div>
				<p class="text-sm text-zinc-400">
					{[model.manufacturer, model.productLine].filter(Boolean).join(' · ')}
				</p>
				<p class="text-sm text-zinc-400">
					{[
						LOADING_TYPE_LABELS[model.loadingType] ?? model.loadingType,
						LATERALITY_LABELS[model.laterality] ?? model.laterality,
						`start ${resistanceLabel(model)}`
					].join(' · ')}
					{#if isHttpUrl(model.sourceUrl)}<a
							href={model.sourceUrl}
							rel="noopener noreferrer external"
							class="ml-1 text-indigo-300">source</a
						>{/if}
				</p>
			</li>
		{:else}
			<li class="py-3 text-zinc-400">No models match these filters.</li>
		{/each}
	</ul>

	{#if data.pages > 1}
		<nav aria-label="Pages" class="flex justify-between text-indigo-300">
			{#if data.page > 1}<a href={pageHref(data.page - 1)}>← Previous</a>{:else}<span></span>{/if}
			{#if data.page < data.pages}<a href={pageHref(data.page + 1)}>Next →</a>{/if}
		</nav>
	{/if}
</div>
