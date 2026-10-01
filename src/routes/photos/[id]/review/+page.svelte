<script lang="ts">
	import {
		LATERALITY_LABELS,
		LOADING_TYPE_LABELS,
		confidenceBadge,
		defaultMachineLabel
	} from '$lib/catalog-labels';
	import type { ActionData, PageData } from './$types';
	let { data, form }: { data: PageData; form: ActionData } = $props();

	/** Below this, a field is marked for the user to check against the photo. */
	const LOW_CONFIDENCE = 0.6;
	const c = $derived(data.candidate);
	const open = $derived(data.photo.status === 'uploaded' || data.photo.status === 'analyzed');
	const low = (field: 'manufacturer' | 'model_code' | 'name' | 'loading_type') =>
		!!c && c.field_confidence[field] < LOW_CONFIDENCE;
	const CANDIDATE_LOADING: Record<string, string> = {
		selectorized: 'Selectorized (stack)',
		plate_loaded: 'Plate loaded',
		cable_stack: 'Cable',
		unknown: 'Unknown'
	};
	const METHOD_TEXT: Record<string, string> = {
		exact: 'Exact match on manufacturer and model code.',
		prefix:
			'Prefix match on the model code: the catalog lists a base code and the placard prints a longer one. Check it is the same machine.',
		name: 'No model code matched. These are the closest names; none is chosen for you.',
		none: 'No match in the catalog or your own models. Create your own model below.'
	};
</script>

<div class="mx-auto max-w-lg space-y-5 p-4">
	<a href={`/gyms/${data.gym.id}/equipment/photo`} class="text-indigo-300"
		>← Add another photo for {data.gym.name}</a
	>
	<h1 class="text-2xl font-semibold">Review the photo</h1>
	{#if form?.message}<p role="status" class="text-amber-300">{form.message}</p>{/if}

	{#if data.photo.status === 'discarded'}
		<p data-testid="photo-status">Discarded. The image has been deleted.</p>
	{:else}
		<img
			src={`/photos/${data.photo.id}/image`}
			alt="The placard you uploaded"
			width={data.photo.width}
			height={data.photo.height}
			class="h-auto max-h-96 w-full rounded border border-zinc-700 object-contain"
		/>
	{/if}

	{#if data.photo.status === 'confirmed'}
		<p data-testid="photo-status">
			Added to {data.gym.name}{#if data.resultModel}
				as <a href={`/equipment/${data.resultModel.id}`} class="text-indigo-300"
					>{defaultMachineLabel(data.resultModel)}</a
				>{/if}.
		</p>
		<a href="/gyms" class="text-indigo-300">Gyms and machines</a>
	{/if}

	{#if open}
		{#if data.analysisNotice === 'limit'}
			<p role="alert" class="text-amber-300">
				The daily limit on photo analyses is reached. Try again later, or create the model yourself
				below.
			</p>
		{:else if data.analysisNotice === 'failed' || !c}
			<p role="alert" class="text-amber-300">
				Analysis failed, try again. You can also create the model yourself below.
			</p>
		{/if}

		{#if c}
			<section class="space-y-2">
				<h2 class="font-semibold">What was read</h2>
				<p class="text-sm text-zinc-400">
					Fields marked "check" were read with low confidence. Compare them with the photo.
				</p>
				<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm" data-testid="candidate">
					<dt class="text-zinc-400">Manufacturer</dt>
					<dd class={low('manufacturer') ? 'text-amber-300' : ''}>
						{c.manufacturer ?? '—'}{#if low('manufacturer')}<span
								class="ml-1"
								data-low="manufacturer">(check)</span
							>{/if}
					</dd>
					<dt class="text-zinc-400">Product line</dt>
					<dd>{c.product_line ?? '—'}</dd>
					<dt class="text-zinc-400">Model code</dt>
					<dd class={['font-mono', low('model_code') && 'text-amber-300']}>
						{c.model_code ?? '—'}{#if low('model_code')}<span
								class="ml-1 font-sans"
								data-low="model_code">(check)</span
							>{/if}
					</dd>
					<dt class="text-zinc-400">Name</dt>
					<dd class={low('name') ? 'text-amber-300' : ''}>
						{c.name ?? '—'}{#if low('name')}<span class="ml-1" data-low="name">(check)</span>{/if}
					</dd>
					<dt class="text-zinc-400">Loading type</dt>
					<dd class={low('loading_type') ? 'text-amber-300' : ''}>
						{CANDIDATE_LOADING[c.loading_type]}{#if low('loading_type')}<span
								class="ml-1"
								data-low="loading_type">(check)</span
							>{/if}
					</dd>
					<dt class="text-zinc-400">Laterality</dt>
					<dd>{LATERALITY_LABELS[c.laterality] ?? c.laterality}</dd>
					<dt class="text-zinc-400">Starting resistance</dt>
					<dd>{c.starting_resistance_lb == null ? '—' : `${c.starting_resistance_lb} lb`}</dd>
					<dt class="text-zinc-400">Stack</dt>
					<dd>{c.stack_lb == null ? '—' : `${c.stack_lb} lb`}</dd>
					<dt class="text-zinc-400">Placard text</dt>
					<dd class="whitespace-pre-wrap">{c.placard_text || '—'}</dd>
					<dt class="text-zinc-400">Notes</dt>
					<dd>{c.notes || '—'}</dd>
				</dl>
			</section>
		{/if}

		{#if data.matching}
			<form method="POST" action="?/link" class="space-y-3 rounded border border-zinc-700 p-4">
				<h2 class="font-semibold">Link an existing model</h2>
				<p class="text-sm text-zinc-400" data-testid="match-method">
					{METHOD_TEXT[data.matching.method]}
				</p>
				{#if data.matching.matches.length}
					<fieldset class="space-y-2">
						<legend class="sr-only">Matching models</legend>
						{#each data.matching.matches as m (m.id)}
							<label class="flex items-start gap-2">
								<input
									type="radio"
									name="modelId"
									value={m.id}
									required
									checked={m.id === data.matching.preselectedId}
									class="mt-1"
								/>
								<span
									>{[m.manufacturer, m.code, m.name].filter(Boolean).join(' ')}
									<span class="text-xs text-zinc-400"
										>· {LOADING_TYPE_LABELS[m.loadingType] ?? m.loadingType} · {confidenceBadge(
											m,
											data.userId
										).label}{#if data.matching.method === 'prefix'}
											· prefix match{/if}</span
									></span
								>
							</label>
						{/each}
					</fieldset>
					<label class="block"
						>Local label (optional)<input
							name="localLabel"
							maxlength="120"
							placeholder="Blank: named after the model"
							class="mt-1 block w-full rounded bg-zinc-800 p-2"
						/></label
					>
					<div class="grid grid-cols-2 gap-3">
						<label class="block"
							>Stack (lb, optional)<input
								name="stackLb"
								type="number"
								min="1"
								max="2000"
								step="1"
								inputmode="numeric"
								placeholder="Blank: the model's standard stack"
								value={c?.stack_lb ?? ''}
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
					<button class="rounded bg-indigo-600 px-4 py-2">Link to {data.gym.name}</button>
				{/if}
			</form>
		{/if}

		<form method="POST" action="?/create" class="space-y-3 rounded border border-zinc-700 p-4">
			<h2 class="font-semibold">Create my own model</h2>
			<p class="text-sm text-zinc-400">
				Prefilled from the photo. Correct anything that is wrong; the model is yours and marked user
				entered.
			</p>
			<label class="block"
				>Manufacturer<input
					name="manufacturer"
					required
					maxlength="120"
					value={c?.manufacturer ?? ''}
					class="mt-1 block w-full rounded bg-zinc-800 p-2"
				/></label
			>
			<label class="block"
				>Model name<input
					name="name"
					required
					maxlength="120"
					value={c?.name ?? ''}
					class="mt-1 block w-full rounded bg-zinc-800 p-2"
				/></label
			>
			<div class="grid grid-cols-2 gap-3">
				<label class="block"
					>Model code (optional)<input
						name="code"
						maxlength="120"
						value={c?.model_code ?? ''}
						class="mt-1 block w-full rounded bg-zinc-800 p-2 font-mono"
					/></label
				>
				<label class="block"
					>Product line (optional)<input
						name="productLine"
						maxlength="120"
						value={c?.product_line ?? ''}
						class="mt-1 block w-full rounded bg-zinc-800 p-2"
					/></label
				>
			</div>
			<label class="block"
				>Loading type<select
					name="loadingType"
					required
					class="mt-1 block w-full rounded bg-zinc-800 p-2"
					><option value="">Choose</option
					>{#each Object.entries(LOADING_TYPE_LABELS) as [value, label] (value)}<option
							{value}
							selected={value === data.candidateLoadingType}>{label}</option
						>{/each}</select
				></label
			>
			<label class="block"
				>Laterality<select name="laterality" class="mt-1 block w-full rounded bg-zinc-800 p-2"
					>{#each Object.entries(LATERALITY_LABELS) as [value, label] (value)}<option
							{value}
							selected={value === (c?.laterality ?? 'unknown')}>{label}</option
						>{/each}</select
				></label
			>
			<div class="grid grid-cols-2 gap-3">
				<label class="block"
					>Starting resistance (lb, optional)<input
						name="startingResistance"
						type="number"
						min="0"
						max="2000"
						step="0.5"
						value={c?.starting_resistance_lb ?? ''}
						class="mt-1 block w-full rounded bg-zinc-800 p-2"
					/></label
				>
				<label class="block"
					>Basis<select
						name="startingResistanceBasis"
						class="mt-1 block w-full rounded bg-zinc-800 p-2"
						><option value="">—</option><option value="total">Total</option><option value="per_arm"
							>Per arm</option
						></select
					></label
				>
			</div>
			<label class="block"
				>Notes (optional)<textarea
					name="notes"
					maxlength="2000"
					rows="2"
					class="mt-1 block w-full rounded bg-zinc-800 p-2">{c?.notes ?? ''}</textarea
				></label
			>
			<label class="block"
				>Local label (optional)<input
					name="localLabel"
					maxlength="120"
					placeholder="Blank: named after the model"
					class="mt-1 block w-full rounded bg-zinc-800 p-2"
				/></label
			>
			<div class="grid grid-cols-2 gap-3">
				<label class="block"
					>Stack (lb, optional)<input
						name="stackLb"
						type="number"
						min="1"
						max="2000"
						step="1"
						inputmode="numeric"
						value={c?.stack_lb ?? ''}
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
			<button class="rounded bg-indigo-600 px-4 py-2">Create my own model</button>
		</form>

		<form method="POST" action="?/analyze" class="space-y-3 rounded border border-zinc-700 p-4">
			<h2 class="font-semibold">Read the photo again</h2>
			<label class="block"
				>Note for the reader (optional)<input
					name="note"
					maxlength="200"
					placeholder="e.g. the code is on the seat post"
					class="mt-1 block w-full rounded bg-zinc-800 p-2"
				/></label
			>
			<button class="rounded border border-indigo-600 px-4 py-2">Re-analyze</button>
		</form>

		<form method="POST" action="?/discard">
			<button class="rounded border border-red-700 px-4 py-2 text-red-300"
				>Discard this photo</button
			>
		</form>
	{/if}
</div>
