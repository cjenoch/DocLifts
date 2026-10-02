<script lang="ts">
	import type { PageData, ActionData } from './$types';
	import { appShell, pageTitle } from '$lib/app-shell';
	import { machineAdminUi as ui } from '$lib/machine-admin-ui';
	let { data, form }: { data: PageData; form: ActionData } = $props();
	const scopeText = $derived(
		data.scope === 'search'
			? `${data.models.length} matching "${data.q}" across all manufacturers`
			: data.scope === 'all'
				? `${data.models.length} models from all manufacturers`
				: data.gymManufacturers.length
					? `${data.models.length} models from this gym's manufacturers (${data.gymManufacturers.join(', ')})`
					: 'No machines with a known model in this gym yet: search, or show all manufacturers'
	);
</script>

<svelte:head><title>{pageTitle('Gyms')}</title></svelte:head>

<div class="mx-auto max-w-lg space-y-6 p-4">
	<h1 class="text-2xl font-semibold">Gyms</h1>
	<p>
		Each named machine has its own history—even when two gyms have the same model. Known models come
		from the <a href="/equipment" class="text-indigo-300">equipment catalog</a> or from what you enter
		yourself.
	</p>
	<a
		href="/equipment"
		class="flex min-h-11 items-center justify-between rounded-lg border border-zinc-700 bg-zinc-900 px-4 font-semibold text-indigo-200 active:bg-zinc-800"
		>Equipment catalog <span aria-hidden="true">→</span></a
	>
	{#if data.gyms.length === 0}<p class="text-zinc-400" data-testid="empty-state">
			{appShell.empty.gyms}
		</p>{/if}
	{#if form?.message}<p role="status" class="text-amber-300">{form.message}</p>{/if}
	{#if data.removed}<p role="status" class="text-emerald-300" data-testid="removed">
			{ui.removed(data.removed)}
		</p>{/if}
	<form method="POST" action="?/createGym" class="space-y-3 rounded border border-zinc-700 p-4">
		<h2 class="font-semibold">Create a gym</h2>
		<label class="block"
			>Gym name<input
				name="name"
				required
				maxlength="120"
				class="block w-full rounded bg-zinc-800 p-2"
			/></label
		>
		<button class="rounded bg-indigo-600 px-4 py-2">Create gym</button>
	</form>
	<section class="space-y-3 rounded border border-zinc-700 p-4">
		<h2 class="font-semibold">Add a physical machine</h2>
		<form method="GET" class="space-y-2" aria-label="Find a known model">
			<label class="block"
				>Models for gym<select name="gym" class="block w-full rounded bg-zinc-800 p-2"
					>{#each data.gyms as gym}<option value={gym.id} selected={gym.id === data.selectedGymId}
							>{gym.name}</option
						>{/each}</select
				></label
			>
			<label class="block"
				>Search models by name or code<input
					name="q"
					type="search"
					maxlength="120"
					value={data.q}
					placeholder="e.g. IL-ROW"
					class="block w-full rounded bg-zinc-800 p-2"
				/></label
			>
			<button class="rounded border border-indigo-600 px-3 py-1">Show models</button>
		</form>
		<p class="text-sm text-zinc-400" data-testid="model-scope">{scopeText}</p>
		{#if data.scope === 'gym'}
			<a href={`/gyms?gym=${data.selectedGymId}&all=1`} class="text-sm text-indigo-300"
				>Show all manufacturers</a
			>
		{:else}
			<a href={`/gyms?gym=${data.selectedGymId}`} class="text-sm text-indigo-300"
				>Only this gym's manufacturers</a
			>
		{/if}
	</section>
	<form method="POST" action="?/createMachine" class="space-y-3 rounded border border-zinc-700 p-4">
		<label class="block"
			>Gym<select name="gymId" required class="block w-full rounded bg-zinc-800 p-2"
				><option value="">Choose a gym</option>{#each data.gyms as gym}<option
						value={gym.id}
						selected={gym.id === data.selectedGymId}>{gym.name}</option
					>{/each}</select
			></label
		>
		<label class="block"
			>Local machine label (optional with a model)<input
				name="localLabel"
				maxlength="120"
				placeholder="e.g. Press near window"
				aria-describedby="label-hint"
				class="block w-full rounded bg-zinc-800 p-2"
			/></label
		>
		<p id="label-hint" class="text-sm text-zinc-400">
			Leave it blank and the machine is named after its model, e.g. "Hammer Strength Iso-Lateral Row
			(IL-ROW)". With no model, give it a label.
		</p>
		<label class="block"
			>Equipment type<select
				name="equipmentType"
				required
				class="block w-full rounded bg-zinc-800 p-2"
				>{#each ['machine-plate', 'machine-stack', 'cable', 'dumbbell', 'barbell', 'barbell-ez', 'smith', 'bodyweight', 'band'] as type}<option
						value={type}>{type}</option
					>{/each}</select
			></label
		>
		<label class="block"
			>Known model (optional)<select
				name="equipmentModelId"
				class="block w-full rounded bg-zinc-800 p-2"
				><option value="">Unknown / enter below</option
				>{#each data.models as model (model.id)}<option value={model.id}
						>{[model.manufacturer, model.code, model.name].filter(Boolean).join(' ')}</option
					>{/each}</select
			></label
		>
		<p class="text-sm text-zinc-400">
			Unknown model is fine. Or enter both fields below as your own unverified description.
		</p>
		<label class="block"
			>Manufacturer (optional)<input
				name="manufacturer"
				maxlength="120"
				class="block w-full rounded bg-zinc-800 p-2"
			/></label
		>
		<label class="block"
			>Model name (optional)<input
				name="modelName"
				maxlength="120"
				class="block w-full rounded bg-zinc-800 p-2"
			/></label
		>
		<button class="rounded bg-indigo-600 px-4 py-2">Add machine</button>
	</form>
	{#each data.gyms as gym}
		<section>
			<h2 class="font-semibold">{gym.name}</h2>
			<a href={`/gyms/${gym.id}/equipment/photo`} class="text-sm text-indigo-300"
				>Add a machine from a photo</a
			>
			<ul>
				{#each data.machines.filter((m) => m.gymId === gym.id) as machine}<li
						class="mt-2 flex items-center gap-2"
					>
						{#if data.photos[machine.id]}<img
								src={`/photos/${data.photos[machine.id]}/image`}
								alt=""
								width="48"
								height="48"
								loading="lazy"
								class="h-12 w-12 rounded object-cover"
							/>{/if}
						{machine.localLabel} · {machine.equipmentType} ·
						{#if machine.equipmentModelId}<a
								href={`/equipment/${machine.equipmentModelId}`}
								class="text-indigo-300">model</a
							>{:else}Unknown model{/if} ·
						<a
							href={`/gyms/${gym.id}/machines/${machine.id}/edit`}
							aria-label={`Edit ${machine.localLabel}`}
							class="text-indigo-300">Edit</a
						>
					</li>{/each}
			</ul>
			{#if data.archived.machines.some((m) => m.gymId === gym.id)}
				<details class="mt-3" data-testid="archived-machines">
					<summary class="min-h-11 cursor-pointer text-sm text-zinc-400">{ui.archived}</summary>
					<ul>
						{#each data.archived.machines.filter((m) => m.gymId === gym.id) as machine (machine.id)}
							<li class="flex min-h-11 items-center justify-between gap-2">
								<span class="text-zinc-400">{machine.localLabel}</span>
								{#if !machine.mergedIntoId}<form method="POST" action="?/restoreMachine">
										<input type="hidden" name="gymId" value={gym.id} />
										<input type="hidden" name="machineId" value={machine.id} />
										<button class="min-h-11 px-2 text-indigo-300">{ui.restore}</button>
									</form>{/if}
							</li>
						{/each}
					</ul>
				</details>
			{/if}
			{#if data.removal[gym.id]}
				<details class="mt-3">
					<summary class="min-h-11 cursor-pointer text-sm text-red-300">{ui.removeGym}</summary>
					{#if data.removal[gym.id]?.blocked}
						<p class="text-amber-300">{ui.finishFirst}</p>
					{:else}
						<form method="POST" action="?/removeGym" class="space-y-2">
							<input type="hidden" name="gymId" value={gym.id} />
							<p>
								{data.removal[gym.id]?.outcome === 'delete' ? ui.gymDeleteText : ui.gymArchiveText}
							</p>
							<button class="min-h-11 rounded bg-red-700 px-4 font-semibold text-white"
								>{ui.removeConfirm}</button
							>
						</form>
					{/if}
				</details>
			{/if}
		</section>
	{/each}
	{#if data.archived.gyms.length}
		<details data-testid="archived-gyms">
			<summary class="min-h-11 cursor-pointer text-zinc-400">{ui.archived}</summary>
			<ul>
				{#each data.archived.gyms as gym (gym.id)}
					<li class="flex min-h-11 items-center justify-between gap-2">
						<span class="text-zinc-400">{gym.name}</span>
						<form method="POST" action="?/restoreGym">
							<input type="hidden" name="gymId" value={gym.id} />
							<button class="min-h-11 px-2 text-indigo-300">{ui.restore}</button>
						</form>
					</li>
				{/each}
			</ul>
		</details>
	{/if}
	<p>
		Return to an active workout to select a machine or quick-add an exercise. This does not change a
		program template.
	</p>
</div>
