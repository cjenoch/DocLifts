<script lang="ts">
	import { defaultMachineLabel } from '$lib/catalog-labels';
	import type { ActionData, PageData } from './$types';
	import { pageTitle } from '$lib/app-shell';
	import { machineAdminUi as ui } from '$lib/machine-admin-ui';
	let { data, form }: { data: PageData; form: ActionData } = $props();
	const m = $derived(data.machine);
	const fallback = $derived(data.model ? defaultMachineLabel(data.model) : null);
	const modelLabel = (x: { manufacturer: string; code: string | null; name: string }) =>
		[x.manufacturer, x.code, x.name].filter(Boolean).join(' ');
	const replaceModel = $derived(
		form && 'replaceModelId' in form
			? { id: form.replaceModelId, label: form.replaceLabel ?? '' }
			: null
	);
	const fmt = (d: Date | string | null) =>
		d ? new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
</script>

<svelte:head><title>{pageTitle('Edit machine')}</title></svelte:head>

<div class="mx-auto max-w-lg space-y-5 p-4">
	<a href={`/gyms?gym=${data.gym.id}`} class="text-indigo-300">← {data.gym.name}</a>
	<h1 class="text-2xl font-semibold">Edit machine</h1>
	<p class="text-zinc-300">
		{m.equipmentType} ·
		{#if data.model}<a href={`/equipment/${data.model.id}`} class="text-indigo-300"
				>{modelLabel(data.model)}</a
			>{:else}{ui.noModel}{/if}
	</p>
	{#if m.archivedAt}<p class="text-amber-300" data-testid="archived-note">{ui.archivedNote}</p>{/if}
	{#if form && 'message' in form && form.message}<p role="status" class="text-amber-300">
			{form.message}
		</p>{/if}

	<form method="POST" action="?/update" class="space-y-3 rounded border border-zinc-700 p-4">
		<label class="block"
			>{fallback ? 'Local label (optional)' : 'Local label'}<input
				name="localLabel"
				maxlength="120"
				required={!fallback}
				value={m.localLabel}
				placeholder={fallback ?? 'e.g. Press near window'}
				autocapitalize="words"
				autocomplete="off"
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
		<button class="min-h-11 rounded bg-indigo-600 px-4 py-2">Save</button>
	</form>
	<p class="text-sm text-zinc-400">
		History stays with the machine: renaming it does not change any logged set.
	</p>

	{#if !m.archivedAt}
		<!-- Part H: change the model in place (same type), or replace (another type). -->
		<details class="rounded border border-zinc-700 p-4" open={!!data.q || !!form}>
			<summary class="min-h-11 cursor-pointer font-semibold">{ui.changeModel}</summary>
			<p class="mt-2 text-sm text-zinc-400">{ui.changeModelIntro}</p>
			{#if form && 'stackOffer' in form && form.stackOffer}
				<form method="POST" action="?/applyStack" class="mt-3">
					<button class="min-h-11 rounded border border-indigo-500 px-3 text-indigo-200"
						>{ui.stackOffer(form.stackOffer)}</button
					>
				</form>
			{:else if form && 'changed' in form}
				<p class="mt-3 text-emerald-300" role="status">{ui.modelChanged}</p>
			{/if}
			{#if form && 'stackApplied' in form}<p class="mt-3 text-emerald-300" role="status">
					{ui.stackApplied(form.stackApplied)}
				</p>{/if}
			{#if replaceModel}
				<form method="POST" action="?/replace" class="mt-3 space-y-2" data-testid="replace">
					<p class="text-amber-300">{ui.replaceExplain(replaceModel.label)}</p>
					<input type="hidden" name="modelId" value={replaceModel.id} />
					<button class="min-h-11 rounded bg-amber-600 px-3 font-semibold text-white"
						>{ui.replaceButton}</button
					>
				</form>
			{/if}
			<form method="GET" class="mt-3 flex gap-2">
				<input
					name="q"
					type="search"
					value={data.q}
					maxlength="120"
					placeholder={ui.searchPlaceholder}
					aria-label={ui.searchPlaceholder}
					autocomplete="off"
					autocapitalize="none"
					spellcheck="false"
					class="min-w-0 flex-1 rounded bg-zinc-800 p-2"
				/>
				<button class="min-h-11 rounded border border-indigo-600 px-3">{ui.search}</button>
			</form>
			<ul class="mt-3 space-y-1">
				{#each data.models as model (model.id)}
					<li>
						<form method="POST" action="?/changeModel">
							<input type="hidden" name="modelId" value={model.id} />
							<button
								class="min-h-11 w-full rounded px-2 text-left text-indigo-200 active:bg-zinc-800"
								disabled={model.id === m.equipmentModelId}
								>{modelLabel(model)}<span class="text-zinc-500">
									· {model.loadingType}</span
								></button
							>
						</form>
					</li>
				{/each}
				{#if data.model}
					<li>
						<form method="POST" action="?/changeModel">
							<input type="hidden" name="modelId" value="" />
							<button
								class="min-h-11 w-full rounded px-2 text-left text-zinc-300 active:bg-zinc-800"
								>{ui.noModel}</button
							>
						</form>
					</li>
				{/if}
			</ul>
		</details>

		<!-- Part K: two rows for one machine. -->
		{#if data.undoable}
			<form method="POST" action="?/undoMerge" class="rounded border border-zinc-700 p-4">
				<input type="hidden" name="mergeId" value={data.undoable.merge.id} />
				<p class="text-sm text-zinc-400">
					{ui.mergedFrom(data.undoable.droppedLabel, fmt(data.undoable.merge.createdAt))}
				</p>
				<button class="mt-2 min-h-11 rounded border border-zinc-600 px-3">{ui.undoMerge}</button>
			</form>
		{/if}
		{#if data.candidates.length}
			<details class="rounded border border-zinc-700 p-4" open={!!data.mergeWith}>
				<summary class="min-h-11 cursor-pointer font-semibold">{ui.sameMachineAs}</summary>
				{#if data.mergeWith && data.preview}
					<form method="POST" action="?/merge" class="mt-3 space-y-3" data-testid="merge-preview">
						<input type="hidden" name="otherId" value={data.mergeWith.id} />
						<p>
							{ui.mergeMoves(
								data.preview.sets,
								data.preview.workouts,
								data.preview.photos,
								fmt(data.preview.from),
								fmt(data.preview.to)
							)}
						</p>
						{#if data.preview.formatsDiffer}<p class="text-amber-300">{ui.formatsDiffer}</p>{/if}
						<fieldset class="space-y-2">
							<legend class="text-sm text-zinc-400">{ui.keepWhich}</legend>
							{#each [m, data.mergeWith] as row (row.id)}
								<label class="flex min-h-11 items-center gap-3">
									<input
										type="radio"
										name="keptId"
										value={row.id}
										checked={row.id === data.preview.suggestedKeptId}
										class="size-5"
									/>{row.localLabel}
								</label>
							{/each}
						</fieldset>
						<button class="min-h-11 rounded bg-indigo-600 px-4 font-semibold"
							>{ui.mergeButton}</button
						>
					</form>
				{:else}
					<p class="mt-2 text-sm text-zinc-400">{ui.sameMachineIntro}</p>
					<ul class="mt-2">
						{#each data.candidates as c (c.id)}
							<li>
								<a
									href={`?merge=${c.id}`}
									class="flex min-h-11 items-center text-indigo-200"
									data-sveltekit-noscroll>{c.localLabel}</a
								>
							</li>
						{/each}
					</ul>
				{/if}
			</details>
		{/if}

		<!-- Part G: one button, two outcomes; the server decides and the text says which. -->
		{#if data.removal}
			<details class="rounded border border-red-900 p-4">
				<summary class="min-h-11 cursor-pointer font-semibold text-red-300"
					>{ui.removeMachine}</summary
				>
				{#if data.removal.blocked}
					<p class="mt-2 text-amber-300">{ui.finishFirst}</p>
				{:else}
					<form method="POST" action="?/remove" class="mt-2 space-y-2">
						<p data-testid="removal-text">
							{data.removal.outcome === 'delete' ? ui.machineDeleteText : ui.machineArchiveText}
						</p>
						<button class="min-h-11 rounded bg-red-700 px-4 font-semibold text-white"
							>{ui.removeConfirm}</button
						>
					</form>
				{/if}
			</details>
		{/if}
	{/if}
</div>
