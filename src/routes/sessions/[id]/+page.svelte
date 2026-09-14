<script lang="ts">
	import { requestId as newRequestId } from '$lib/request-id';
	import { enhance } from '$app/forms';
	import { onMount, tick, untrack } from 'svelte';
	import type { ActionData, PageData } from './$types';
	import SetRow from './SetRow.svelte';
	import MachinePicker from '$lib/MachinePicker.svelte';
	import AddWorkoutExercise from '$lib/AddWorkoutExercise.svelte';
	let { data, form }: { data: PageData; form: ActionData } = $props();
	let dirtyIds = $state<string[]>([]);
	let appending = $state<string | null>(null);
	let pickerOpen = $state(false);
	let appendError = $state('');
	let ids = $state<Record<string, string>>({});
	onMount(() => {
		ids = Object.fromEntries(data.groups.map((g) => [g.key, newRequestId()]));
	});
	$effect(() => {
		const groups = data.groups;
		untrack(() => {
			if (typeof crypto !== 'undefined')
				for (const g of groups) if (!ids[g.key]) ids[g.key] = newRequestId();
		});
	});
	function ondirty(id: string, dirty: boolean) {
		// Do not subscribe a child effect to the parent's collection.
		untrack(() => {
			if (dirty && !dirtyIds.includes(id)) dirtyIds = [...dirtyIds, id];
			else if (!dirty && dirtyIds.includes(id)) dirtyIds = dirtyIds.filter((v) => v !== id);
		});
	}
	const allSets = $derived(data.groups.flatMap((g) => g.sets));
	const completed = $derived(
		allSets.filter((s) => s.executedLoad != null && s.executedReps != null).length
	);
</script>

<svelte:head><title>{data.day.name} · DocLifts</title></svelte:head>
<main class="workout">
	<a class="back" href="/programs/{data.session.programId}">← Workouts</a>
	<header>
		<div class="eyebrow">DOCLIFTS / {data.session.endedAt ? 'WORKOUT HISTORY' : 'IN SESSION'}</div>
		<h1>{data.day.name}</h1>
		<p class="muted">
			{new Date(data.session.startedAt).toLocaleDateString(undefined, {
				month: 'short',
				day: 'numeric',
				year: 'numeric'
			})} · {data.groups.length} exercises
		</p>
		<div class="progress-copy">
			<span>{completed} of {allSets.length} sets logged</span><span
				>{Math.round((completed / Math.max(allSets.length, 1)) * 100)}%</span
			>
		</div>
		<progress value={completed} max={Math.max(allSets.length, 1)} aria-label="Workout completion"
		></progress>
	</header>
	{#if data.session.endedAt}<div class="history-tools">
			{#if data.allowEndedSessionEdit}<a href="/sessions/{data.session.id}">Done editing</a>
				<form
					method="POST"
					action="?/deleteSession"
					onsubmit={(e) => {
						if (!confirm('Move this workout to Trash? You can restore it later.'))
							e.preventDefault();
					}}
				>
					<input type="hidden" name="confirmDelete" value="d" /><button class="trash"
						>Move to Trash</button
					>
				</form>{:else}<span class="muted">Completed workout</span><a
					href="/sessions/{data.session.id}?edit=1">Edit workout</a
				>{/if}
		</div>{/if}
	{#if form && 'message' in form && form.message}<p role="alert" class="error">
			{form.message}
		</p>{/if}
	{#each data.groups as group, index (group.key)}
		<section class="exercise" id="exercise-{group.key}" tabindex="-1">
			<div class="exercise-heading">
				<span class="number">{String(index + 1).padStart(2, '0')}</span>
				<div>
					<h2>{group.exerciseName}</h2>
					<p class="muted">
						{group.gymName
							? `${group.gymName} · ${group.machineLabel}`
							: 'Equipment not specified'}{group.loadConvention !== 'legacy'
							? ` · ${group.loadConvention.replaceAll('_', ' ')}`
							: ''}
					</p>
				</div>
			</div>
			{#if !data.session.endedAt && group.occurrenceId}<details class="equipment">
					<summary>Equipment details</summary>
					<p class="muted">
						Choose before logging. Changing equipment starts a separate performance history.
					</p>
					<form method="POST" action="?/bindMachine">
						<input type="hidden" name="occurrenceId" value={group.occurrenceId} /><MachinePicker
							gyms={data.choices.gyms}
							machines={data.choices.machines}
							equipmentType={data.choices.exercises.find((e) => e.id === group.exerciseId)
								?.equipmentType}
						/><label class="confirm"
							><input type="checkbox" name="confirm" value="CHANGE" required /> Confirm equipment and
							weight format</label
						><button class="secondary">Apply equipment</button>
					</form>
				</details>{/if}
			<ul>
				{#each group.sets as set (set.id)}<SetRow
						{set}
						sessionEnded={data.session.endedAt != null}
						allowEndedSessionEdit={data.allowEndedSessionEdit}
						{ondirty}
					/>{/each}
			</ul>
			{#if !data.session.endedAt}<form
					class="add-set"
					method="POST"
					action="?/appendSet"
					use:enhance={() => {
						appending = group.key;
						appendError = '';
						return async ({ result, update }) => {
							try {
								if (result.type === 'success' && result.data?.addedSetId) {
									await update({ reset: false });
									ids[group.key] = newRequestId();
									await tick();
									const row = document.getElementById(`set-${result.data.addedSetId}`);
									row?.scrollIntoView({ behavior: 'smooth', block: 'center' });
									row
										?.querySelector('input:not([type=hidden])')
										?.closest('label')
										?.querySelector('input')
										?.focus({ preventScroll: true });
								} else
									appendError =
										result.type === 'failure'
											? String(result.data?.message)
											: 'Could not add set. Please try again.';
							} finally {
								appending = null;
							}
						};
					}}
				>
					<input type="hidden" name="sourceSetId" value={group.sets.at(-1)?.id} /><input
						type="hidden"
						name="requestId"
						value={ids[group.key] ?? ''}
					/><select name="setRole" aria-label={`New set type for ${group.exerciseName}`}
						><option value="working">Working set</option><option value="warmup">Warmup</option
						><option value="backoff">Backoff</option></select
					><button disabled={appending !== null || !ids[group.key]}
						>{appending === group.key ? 'Adding…' : '+ Add set'}</button
					>
				</form>
				{@const last = group.sets.at(-1)!}
				{#if group.sets.length > 1 && last.executedLoad == null && last.executedReps == null && last.executedRir == null && !last.notes}
					<form
						method="POST"
						action="?/removeSet"
						use:enhance={({ cancel }) => {
							if (!confirm('Remove the last empty set? Logged sets stay unchanged.')) {
								cancel();
								return;
							}
							appending = group.key;
							return async ({ result, update }) => {
								try {
									if (result.type === 'success') await update({ reset: false });
									else
										appendError =
											result.type === 'failure'
												? String(result.data?.message)
												: 'Could not remove set.';
								} finally {
									appending = null;
								}
							};
						}}
					>
						<input type="hidden" name="setId" value={last.id} /><button
							class="remove-set"
							disabled={appending !== null || dirtyIds.includes(last.id)}
							>Remove last empty set</button
						>
					</form>
				{/if}
			{/if}
		</section>
	{/each}
	{#if appendError}<p role="alert" class="error">{appendError}</p>{/if}
	{#if !data.session.endedAt}<AddWorkoutExercise
			choices={data.choices}
			bind:open={pickerOpen}
		/>{/if}
</main>
{#if !data.session.endedAt}<footer>
		<div class="footer-inner">
			<p aria-live="polite">
				{dirtyIds.length
					? `${dirtyIds.length} unsaved ${dirtyIds.length === 1 ? 'set' : 'sets'} · drafts kept in this tab`
					: 'Saved sets are stored in your workout'}
			</p>
			<div class="footer-actions">
				<a href="/programs/{data.session.programId}">Pause</a><a
					class="jump-add"
					onclick={() => (pickerOpen = true)}
					href="#add-workout-exercise">Add exercise</a
				>
				<form
					method="POST"
					action="?/endSession"
					onsubmit={(e) => {
						if (dirtyIds.length) {
							e.preventDefault();
							alert('Save your unfinished entries before finishing this workout.');
							return;
						}
						if (
							completed < allSets.length &&
							!confirm(`${allSets.length - completed} sets are not logged. Finish workout anyway?`)
						)
							e.preventDefault();
					}}
				>
					<button>Finish workout</button>
				</form>
			</div>
		</div>
	</footer>{/if}

<style>
	.remove-set {
		min-height: 44px;
		font-size: 12px;
		color: #acb8ca;
		margin-top: 6px;
	}
	.workout {
		max-width: 680px;
		margin: auto;
		padding: 28px 16px 150px;
	}
	.back {
		font-size: 14px;
		color: #b8c8e0;
	}
	header {
		padding: 26px 0;
	}
	.eyebrow {
		font-size: 11px;
		letter-spacing: 0.16em;
		color: #a5b4fc;
		font-weight: 700;
	}
	h1 {
		font-size: 28px;
		letter-spacing: -0.035em;
		line-height: 1.2;
		font-weight: 700;
		margin: 10px 0;
	}
	.muted {
		color: #a8b3c5;
		font-size: 13px;
		line-height: 1.5;
	}
	.progress-copy {
		display: flex;
		justify-content: space-between;
		font-size: 12px;
		margin-top: 20px;
		color: #c4cede;
	}
	progress {
		width: 100%;
		height: 5px;
		display: block;
		margin-top: 8px;
		border: 0;
		border-radius: 8px;
		overflow: hidden;
		background: #263145;
	}
	progress::-webkit-progress-bar {
		background: #263145;
	}
	progress::-webkit-progress-value {
		background: #a5b4fc;
	}
	.exercise {
		background: #121a28;
		border: 1px solid #2b3648;
		border-radius: 18px;
		padding: 18px;
		margin-bottom: 20px;
		scroll-margin-top: 16px;
	}
	.exercise-heading {
		display: flex;
		gap: 12px;
		margin-bottom: 16px;
	}
	.number {
		font-size: 12px;
		color: #a5b4fc;
		padding-top: 4px;
		font-variant-numeric: tabular-nums;
	}
	h2 {
		font-size: 19px;
		line-height: 1.3;
		font-weight: 650;
		letter-spacing: -0.02em;
	}
	.exercise-heading p {
		margin-top: 5px;
	}
	.equipment {
		font-size: 13px;
		margin-bottom: 14px;
	}
	summary {
		cursor: pointer;
		padding: 10px 0;
		color: #b6c5da;
	}
	.confirm {
		display: flex;
		gap: 8px;
		margin-top: 12px;
	}
	.secondary {
		min-height: 44px;
		margin-top: 12px;
		color: #c7d2fe;
	}
	.add-set {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 12px;
		padding-top: 8px;
	}
	.add-set select {
		min-width: 0;
		background: #0b1220;
		color: #c4cede;
		padding: 10px;
		border-radius: 9px;
		border: 1px solid #46546b;
		font-size: 14px;
	}
	.add-set button {
		min-height: 46px;
		border: 1px solid #677a9a;
		border-radius: 9px;
		font-weight: 600;
		color: #d5dfff;
	}
	button {
		cursor: pointer;
	}
	button:disabled {
		opacity: 0.5;
	}
	footer {
		position: fixed;
		bottom: 0;
		left: 0;
		right: 0;
		background: #0d1421f5;
		border-top: 1px solid #303c50;
		padding: 10px 16px max(12px, env(safe-area-inset-bottom));
		backdrop-filter: blur(12px);
	}
	.footer-inner {
		max-width: 648px;
		margin: auto;
	}
	footer p {
		font-size: 11px;
		color: #b6c3d5;
		text-align: center;
		margin-bottom: 8px;
	}
	.footer-actions {
		display: flex;
		gap: 8px;
		align-items: center;
		justify-content: space-between;
	}
	.footer-actions a,
	.footer-actions button {
		min-height: 46px;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 13px;
		font-weight: 600;
		padding: 10px 12px;
		border-radius: 9px;
	}
	.footer-actions a {
		color: #c7d2fe;
	}
	.footer-actions button {
		background: #c7d2fe;
		color: #182044;
	}
	.history-tools {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 20px;
		color: #c7d2fe;
		font-size: 14px;
	}
	.trash {
		color: #fda4af;
		min-height: 44px;
	}
	.error {
		color: #fda4af;
		padding: 12px 0;
	}
</style>
