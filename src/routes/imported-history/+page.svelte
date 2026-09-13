<script lang="ts">
	import type { PageData } from './$types';
	let { data }: { data: PageData } = $props();
	let search = $state('');
	let month = $state('');
	const months = $derived(
		[...new Set(data.workouts.flatMap((w) => (w.workoutDate ? [w.workoutDate.slice(0, 7)] : [])))]
			.sort()
			.reverse()
	);
	const visible = $derived(
		data.workouts.filter(
			(w) =>
				(!month || (month === 'undated' ? !w.workoutDate : w.workoutDate?.startsWith(month))) &&
				(!search.trim() ||
					`${w.title} ${w.gym ?? ''} ${w.lines.map((l) => l.text).join(' ')}`
						.toLowerCase()
						.includes(search.trim().toLowerCase()))
		)
	);
	const estimatedCount = $derived(
		data.workouts
			.flatMap((w) => w.lines)
			.flatMap((l) => l.sets)
			.filter((s) => s.evidence === 'user_authorized_estimate').length
	);
	function formatDate(value: string) {
		return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' }).format(
			new Date(`${value}T12:00:00Z`)
		);
	}
</script>

<svelte:head><title>Imported workout history · DocLifts</title></svelte:head>
<main class="mx-auto max-w-2xl px-4 py-6 pb-20">
	<a href="/" class="text-sm text-indigo-300">← Programs</a>
	<h1 class="mt-3 text-2xl font-semibold">Your training history</h1>
	<p class="mt-2 text-sm text-zinc-400">
		{data.workouts.length} imported workout records · {estimatedCount} estimated sets
	</p>
	<p class="mt-3 text-sm leading-relaxed text-zinc-300">
		Your original workout notes are preserved below. Parsed sets are shown where the log is clear;
		estimates are labeled. These historical records don’t change your current load suggestions or
		live-workout reports.
	</p>
	<div class="my-5 grid gap-3 sm:grid-cols-2">
		<label class="text-sm"
			>Find a workout
			<input
				type="search"
				bind:value={search}
				placeholder="Gym, exercise, or note"
				class="mt-1 block w-full rounded-lg border border-zinc-700 bg-zinc-900 p-3"
			/>
		</label>
		<label class="text-sm"
			>Month
			<select
				bind:value={month}
				class="mt-1 block w-full rounded-lg border border-zinc-700 bg-zinc-900 p-3"
			>
				<option value="">All months</option><option value="undated">Exact date unknown</option>
				{#each months as value}<option {value}>{value}</option>{/each}
			</select>
		</label>
	</div>
	<p class="mb-3 text-sm text-zinc-400">Showing {visible.length} records</p>
	{#each visible as workout (workout.id)}
		<details class="mb-3 rounded-xl border border-zinc-700 bg-zinc-900/60 p-4">
			<summary class="cursor-pointer">
				<span class="font-semibold"
					>{workout.workoutDate ? formatDate(workout.workoutDate) : 'Date unknown'}</span
				>
				<span class="mt-1 block text-sm text-zinc-300">{workout.title}</span>
				{#if workout.gym}<span class="mt-1 block text-xs text-indigo-300">{workout.gym}</span>{/if}
			</summary>
			<p class="mt-3 text-xs text-zinc-400">{workout.dateNote}</p>
			{#if !workout.workoutDate && workout.earliestDate && workout.latestDate}
				<p class="mt-2 text-sm">
					Between {formatDate(workout.earliestDate)} and {formatDate(workout.latestDate)}.
				</p>
			{/if}
			{#each workout.lines as line (line.sourceLine)}
				<div class="mt-4 border-t border-zinc-800 pt-3">
					<p class="text-sm leading-relaxed break-words whitespace-pre-wrap">{line.text}</p>
					{#if line.sets.length}
						<p class="mt-2 text-sm text-emerald-200">
							{line.sets.map((s) => `${s.load} lb × ${s.reps}`).join(' · ')}
						</p>
						{#if line.sets.some((s) => s.evidence === 'user_authorized_estimate')}
							<p class="mt-1 text-xs text-amber-200">
								Estimated sets/reps from your recalled routine; original weight retained.
							</p>
						{/if}
					{/if}
					{#if line.interpretationNote}<p class="mt-1 text-xs text-zinc-400">
							{line.interpretationNote}
						</p>{/if}
				</div>
			{/each}
		</details>
	{:else}
		<p class="rounded-lg border border-zinc-800 p-5 text-zinc-400">
			No imported workouts match this search.
		</p>
	{/each}
</main>
