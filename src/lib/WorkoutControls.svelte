<script lang="ts">
	import { workoutLayouts, type WorkoutLayoutPreferences } from '$lib/workout-layout.svelte';
	let {
		preferences,
		editing = $bindable(false),
		ended = false
	}: { preferences: WorkoutLayoutPreferences; editing?: boolean; ended?: boolean } = $props();
	let open = $state(false);
</script>

<div class="workout-controls">
	<label
		>View<select
			aria-label="Workout layout"
			bind:value={preferences.layout}
			onchange={() => preferences.save()}
			>{#each workoutLayouts as [value, label]}<option {value}>{label}</option>{/each}</select
		></label
	>
	<button
		type="button"
		aria-label="Customize workout view"
		aria-expanded={open}
		onclick={() => (open = !open)}>Customize</button
	>
	{#if !ended}<button type="button" aria-expanded={editing} onclick={() => (editing = !editing)}
			>{editing ? 'Done editing' : 'Edit workout'}</button
		>{/if}
</div>
{#if open}
	<section class="customize" aria-label="Workout display settings">
		<h2>Your view of this program</h2>
		<label
			>RIR field<select
				aria-label="RIR field"
				bind:value={preferences.rir}
				onchange={() => preferences.save()}
				><option value="program">Follow program</option><option value="show">Always show</option
				><option value="hide">Hide</option></select
			></label
		>
		<p>Reps in reserve: how many more reps you could have done. Hidden fields keep their values.</p>
		{#each [['notes', 'Set notes'], ['history', 'Previous performance'], ['steppers', 'Weight and reps +/− buttons']] as const as [field, label]}<label
				class="check"
				>{label}<input
					type="checkbox"
					bind:checked={preferences[field]}
					onchange={() => preferences.save()}
				/></label
			>{/each}
		<p>Saved for your account and this program in this browser.</p>
		{#if !preferences.storageAvailable}<p role="status">
				Preferences work here, but this browser cannot remember them after you leave.
			</p>{/if}
		<button type="button" onclick={() => (open = false)}>Done customizing</button>
	</section>
{/if}

<style>
	.workout-controls {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		align-items: end;
		margin: 16px 0 22px;
	}
	label {
		font-size: 12px;
		color: #a1afa6;
		display: flex;
		gap: 8px;
		align-items: center;
		justify-content: space-between;
	}
	select,
	button {
		min-height: 44px;
		border: 1px solid #34453c;
		border-radius: 10px;
		padding: 8px 10px;
		background: #15201a;
		color: #edf5ef;
		font-size: 14px;
		max-width: 100%;
	}
	.customize {
		padding: 18px;
		background: #141d18;
		border: 1px solid #34453c;
		border-radius: 16px;
		margin-bottom: 20px;
	}
	h2 {
		font-size: 18px;
		font-weight: 600;
		margin-bottom: 14px;
	}
	.customize label {
		font-size: 14px;
		min-height: 54px;
		flex-wrap: wrap;
	}
	p {
		font-size: 12px;
		line-height: 1.5;
		color: #a1afa6;
		margin: 8px 0 14px;
	}
	input {
		width: 22px;
		height: 22px;
		accent-color: #8cdbad;
	}
</style>
