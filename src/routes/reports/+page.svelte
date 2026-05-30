<script lang="ts">
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<div class="mx-auto max-w-md px-4 py-6">
	<a href="/" class="text-sm text-indigo-400 active:underline">← Programs</a>

	<h1 class="mt-2 text-2xl font-semibold tracking-tight">Reporting</h1>
	<p class="mt-1 text-sm text-zinc-400">Completed + ended workouts only (deleted/open excluded where relevant).</p>

	<section class="mt-6 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
		<h2 class="text-xs font-semibold uppercase tracking-wider text-zinc-500">Overview</h2>
		<ul class="mt-3 space-y-1.5 text-sm text-zinc-200">
			<li>Total sessions (not deleted): {data.overview.totalSessions}</li>
			<li>Ended sessions: {data.overview.endedSessions}</li>
			<li>Open sessions: {data.overview.openSessions}</li>
			<li>Set completion (ended sessions): {data.overview.completionRatePct}%</li>
			<li>Ended sessions in last 7 days: {data.overview.last7Sessions}</li>
			<li>Ended sessions in last 28 days: {data.overview.last28Sessions}</li>
		</ul>
	</section>

	<section class="mt-6 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
		<h2 class="text-xs font-semibold uppercase tracking-wider text-zinc-500">Consistency · Last 14 days</h2>
		<div class="mt-3 grid grid-cols-7 gap-1.5 text-center text-[11px]">
			{#each data.consistency as cell (cell.dateKey)}
				<div
					class="rounded border px-1 py-1.5 {cell.count > 0
						? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300'
						: 'border-zinc-800 bg-zinc-950 text-zinc-500'}"
					title={`${cell.dateKey}: ${cell.count} workout${cell.count === 1 ? '' : 's'}`}
				>
					<div>{cell.dateKey.slice(5)}</div>
					<div class="mt-0.5 font-semibold">{cell.count}</div>
				</div>
			{/each}
		</div>
	</section>

	<section class="mt-6 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
		<h2 class="text-xs font-semibold uppercase tracking-wider text-zinc-500">Top exercises (completed set rows)</h2>
		{#if data.topExercises.length === 0}
			<p class="mt-3 text-sm text-zinc-500">No completed set data yet.</p>
		{:else}
			<ul class="mt-3 space-y-1.5 text-sm text-zinc-200">
				{#each data.topExercises as ex, i (ex.exerciseName)}
					<li class="flex items-center justify-between gap-2">
						<span class="truncate">{i + 1}. {ex.exerciseName}</span>
						<span class="font-mono text-zinc-300">{ex.completedSetRows}</span>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	<section class="mt-6 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
		<h2 class="text-xs font-semibold uppercase tracking-wider text-zinc-500">Recent trend (last 10 ended sessions)</h2>
		{#if data.recentTrend.length === 0}
			<p class="mt-3 text-sm text-zinc-500">No ended sessions yet.</p>
		{:else}
			<ul class="mt-3 space-y-2 text-sm">
				{#each data.recentTrend as session (session.sessionId)}
					<li class="rounded border border-zinc-800 bg-zinc-950/60 px-3 py-2">
						<div class="flex items-center justify-between gap-2">
							<span class="text-zinc-300">{new Date(session.startedAt).toLocaleString()}</span>
							<span class="font-mono text-zinc-100">{session.completionPct}%</span>
						</div>
						<div class="mt-1 h-1.5 rounded bg-zinc-800">
							<div
								class="h-1.5 rounded bg-indigo-500"
								style={`width: ${Math.max(0, Math.min(100, session.completionPct))}%`}
							></div>
						</div>
						<div class="mt-1 text-xs text-zinc-500">
							{session.completedSets}/{session.totalSets} sets completed
						</div>
					</li>
				{/each}
			</ul>
		{/if}
	</section>
</div>
