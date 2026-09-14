<script lang="ts">
	import { requestId as newRequestId } from '$lib/request-id';
	import { enhance } from '$app/forms';
	import { onMount, tick } from 'svelte';
	import type { PageData } from '../routes/sessions/[id]/$types';
	let { choices, open = $bindable(false) }: { choices: PageData['choices']; open?: boolean } =
		$props();
	let query = $state('');
	let exerciseId = $state('');
	let creating = $state(false);
	let equipment = $state('dumbbell');
	let gymId = $state('');
	let machineId = $state('');
	let newGym = $state(false);
	let newMachine = $state(false);
	let busy = $state(false);
	let message = $state('');
	let requestId = $state('');
	const types = [
		'dumbbell',
		'barbell',
		'barbell-ez',
		'machine-plate',
		'machine-stack',
		'cable',
		'smith',
		'bodyweight',
		'band'
	];
	const label = (v: string) =>
		({
			'machine-plate': 'Plate-loaded machine',
			'machine-stack': 'Weight-stack machine',
			'barbell-ez': 'EZ bar'
		})[v] ?? v.charAt(0).toUpperCase() + v.slice(1);
	const matches = $derived(
		choices.exercises.filter((e) => e.name.toLowerCase().includes(query.toLowerCase()))
	);
	const machines = $derived(
		choices.machines.filter((m) => m.gymId === gymId && m.equipmentType === equipment)
	);
	onMount(() => {
		requestId = newRequestId();
		try {
			const last = localStorage.getItem('doclifts:last-gym');
			if (choices.gyms.some((g) => g.id === last)) gymId = last!;
		} catch {
			/* Preferences are optional. */
		}
	});
	function choose(id: string) {
		exerciseId = id;
		equipment = choices.exercises.find((e) => e.id === id)!.equipmentType;
		machineId = '';
		creating = false;
	}
</script>

<section class="add-exercise" id="add-workout-exercise">
	<button class="add-trigger" onclick={() => (open = !open)} aria-expanded={open}
		>{open ? 'Close exercise picker' : '+ Add exercise'}</button
	>
	{#if open}
		<div class="picker">
			<h2>Add to this workout</h2>
			<p class="muted">Your program stays unchanged.</p>
			{#if !exerciseId && !creating}
				<label
					>Find an exercise<input
						type="search"
						placeholder="Search exercises…"
						bind:value={query}
					/></label
				>
				<div class="results">
					{#each matches as exercise}<button onclick={() => choose(exercise.id)}
							><span>{exercise.name}</span><small>{label(exercise.equipmentType)}</small></button
						>{/each}
					{#if !matches.length}<p class="muted">No matching exercises. Create one below.</p>{/if}
				</div>
				<button
					class="secondary"
					onclick={() => {
						creating = true;
						equipment = 'dumbbell';
						machineId = '';
					}}>+ Create an exercise</button
				>
			{:else}
				<form
					method="POST"
					action="?/addExercise"
					use:enhance={() => {
						busy = true;
						message = '';
						return async ({ result, update }) => {
							try {
								if (result.type === 'success' && result.data?.addedExerciseId) {
									try {
										if (gymId) localStorage.setItem('doclifts:last-gym', gymId);
									} catch {
										/* Optional preference. */
									}
									await update({ reset: false });
									await tick();
									gymId =
										choices.machines.find((m) => m.id === result.data?.addedMachineId)?.gymId ??
										gymId;
									newGym = false;
									newMachine = false;
									machineId = '';
									try {
										if (gymId) localStorage.setItem('doclifts:last-gym', gymId);
									} catch {
										/* Optional preference. */
									}
									open = false;
									exerciseId = '';
									creating = false;
									requestId = newRequestId();
									await tick();
									document
										.getElementById(`exercise-${result.data.addedExerciseId}`)
										?.scrollIntoView({ behavior: 'smooth', block: 'start' });
								} else {
									message =
										result.type === 'failure'
											? String(result.data?.message ?? 'Check your choices and try again.')
											: 'Could not add exercise. Your entries are still here; try again.';
								}
							} finally {
								busy = false;
							}
						};
					}}
				>
					<fieldset disabled={busy}>
						<input type="hidden" name="requestId" value={requestId} />
						<input type="hidden" name="exerciseId" value={exerciseId} />
						<button
							type="button"
							class="back"
							onclick={() => {
								exerciseId = '';
								creating = false;
							}}>← Choose another exercise</button
						>
						{#if creating}
							<label
								>Exercise name<input
									name="exerciseName"
									value={query}
									required
									maxlength="120"
								/></label
							>
							<label
								>Equipment type<select
									name="equipmentType"
									bind:value={equipment}
									onchange={() => (machineId = '')}
									>{#each types as type}<option value={type}>{label(type)}</option>{/each}</select
								></label
							>
						{:else}
							<h3>{choices.exercises.find((e) => e.id === exerciseId)?.name}</h3>
							<input type="hidden" name="equipmentType" value={equipment} />
						{/if}
						{#if newGym || !choices.gyms.length}
							<label
								>Gym name<input
									name="newGymName"
									required
									maxlength="120"
									placeholder="e.g. Sunrise Center or Home"
								/></label
							>
							{#if choices.gyms.length}<button
									type="button"
									class="back"
									onclick={() => (newGym = false)}>Use an existing gym</button
								>{/if}
						{:else}
							<label
								>Gym<select
									name="gymId"
									bind:value={gymId}
									required
									onchange={() => {
										machineId = '';
										newMachine = false;
									}}
									><option value="">Choose gym</option>{#each choices.gyms as gym}<option
											value={gym.id}>{gym.name}</option
										>{/each}</select
								></label
							>
							<button
								type="button"
								class="back"
								onclick={() => {
									newGym = true;
									machineId = '';
								}}>+ New gym</button
							>
						{/if}
						{#if newGym || !choices.gyms.length || newMachine || !machines.length}
							<label
								>Equipment name<input
									name="newMachineName"
									required
									maxlength="120"
									placeholder={equipment === 'dumbbell'
										? 'e.g. Dumbbells'
										: 'e.g. Leg press by the window'}
								/></label
							>
							<p class="muted">Saved for next time. Use a name you’ll recognize.</p>
							{#if machines.length && !newGym}<button
									type="button"
									class="back"
									onclick={() => (newMachine = false)}>Use existing equipment</button
								>{/if}
						{:else}
							<label
								>Equipment<select name="gymEquipmentId" bind:value={machineId} required
									><option value="">Choose equipment</option>{#each machines as m}<option
											value={m.id}>{m.localLabel}</option
										>{/each}</select
								></label
							>
							<button type="button" class="back" onclick={() => (newMachine = true)}
								>+ New equipment</button
							>
						{/if}
						<label
							>How do you record weight?<select name="loadConvention" required>
								<option value="">Choose weight format</option>
								{#if equipment === 'machine-plate'}<option value="plates_per_side"
										>Plates per side</option
									><option value="total_plates">All plates combined</option>{/if}
								<option value="per_arm">Per hand / arm</option><option value="displayed"
									>Total or displayed weight</option
								><option value="unknown">Not sure — keep separate</option>
							</select></label
						>
						<label
							>Sets<input
								name="setCount"
								type="number"
								value="2"
								min="1"
								max="10"
								required
							/></label
						>
						<details>
							<summary>Rep targets and progression</summary>
							<div class="pair">
								<label
									>Min reps<input
										name="repsMin"
										type="number"
										value="8"
										min="0"
										max="100"
										required
									/></label
								><label
									>Max reps<input
										name="repsMax"
										type="number"
										value="12"
										min="0"
										max="100"
										required
									/></label
								>
							</div>
							<label
								>Reps in reserve<input
									name="rir"
									type="number"
									value="1"
									min="0"
									max="10"
									required
								/></label
							>
							<label
								>Exercise role<select name="tier"
									><option value="secondary">Secondary lift</option><option value="isolation"
										>Isolation</option
									><option value="main">Main lift (top set + backoffs)</option></select
								></label
							>
							<label
								>Progression<select name="progressionPolicy"
									><option value="standard">Suggest increases</option><option value="cautious"
										>Cautious — increase manually</option
									><option value="hold">Keep load steady</option></select
								></label
							>
							{#if creating}<label class="check"
									><input type="checkbox" name="isLowerBody" value="1" /> Lower-body exercise (larger
									suggested increments)</label
								>{/if}
						</details>
						{#if message}<p role="alert" class="error">{message}</p>{/if}
						<button class="primary" disabled={busy || !requestId}
							>{busy ? 'Adding…' : 'Add to workout'}</button
						>
					</fieldset>
				</form>
			{/if}
		</div>
	{/if}
</section>

<style>
	.add-exercise {
		margin: 1.5rem 0;
	}
	button,
	input,
	select {
		min-height: 46px;
	}
	button {
		cursor: pointer;
	}
	.add-trigger {
		width: 100%;
		border: 1px dashed #5b6982;
		border-radius: 14px;
		color: #c7d2fe;
		font-weight: 650;
		background: #151c2a;
	}
	.picker {
		padding: 20px;
		margin-top: 12px;
		border: 1px solid #334155;
		border-radius: 16px;
		background: #111827;
	}
	h2 {
		font-size: 20px;
		font-weight: 650;
	}
	h3 {
		font-size: 18px;
		font-weight: 650;
		margin: 12px 0;
	}
	.muted,
	small {
		color: #a3afc2;
		font-size: 13px;
	}
	label {
		display: block;
		font-size: 14px;
		color: #d5deeb;
		margin-top: 14px;
	}
	input:not([type='checkbox']):not([type='hidden']),
	select {
		display: block;
		width: 100%;
		margin-top: 6px;
		padding: 10px 12px;
		border: 1px solid #475569;
		background: #0b1220;
		border-radius: 9px;
		color: #f1f5f9;
		font-size: 16px;
	}
	.results {
		max-height: 280px;
		overflow: auto;
		margin: 12px 0;
	}
	.results button {
		display: flex;
		flex-direction: column;
		align-items: start;
		text-align: left;
		width: 100%;
		padding: 12px;
		border-bottom: 1px solid #273449;
	}
	.results button:hover {
		background: #202c40;
	}
	.primary,
	.secondary {
		width: 100%;
		padding: 12px;
		border-radius: 10px;
		margin-top: 16px;
		font-weight: 650;
	}
	.primary {
		background: #c7d2fe;
		color: #182044;
	}
	.secondary {
		border: 1px solid #475569;
	}
	.back {
		color: #c7d2fe;
		font-size: 14px;
		text-align: left;
	}
	.pair {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 12px;
	}
	details {
		margin-top: 18px;
	}
	summary {
		cursor: pointer;
		padding: 12px 0;
		color: #c7d2fe;
	}
	.error {
		color: #fda4af;
		margin-top: 12px;
	}
	fieldset {
		min-width: 0;
	}
	:disabled {
		opacity: 0.65;
	}
	.check {
		display: flex;
		gap: 10px;
		align-items: center;
	}
</style>
