<script lang="ts">
	import { enhance } from '$app/forms';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// Per-day flag: one day's in-flight start must not disable other days' buttons.
	let starting = $state<Record<string, boolean>>({});
	let historyOpen = $state(false);
	let selectedDate = $state<string | null>(null);

	const calendarDays = $derived.by(() => {
		const out: Array<{ dateKey: string; label: string; count: number }> = [];
		const now = new Date();
		for (let i = 13; i >= 0; i--) {
			const d = new Date(now);
			d.setDate(now.getDate() - i);
			const dateKey = d.toISOString().slice(0, 10);
			out.push({
				dateKey,
				label: `${d.getMonth() + 1}/${d.getDate()}`,
				count: data.sessionsByDay[dateKey] ?? 0,
			});
		}
		return out;
	});

	const filteredSessions = $derived.by(() => {
		const date = selectedDate;
		if (!date) return data.recentSessions;
		return data.recentSessions.filter((session) =>
			session.startedAt.toISOString().startsWith(date),
		);
	});
</script>

<div class="mx-auto max-w-md px-4 py-6">
	<a href="/" class="text-sm text-indigo-400 active:underline">← Programs</a>

	<h1 class="mt-2 text-2xl font-semibold tracking-tight">{data.program.name}</h1>
	{#if data.program.description}
		<p class="mt-1 text-sm text-zinc-400">{data.program.description}</p>
	{/if}

	<h2 class="mt-7 mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">Days</h2>

	{#if data.days.length === 0}
		<p class="text-zinc-500">No days configured.</p>
	{:else}
		<ul class="space-y-2">
			{#each data.days as day (day.id)}
				<li class="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
					<div class="flex items-baseline justify-between gap-2">
						<div class="font-medium text-zinc-100">{day.name}</div>
						{#if day.alternateGroupId}
							<span class="text-xs text-zinc-500">alt: {day.alternateGroupId}</span>
						{/if}
					</div>
					{#if day.notes}
						<div class="mt-1 text-xs text-zinc-400">{day.notes}</div>
					{/if}

					<div class="mt-3">
						{#if day.openSessionId}
							<a
								href="/sessions/{day.openSessionId}"
								class="inline-block rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-zinc-950 shadow-sm shadow-amber-500/20 transition active:scale-[0.98] active:bg-amber-600"
							>
								Resume
							</a>
						{:else}
							<form
								method="POST"
								action="?/startSession"
								use:enhance={({ formData, cancel }) => {
									const id = String(formData.get('dayId') ?? '');
									if (starting[id]) {
										cancel();
										return;
									}
									starting[id] = true;
									return async ({ update }) => {
										await update();
										starting[id] = false;
									};
								}}
							>
								<input type="hidden" name="dayId" value={day.id} />
								<button
									type="submit"
									disabled={starting[day.id]}
									class="rounded-lg bg-indigo-500 px-4 py-2 text-sm font-semibold text-white shadow-sm shadow-indigo-500/20 transition active:scale-[0.98] active:bg-indigo-600 disabled:opacity-60"
								>
									{starting[day.id] ? 'Starting…' : 'Start'}
								</button>
							</form>
						{/if}
					</div>
				</li>
			{/each}
		</ul>
	{/if}

	<section class="mt-8">
		<button
			type="button"
			class="flex w-full items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3 text-left"
			onclick={() => (historyOpen = !historyOpen)}
		>
			<span class="text-xs font-semibold uppercase tracking-wider text-zinc-400">Recent Workouts</span>
			<span class="text-sm text-zinc-300">{historyOpen ? 'Hide' : 'Show'}</span>
		</button>

		{#if historyOpen}
			<div class="mt-3 rounded-xl border border-zinc-800 bg-zinc-900/40 p-3">
				<div class="mb-3 text-xs uppercase tracking-wider text-zinc-500">Last 14 days</div>
				<div class="grid grid-cols-7 gap-1.5 text-center text-[11px]">
					{#each calendarDays as cell (cell.dateKey)}
						<button
							type="button"
							class="rounded border px-1 py-1.5 {selectedDate === cell.dateKey
								? 'border-indigo-400 bg-indigo-500/20 text-indigo-200'
								: cell.count > 0
									? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300'
									: 'border-zinc-800 bg-zinc-950 text-zinc-500'}"
							title={`${cell.dateKey}: ${cell.count} workout${cell.count === 1 ? '' : 's'}`}
							onclick={() => {
								selectedDate = selectedDate === cell.dateKey ? null : cell.dateKey;
							}}
						>
							<div>{cell.label}</div>
							<div class="mt-0.5 font-semibold">{cell.count}</div>
						</button>
					{/each}
				</div>
				{#if selectedDate}
					<div class="mt-2 flex items-center justify-between text-[11px] text-zinc-400">
						<span>Filtering to {selectedDate}</span>
						<button
							type="button"
							class="rounded bg-zinc-800 px-2 py-0.5 text-zinc-200"
							onclick={() => (selectedDate = null)}
						>
							Clear
						</button>
					</div>
				{/if}
			</div>

			{#if filteredSessions.length === 0}
				<p class="mt-3 text-zinc-500">
					{selectedDate ? 'No workouts on selected date.' : 'No recent sessions yet.'}
				</p>
			{:else}
				<ul class="mt-3 space-y-2">
					{#each filteredSessions as session (session.id)}
						<li class="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3 text-sm">
							<div class="flex items-center justify-between gap-2">
								<div>
									<div class="font-medium text-zinc-100">{session.dayName}</div>
									<div class="text-xs text-zinc-500">
										{new Date(session.startedAt).toLocaleString()}
										{#if session.endedAt}
											· ended
										{:else}
											· open
										{/if}
									</div>
								</div>
								<div class="flex items-center gap-2">
									<a
										href="/sessions/{session.id}{session.endedAt ? '?edit=1' : ''}"
										class="rounded-md bg-zinc-800 px-2.5 py-1 text-xs font-semibold text-zinc-100 active:bg-zinc-700"
									>
										{session.endedAt ? 'Edit' : 'Resume'}
									</a>
									<form method="POST" action="?/deleteSession">
										<input type="hidden" name="sessionId" value={session.id} />
										<button
											type="submit"
											class="rounded-md bg-rose-500/15 px-2.5 py-1 text-xs font-semibold text-rose-300 active:bg-rose-500/25"
											onclick={(e) => {
												if (!confirm('Delete this workout and all logged sets? This cannot be undone.')) {
													e.preventDefault();
												}
											}}
										>
											Delete
										</button>
									</form>
								</div>
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		{/if}
	</section>
</div>
