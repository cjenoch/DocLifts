<script lang="ts">
	import type { PageData } from './$types';
	import { workoutUi } from '$lib/workout-ui';
	import TrashAction from '$lib/TrashAction.svelte';
	import { appShell, pageTitle } from '$lib/app-shell';

	let { data }: { data: PageData } = $props();

	const monthLabel = $derived.by(() => {
		const [y, m] = data.month.split('-').map(Number);
		return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, {
			year: 'numeric',
			month: 'long',
			timeZone: 'UTC'
		});
	});

	const fmtDate = (d: Date) =>
		new Date(d).toLocaleDateString(undefined, {
			weekday: 'short',
			month: 'short',
			day: 'numeric',
			timeZone: 'UTC'
		});

	const trashLabel = (t: PageData['trashSessions'][number]) =>
		t.systemKind === 'quick' ? workoutUi.quickWorkoutLabel : t.programName;
</script>

<svelte:head><title>{pageTitle('History')}</title></svelte:head>

<div class="mx-auto max-w-md px-4 py-6">
	<div class="mb-5 flex items-center justify-between gap-2">
		<h1 class="text-2xl font-semibold tracking-tight">History</h1>
		<div class="flex items-center gap-2">
			<a
				href="/history?month={data.prevMonth}"
				class="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-semibold tracking-wide text-zinc-200 uppercase active:bg-zinc-800"
				>← {data.prevMonth}</a
			>
			{#if data.nextMonth}
				<a
					href="/history?month={data.nextMonth}"
					class="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-semibold tracking-wide text-zinc-200 uppercase active:bg-zinc-800"
					>{data.nextMonth} →</a
				>
			{/if}
		</div>
	</div>

	<p class="mb-4 text-sm text-zinc-500">{monthLabel} · all programs</p>

	{#if !data.hasWorkouts}
		<p class="text-zinc-400" data-testid="empty-state">{appShell.empty.history}</p>
	{:else if data.sessions.length === 0}
		<p class="text-zinc-500">No workouts this month.</p>
	{:else}
		<ul class="space-y-2">
			{#each data.sessions as s (s.id)}
				<li>
					<a
						href="/sessions/{s.id}"
						class="block rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 transition active:scale-[0.99] active:bg-zinc-900"
					>
						<div class="flex items-center justify-between gap-2">
							<span class="font-medium text-zinc-100"
								>{s.systemKind === 'quick' ? workoutUi.quickWorkoutLabel : s.dayName}</span
							>
							{#if s.endedAt}
								<span class="text-xs font-semibold tracking-wide text-emerald-400 uppercase"
									>Done</span
								>
							{:else}
								<span class="text-xs font-semibold tracking-wide text-amber-400 uppercase"
									>Open</span
								>
							{/if}
						</div>
						<div class="mt-1 text-sm text-zinc-400">
							{fmtDate(s.startedAt)}{#if s.systemKind !== 'quick'}
								· {s.programName}{#if !s.programIsActive}
									<span class="text-zinc-600">(archived)</span>{/if}{/if}
						</div>
						{#if s.endedAt}
							<div class="mt-2 text-xs text-indigo-300">Edit →</div>
						{:else}
							<div class="mt-2 text-xs text-indigo-300">Resume →</div>
						{/if}
					</a>
				</li>
			{/each}
		</ul>
	{/if}

	<!-- Trash on History (0.5.2): every trashed workout, quick or program.
	     Collapsed by default; <details> keeps it CSP-clean (no style attribute). -->
	<details class="mt-8 rounded-xl border border-zinc-700 bg-zinc-900/50">
		<summary class="cursor-pointer px-4 py-3 text-sm font-semibold text-zinc-200"
			>{workoutUi.historyTrashHeading} ({data.trashCount})</summary
		>
		<div class="border-t border-zinc-800 p-4">
			{#if data.trashSessions.length === 0}
				<p class="text-sm text-zinc-400">{workoutUi.historyTrashEmpty}</p>
			{:else}
				<p class="text-sm text-zinc-400">{workoutUi.historyTrashIntro}</p>
				{#if data.trashSessions.length < data.trashCount}
					<p class="mt-1 text-sm text-zinc-500">
						{workoutUi.historyTrashTruncated(data.trashSessions.length)}
					</p>
				{/if}
				<ul class="mt-4 space-y-3">
					{#each data.trashSessions as t (t.id)}
						<li class="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
							<h2 class="font-medium text-zinc-100">{trashLabel(t)}</h2>
							<p class="mt-1 text-sm text-zinc-400">
								{fmtDate(t.startedAt)} · {workoutUi.historyTrashSets(t.loggedSets)}
							</p>
							<div class="mt-3 flex flex-wrap gap-2">
								<TrashAction
									action="?/restoreSession"
									label={workoutUi.historyTrashRestore}
									sessionId={t.id}
								/>
								<TrashAction
									action="?/permanentDeleteSession"
									label={workoutUi.historyTrashDelete}
									sessionId={t.id}
									destructive
									confirmation={workoutUi.historyTrashConfirmDelete(
										trashLabel(t),
										fmtDate(t.startedAt)
									)}
									confirmationField="confirmDelete"
									confirmationValue="d"
								/>
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</details>
</div>
