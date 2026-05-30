<script lang="ts">
	import { enhance } from '$app/forms';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// Per-day flag: one day's in-flight start must not disable other days' buttons.
	let starting = $state<Record<string, boolean>>({});
	let historyOpen = $state(false);
	let selectedDate = $state<string | null>(null);
	let trashOpen = $state(false);

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
								</div>
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		{/if}
	</section>

	<section class="mt-8">
		<button
			type="button"
			class="flex w-full items-center justify-between rounded-xl border border-red-900/40 bg-red-950/20 px-4 py-3 text-left"
			onclick={() => (trashOpen = !trashOpen)}
		>
			<span class="text-xs font-semibold uppercase tracking-wider text-red-300">Trash</span>
			<span class="text-sm text-zinc-300">{trashOpen ? 'Hide' : 'Show'}</span>
		</button>

		{#if trashOpen}
			<div class="mt-3 rounded-xl border border-red-900/40 bg-zinc-900/40 p-3">
				<p class="text-xs text-red-300">Restore is reversible. Permanent delete and Empty Trash are irreversible.</p>
				{#if data.trashSessions.length === 0}
					<p class="mt-3 text-zinc-500">Trash is empty.</p>
				{:else}
					<ul class="mt-3 space-y-2">
						{#each data.trashSessions as session (session.id)}
							<li class="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3 text-sm">
								<div class="flex items-center justify-between gap-2">
									<div>
										<div class="font-medium text-zinc-100">{session.dayName}</div>
										<div class="text-xs text-zinc-500">
											Started {new Date(session.startedAt).toLocaleString()} · Deleted {session.deletedAt ? new Date(session.deletedAt).toLocaleString() : '—'}
										</div>
									</div>
								</div>
								<div class="mt-3 flex flex-col gap-2">
									<form method="POST" action="?/restoreSession" use:enhance>
										<input type="hidden" name="sessionId" value={session.id} />
										<button
											type="submit"
											class="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white active:bg-emerald-700"
										>
											Restore
										</button>
									</form>

									<form
										method="POST"
										action="?/permanentDeleteSession"
										use:enhance={({ formElement, formData, cancel }) => {
											const confirmDelete = String(formData.get('confirmDelete') ?? '').toLowerCase();
											if (confirmDelete !== 'd') {
												cancel();
												alert('Type d to confirm permanent delete.');
												return;
											}
											if (!confirm('This permanently deletes this workout and all its sets. Continue?')) {
												cancel();
												return;
											}
											if (!confirm('Final confirmation: this cannot be undone. Permanently delete?')) {
												cancel();
												return;
											}
											return async ({ update }) => {
												await update({ reset: false });
												formElement.reset();
											};
										}}
									>
										<input type="hidden" name="sessionId" value={session.id} />
										<div class="flex items-center gap-2">
											<input
												name="confirmDelete"
												type="text"
												required
												maxlength="1"
												placeholder="d"
												class="w-16 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100"
											/>
											<button
												type="submit"
												class="rounded-md bg-red-700 px-3 py-1.5 text-xs font-semibold text-white active:bg-red-800"
											>
												Delete permanently
											</button>
										</div>
									</form>
								</div>
							</li>
						{/each}
					</ul>

					<form
						class="mt-4 rounded-xl border border-red-900/50 bg-red-950/20 p-3"
						method="POST"
						action="?/purgeTrash"
						use:enhance={({ formElement, formData, cancel }) => {
							const confirmPurge = String(formData.get('confirmPurge') ?? '').toUpperCase();
							if (confirmPurge !== 'PURGE') {
								cancel();
								alert('Type PURGE to confirm empty trash.');
								return;
							}
							if (!confirm(`This will permanently delete ${data.trashSessions.length} trashed workout(s). Continue?`)) {
								cancel();
								return;
							}
							if (!confirm('Final confirmation: Empty Trash cannot be undone.')) {
								cancel();
								return;
							}
							return async ({ update }) => {
								await update({ reset: false });
								formElement.reset();
							};
						}}
					>
						<div class="text-xs text-red-200">Empty Trash ({data.trashSessions.length} items)</div>
						<div class="mt-2 flex items-center gap-2">
							<input type="hidden" name="expectedCount" value={data.trashSessions.length} />
							<input
								name="confirmPurge"
								type="text"
								required
								placeholder="PURGE"
								class="w-28 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100"
							/>
							<button
								type="submit"
								class="rounded-md bg-red-800 px-3 py-1.5 text-xs font-semibold text-white active:bg-red-900"
							>
								Empty Trash
							</button>
						</div>
					</form>
				{/if}
			</div>
		{/if}
	</section>
</div>
