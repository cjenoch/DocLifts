<script lang="ts">
	let {
		gyms,
		machines,
		equipmentType
	}: {
		gyms: { id: string; name: string }[];
		machines: { id: string; gymId: string; localLabel: string; equipmentType: string }[];
		equipmentType?: string;
	} = $props();
	let gymId = $state('');
	const available = $derived(
		machines.filter(
			(m) => m.gymId === gymId && (!equipmentType || m.equipmentType === equipmentType)
		)
	);
</script>

<label class="block"
	>Gym
	<select
		aria-label="Gym"
		name="gymId"
		bind:value={gymId}
		required
		class="mt-1 block w-full rounded border border-zinc-600 bg-zinc-900 p-2"
	>
		<option value="">Choose a gym</option>
		{#each gyms as gym}<option value={gym.id}>{gym.name}</option>{/each}
	</select>
</label>
<label class="mt-3 block"
	>Machine
	{#key gymId}
		<select
			aria-label="Machine"
			name="gymEquipmentId"
			required
			class="mt-1 block w-full rounded border border-zinc-600 bg-zinc-900 p-2"
		>
			<option value="">Choose a physical machine</option>
			{#each available as machine}<option value={machine.id}>{machine.localLabel}</option>{/each}
		</select>
	{/key}
</label>
<label class="mt-3 block"
	>Load convention
	<select
		aria-label="Load convention"
		name="loadConvention"
		required
		class="mt-1 block w-full rounded border border-zinc-600 bg-zinc-900 p-2"
	>
		<option value="">Choose how you record load</option>
		{#if !equipmentType || equipmentType === 'machine-plate'}
			<option value="plates_per_side">Plates per side</option>
			<option value="total_plates">Total plates (all sides)</option>
		{/if}
		<option value="per_arm">Per arm</option>
		<option value="displayed">Displayed load</option>
		<option value="unknown">Unknown convention (kept separate)</option>
	</select>
</label>
<p class="mt-2 text-xs text-zinc-400">
	Starting resistance is descriptive; no automatic conversion.
</p>
