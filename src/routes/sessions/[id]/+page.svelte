<script lang="ts">
	import type { ActionData, PageData } from './$types';
	import SetRow from './SetRow.svelte';
	import MachinePicker from '$lib/MachinePicker.svelte';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const unloggedSetCount = $derived.by(() => {
		return data.groups
			.flatMap((group) => group.sets)
			.filter((set) => set.executedLoad == null || set.executedReps == null).length;
	});
</script>

<div class="mx-auto max-w-md px-4 py-6 pb-28">
	<a href="/programs/{data.session.programId}" class="text-sm text-indigo-400 active:underline">
		← Back
	</a>

	<h1 class="mt-2 text-xl font-semibold tracking-tight">{data.day.name}</h1>
	<p class="text-xs text-zinc-500">
		Started {new Date(data.session.startedAt).toLocaleString()}
		{#if data.session.endedAt}
			· ended {new Date(data.session.endedAt).toLocaleString()}
		{/if}
	</p>

	{#if data.session.endedAt}
		<div class="mt-2 flex items-center gap-2 text-xs">
			{#if data.allowEndedSessionEdit}
				<span class="rounded bg-amber-500/20 px-2 py-1 text-amber-300">Editing ended session</span>
				<a href="/sessions/{data.session.id}" class="text-indigo-400 active:underline"
					>Done editing</a
				>
				<form
					method="POST"
					action="?/deleteSession"
					class="ml-auto flex items-center gap-1.5"
					onsubmit={(event) => {
						const input = event.currentTarget.querySelector(
							'input[name="confirmDelete"]'
						) as HTMLInputElement | null;
						const value = input?.value.trim().toLowerCase() ?? '';
						if (value !== 'd') {
							event.preventDefault();
							return;
						}
						if (!confirm('Delete this ended workout? Press OK to confirm (2/3).')) {
							event.preventDefault();
							return;
						}
						if (!confirm('Final confirm (3/3): permanently delete this workout?')) {
							event.preventDefault();
						}
					}}
				>
					<input
						type="text"
						name="confirmDelete"
						maxlength="1"
						placeholder="d"
						autocomplete="off"
						class="w-10 rounded border border-rose-900 bg-zinc-950 px-2 py-1 text-center text-[11px] text-zinc-100"
					/>
					<button
						type="submit"
						class="rounded bg-rose-500/20 px-2 py-1 text-[11px] font-semibold text-rose-300 active:bg-rose-500/30"
					>
						Delete Workout
					</button>
				</form>
			{:else}
				<span class="text-zinc-400">This session is read-only.</span>
				<a href="/sessions/{data.session.id}?edit=1" class="text-indigo-400 active:underline">
					Edit this workout
				</a>
			{/if}
		</div>
	{/if}

	{#if form && 'message' in form && form.message}<p role="alert" class="mt-4 text-amber-300">
			{form.message}
		</p>{/if}
	{#if !data.session.endedAt}
		<a href="/gyms" class="mt-4 block text-indigo-300">Manage gyms and machines</a>
		<details class="mt-4 rounded border border-zinc-700 p-3">
			<summary>Quick-add to this workout only</summary>
			<p class="mt-2 text-sm text-zinc-400">
				Adds sets to this active session. Your program template stays unchanged.
			</p>
			<form method="POST" action="?/addExercise" class="mt-3 space-y-3">
				<label class="block"
					>Existing exercise<select name="exerciseId" class="block w-full rounded bg-zinc-800 p-2"
						><option value="">Create a new exercise below</option
						>{#each data.choices.exercises as exercise}<option value={exercise.id}
								>{exercise.name} ({exercise.equipmentType})</option
							>{/each}</select
					></label
				>
				<label class="block"
					>New exercise name<input
						name="exerciseName"
						maxlength="120"
						class="block w-full rounded bg-zinc-800 p-2"
					/></label
				>
				<label class="block"
					>Canonical movement (optional)<input
						name="canonicalMovement"
						maxlength="120"
						placeholder="e.g. chest_press"
						class="block w-full rounded bg-zinc-800 p-2"
					/></label
				>
				<label class="block"
					><input type="checkbox" name="isLowerBody" value="1" /> New exercise is lower body (+10 rather
					than +5 increment)</label
				>
				<label class="block"
					>Equipment type<select name="equipmentType" class="block w-full rounded bg-zinc-800 p-2"
						>{#each ['machine-plate', 'machine-stack', 'cable', 'dumbbell', 'barbell', 'barbell-ez', 'smith', 'bodyweight', 'band'] as type}<option
								value={type}>{type}</option
							>{/each}</select
					></label
				>
				<MachinePicker gyms={data.choices.gyms} machines={data.choices.machines} />
				<label class="block"
					>Working sets<input
						name="setCount"
						type="number"
						min="1"
						max="10"
						value="2"
						required
						class="block w-full rounded bg-zinc-800 p-2"
					/></label
				>
				<label class="block"
					>Minimum reps<input
						name="repsMin"
						type="number"
						min="0"
						max="100"
						value="8"
						required
						class="block w-full rounded bg-zinc-800 p-2"
					/></label
				>
				<label class="block"
					>Maximum reps<input
						name="repsMax"
						type="number"
						min="0"
						max="100"
						value="12"
						required
						class="block w-full rounded bg-zinc-800 p-2"
					/></label
				>
				<label class="block"
					>Target RIR<input
						name="rir"
						type="number"
						min="0"
						max="10"
						value="1"
						required
						class="block w-full rounded bg-zinc-800 p-2"
					/></label
				>
				<label class="block"
					>Tier<select name="tier" class="block w-full rounded bg-zinc-800 p-2"
						><option value="secondary">Secondary</option><option value="isolation">Isolation</option
						></select
					></label
				>
				<label class="block"
					>Progression policy<select
						name="progressionPolicy"
						class="block w-full rounded bg-zinc-800 p-2"
						><option value="standard">Standard</option><option value="cautious"
							>Cautious — manual advance</option
						><option value="hold">Hold — manual load</option></select
					></label
				>
				<button class="rounded bg-indigo-600 px-4 py-2">Add exercise to workout</button>
			</form>
		</details>
	{/if}

	{#each data.groups as group (group.key)}
		<section class="mt-7">
			<div class="flex items-baseline justify-between gap-2">
				<h2 class="text-base font-semibold text-zinc-100">{group.exerciseName}</h2>
				<div class="flex items-center gap-1.5 text-[10px] tracking-wider text-zinc-500 uppercase">
					{#if group.tier}
						<span>{group.tier}</span>
					{/if}
					{#if group.progressionPolicy && group.progressionPolicy !== 'standard'}
						<span class="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300">
							{group.progressionPolicy}
						</span>
					{/if}
				</div>
			</div>

			<p class="mt-2 text-sm text-zinc-400">
				{group.gymName ?? 'Legacy context'} · {group.machineLabel ?? 'Unknown machine'} · {group.modelName ??
					'Unknown model'} · {group.loadConvention.replaceAll('_', ' ')}
			</p>
			{#if !data.session.endedAt && group.occurrenceId}
				<details class="mt-2 rounded border border-zinc-700 p-2">
					<summary>Select / change machine</summary>
					<p class="mt-2 text-sm text-amber-200">
						Only before logging any values. This clears legacy load suggestions and uses this
						machine's history. For a different machine after logging, quick-add a separate exercise.
					</p>
					<form method="POST" action="?/bindMachine" class="mt-2">
						<input type="hidden" name="occurrenceId" value={group.occurrenceId} />
						<MachinePicker gyms={data.choices.gyms} machines={data.choices.machines} />
						<label class="mt-2 block"
							><input type="checkbox" name="confirm" value="CHANGE" required /> I confirm this machine
							and load convention</label
						>
						<button class="mt-2 rounded bg-indigo-600 px-3 py-2">Apply machine</button>
					</form>
				</details>
			{/if}
			<ul class="mt-2 space-y-2">
				{#each group.sets as set (set.id)}
					<SetRow
						{set}
						sessionEnded={data.session.endedAt != null}
						allowEndedSessionEdit={data.allowEndedSessionEdit}
						rowError={form?.setId === set.id ? (form.fieldErrors ?? null) : null}
						rowMessage={form?.setId === set.id && 'message' in form ? (form.message ?? null) : null}
					/>
				{/each}
			</ul>
		</section>
	{/each}
</div>

{#if !data.session.endedAt}
	<div class="sticky bottom-0 border-t border-zinc-800 bg-zinc-950/90 p-4 backdrop-blur">
		<div class="mx-auto grid max-w-md grid-cols-2 gap-2">
			<a
				href="/programs/{data.session.programId}"
				class="rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-3 text-center text-sm font-semibold text-zinc-200 transition active:scale-[0.99] active:bg-zinc-800"
			>
				Pause Session
			</a>
			<form method="POST" action="?/endSession">
				<button
					type="submit"
					class="w-full rounded-lg bg-emerald-500 px-4 py-3 text-base font-semibold text-zinc-950 shadow-sm shadow-emerald-500/20 transition active:scale-[0.99] active:bg-emerald-600"
					onclick={(event) => {
						if (unloggedSetCount <= 0) return;
						const noun = unloggedSetCount === 1 ? 'set' : 'sets';
						if (!confirm(`${unloggedSetCount} ${noun} are still unlogged. End session anyway?`)) {
							event.preventDefault();
						}
					}}
				>
					End Session
				</button>
			</form>
		</div>
	</div>
{/if}
