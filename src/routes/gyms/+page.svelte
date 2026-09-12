<script lang="ts">
	import type { PageData, ActionData } from './$types';
	let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<div class="mx-auto max-w-lg space-y-6 p-4">
	<a href="/" class="text-indigo-300">← Home</a>
	<h1 class="text-2xl font-semibold">Gyms and machines</h1>
	<p>
		Each named machine has its own history—even when two gyms have the same model. Model details are
		user supplied, not a verified catalog.
	</p>
	{#if form?.message}<p role="status" class="text-amber-300">{form.message}</p>{/if}
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
	<form method="POST" action="?/createMachine" class="space-y-3 rounded border border-zinc-700 p-4">
		<h2 class="font-semibold">Add a physical machine</h2>
		<label class="block"
			>Gym<select name="gymId" required class="block w-full rounded bg-zinc-800 p-2"
				><option value="">Choose a gym</option>{#each data.gyms as gym}<option value={gym.id}
						>{gym.name}</option
					>{/each}</select
			></label
		>
		<label class="block"
			>Local machine label<input
				name="localLabel"
				required
				maxlength="120"
				placeholder="e.g. Press near window"
				class="block w-full rounded bg-zinc-800 p-2"
			/></label
		>
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
				><option value="">Unknown / enter below</option>{#each data.models as model}<option
						value={model.id}>{model.manufacturer} {model.name}</option
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
			<ul>
				{#each data.machines.filter((m) => m.gymId === gym.id) as machine}<li class="mt-2">
						{machine.localLabel} · {machine.equipmentType} · {machine.equipmentModelId
							? 'User-supplied model'
							: 'Unknown model'}
					</li>{/each}
			</ul>
		</section>
	{/each}
	<p>
		Return to an active workout to select a machine or quick-add an exercise. This does not change a
		program template.
	</p>
</div>
