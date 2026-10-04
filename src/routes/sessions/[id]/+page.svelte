<script lang="ts">
	import { requestId as newRequestId } from '$lib/request-id';
	import { enhance } from '$app/forms';
	import { onMount, tick, untrack } from 'svelte';
	import { WorkoutLayoutPreferences } from '$lib/workout-layout.svelte';
	import WorkoutControls from '$lib/WorkoutControls.svelte';
	import RestTimer from '$lib/RestTimer.svelte';
	import type { ActionData, PageData } from './$types';
	import SetRow from './SetRow.svelte';
	import ExerciseMenu from './ExerciseMenu.svelte';
	import WorkoutPhotoBlock from './WorkoutPhotoBlock.svelte';
	import WorkoutPhotoUpload from './WorkoutPhotoUpload.svelte';
	import { WorkoutPhotos } from './workout-photos.svelte';
	import { WorkoutEdits } from './workout-edits.svelte';
	import AddSheet from '$lib/AddSheet.svelte';
	import { FREE_TYPES, pickerUi } from '$lib/picker-ui';
	import TrashAction from '$lib/TrashAction.svelte';
	import { workoutUi } from '$lib/workout-ui';
	let { data, form }: { data: PageData; form: ActionData } = $props();
	let dirtyIds = $state<string[]>([]);
	let appending = $state<string | null>(null);
	// The add sheet opens on a tap (0.8.0). An empty quick workout no longer
	// opens it by itself: it is full-screen, and would cover "Photo next machine".
	let pickerOpen = $state(false);
	// Bind mode (0.8.1): which planned exercise is choosing its machine.
	let bindOpen = $state(false);
	let bindTarget = $state<{
		occurrenceId: string;
		exerciseId: string;
		exerciseName: string;
		equipmentType: string;
	} | null>(null);
	const FREE_WEIGHT_UI = new Set(FREE_TYPES as readonly string[]);
	const preferences = new WorkoutLayoutPreferences();
	let editing = $state(false);
	let timer: RestTimer | undefined = $state();
	let guidedGroup = $state<string | null>(null);
	let guidedSets = $state<Record<string, string>>({});
	$effect(() => preferences.restore(data.user!.id, data.session.programId, data.quick));
	const activeGroup = $derived(
		data.groups.find((g) => g.key === guidedGroup)?.key ??
			data.groups.find((g) => g.sets.some((s) => s.executedLoad == null || s.executedReps == null))
				?.key ??
			data.groups[0]?.key
	);
	const currentSet = (g: PageData['groups'][number]) =>
		guidedSets[g.key] ??
		g.sets.find((s) => s.executedLoad == null || s.executedReps == null)?.id ??
		g.sets.at(-1)?.id;
	function savedSet(id: string) {
		timer?.start();
		const group = data.groups.find((g) => g.sets.some((s) => s.id === id));
		if (group) {
			const next = group.sets.find(
				(s) => s.id !== id && (s.executedLoad == null || s.executedReps == null)
			);
			if (next) guidedSets[group.key] = next.id;
		}
	}
	// Editing a live workout (editor spec, Part L).
	let swapOpen = $state(false);
	let swapTarget = $state<{
		occurrenceId: string;
		exerciseId: string;
		exerciseName: string;
		planned: boolean;
	} | null>(null);
	const edits = new WorkoutEdits();

	const heading = $derived(data.quick ? workoutUi.sessionHeading : data.day.name);
	const backHref = $derived(data.quick ? '/' : `/programs/${data.session.programId}`);
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
	const photos = new WorkoutPhotos();
	const toName = $derived(Object.keys(data.photoBlocks).length);

	const allSets = $derived(data.groups.flatMap((g) => g.sets));
	const completed = $derived(
		allSets.filter((s) => s.executedLoad != null && s.executedReps != null).length
	);
</script>

<svelte:head><title>{heading} · DocLifts</title></svelte:head>
<main
	class="workout"
	class:modern={!data.session.endedAt}
	data-layout={preferences.layout}
	class:editing
>
	<a class="back" href={backHref}>{data.quick ? '← Workout' : '← Program'}</a>
	<header>
		<div class="eyebrow">DOCLIFTS / {data.session.endedAt ? 'WORKOUT HISTORY' : 'IN SESSION'}</div>
		<h1>{heading}</h1>
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
	<WorkoutControls {preferences} bind:editing ended={data.session.endedAt != null} />
	{#if editing}<section class="edit-intro">
			<h2>Edit this workout</h2>
			<p>
				Use each exercise’s menu to move, skip, swap or remove it. Set changes apply today; logged
				sets stay protected.
			</p>
			{#if !data.quick}<a href="/programs/{data.session.programId}/edit"
					>Edit program for future workouts</a
				>{/if}
		</section>{/if}
	{#if preferences.layout === 'guided' && !editing && data.groups.length}
		<label class="exercise-picker"
			>Exercise<select
				aria-label="Current exercise"
				value={activeGroup}
				onchange={(event) => (guidedGroup = event.currentTarget.value)}
				>{#each data.groups as group}<option value={group.key}>{group.exerciseName}</option
					>{/each}</select
			></label
		>
	{/if}

	{#if !data.session.endedAt && data.groups.length === 0}
		<section
			class="mb-5 rounded-xl border border-indigo-800 bg-indigo-950/40 p-5"
			data-testid="first-machine-guide"
		>
			<h2 class="text-lg font-semibold">
				{data.photoEnabled ? 'Start with your first machine' : 'Add your first exercise'}
			</h2>
			<p class="mt-2 text-sm text-zinc-300">
				{data.photoEnabled
					? 'Tap Photo next machine below. Keep people out of the frame and include the machine or its label.'
					: 'Tap Add exercise below and choose what you want to log.'}
			</p>
			<p class="mt-2 text-sm text-zinc-400">
				{data.photoEnabled
					? 'Once the photo is accepted, enter your weight and reps while identification runs. Tap Save set after each set.'
					: 'Enter your weight and reps, then tap Save set after each set.'}
			</p>
			{#if data.photoEnabled}<p class="mt-2 text-sm text-zinc-400">
					Using free weights? Add an exercise by name instead.
				</p>{/if}
		</section>
	{/if}
	{#if toName}<p class="to-name" data-testid="machines-to-name">
			{workoutUi.machinesToName(toName)}
		</p>{/if}
	{#if data.session.endedAt}<div class="history-tools">
			{#if data.allowEndedSessionEdit}
				<a href="/sessions/{data.session.id}">Done editing</a>
				<TrashAction
					action="?/deleteSession"
					label="Move to Trash"
					confirmation="Move this workout to Trash? You can restore it later."
					confirmationField="confirmDelete"
					confirmationValue="d"
					destructive
				/>
			{:else}
				<span class="muted">Completed workout</span>
				<a href="/sessions/{data.session.id}?edit=1">Edit workout</a>
			{/if}
		</div>{/if}
	{#if form && 'message' in form && form.message}<p role="alert" class="error">
			{form.message}
		</p>{/if}
	{#if data.programUpdate}
		<p class="program-update" role="status" data-testid="program-update">
			{data.programUpdate.kind === 'updated'
				? workoutUi.programUpdated
				: workoutUi.programUpdateFailed[data.programUpdate.reason]}
			{#if data.programUpdate.kind === 'updated'}<a href="/programs/{data.programUpdate.programId}"
					>{workoutUi.viewProgram}</a
				>{/if}
		</p>
	{/if}
	{#if data.saveAsProgram && !data.session.deletedAt}
		<section class="save-program" data-testid="save-as-program">
			<h2>{workoutUi.saveAsProgram}</h2>
			<p class="muted">{workoutUi.saveAsProgramNote}</p>
			<a class="save-link primary" href="/programs/new?fromSession={data.session.id}"
				>{workoutUi.newProgramFromWorkout}</a
			>
			{#each data.saveAsProgram.programs as program (program.id)}
				<a class="save-link" href="/programs/{program.id}/edit?fromSession={data.session.id}"
					>{workoutUi.addAsDayTo(program.name)}</a
				>
			{/each}
		</section>
	{/if}
	{#if edits.pendingRemove}
		<p class="undo-bar" role="status" data-testid="undo-remove">
			<span>{workoutUi.removedLine(edits.pendingRemove.name)}</span>
			<button onclick={edits.undoRemove}>{workoutUi.undo}</button>
		</p>
	{/if}
	{#if edits.editError}<p role="alert" class="error">{edits.editError}</p>{/if}
	{#each data.groups.filter((g) => g.occurrenceId !== edits.pendingRemove?.occurrenceId) as group, index (group.key)}
		{@const photoId =
			(group.occurrenceId &&
				(data.photoBlocks[group.occurrenceId]?.photoId ??
					data.namedPhotoBlocks[group.occurrenceId]?.photoId)) ||
			(group.sets[0]?.gymEquipmentId && data.machinePhotos[group.sets[0].gymEquipmentId])}
		<section
			class="exercise"
			id="exercise-{group.key}"
			tabindex="-1"
			hidden={preferences.layout === 'guided' && !editing && group.key !== activeGroup}
		>
			{#if preferences.layout === 'guided' && !editing}
				{#if photoId}<img
						class="machine-photo"
						src="/photos/{photoId}/image"
						alt={group.machineLabel ?? group.exerciseName}
					/>{:else}<div class="no-photo">No machine photo yet</div>{/if}
			{/if}
			<div class="exercise-heading">
				<span class="number">{String(index + 1).padStart(2, '0')}</span>
				<div class="heading-text">
					<h2>{group.exerciseName}</h2>
					<p class="muted">
						{group.gymName
							? `${group.gymName} · ${group.machineLabel}`
							: 'Equipment not specified'}{group.loadConvention !== 'legacy'
							? ` · ${group.loadConvention.replaceAll('_', ' ')}`
							: ''}
					</p>
				</div>
				{#if !data.session.endedAt && group.occurrenceId}
					<ExerciseMenu
						{group}
						occurrenceId={group.occurrenceId}
						{index}
						groupCount={data.groups.filter(
							(g) => g.occurrenceId !== edits.pendingRemove?.occurrenceId
						).length}
						quick={data.quick}
						photoBlock={!!data.photoBlocks[group.occurrenceId]}
						{editing}
						{edits}
						onswap={(target) => {
							swapTarget = target;
							swapOpen = true;
						}}
					/>
				{/if}
			</div>
			{#if group.occurrenceId}
				<WorkoutPhotoBlock
					occurrenceId={group.occurrenceId}
					block={data.photoBlocks[group.occurrenceId]}
					named={data.namedPhotoBlocks[group.occurrenceId]}
					live={!data.session.endedAt}
					{photos}
				/>
			{/if}
			{#if !data.session.endedAt && group.occurrenceId && !data.photoBlocks[group.occurrenceId] && !FREE_WEIGHT_UI.has(group.equipmentType) && !group.sets.some((x) => x.executedLoad != null || x.executedReps != null || x.executedRir != null || x.notes)}
				<!-- The machine for a planned exercise (0.8.1): the add sheet in bind mode,
				     with a confirm step. Refused by the server once a set is logged. -->
				<button
					class="secondary"
					onclick={() => {
						bindTarget = {
							occurrenceId: group.occurrenceId!,
							exerciseId: group.exerciseId,
							exerciseName: group.exerciseName,
							equipmentType: group.equipmentType
						};
						bindOpen = true;
					}}>{group.machineLabel ? pickerUi.changeMachine : pickerUi.chooseMachine}</button
				>
			{/if}
			{#if preferences.layout === 'guided' && !editing}<label class="set-picker"
					>Set<select
						aria-label="Current set"
						value={currentSet(group)}
						onchange={(event) => (guidedSets[group.key] = event.currentTarget.value)}
						>{#each group.sets as set}<option value={set.id}
								>Set {set.position} · {set.setRole}{set.executedLoad != null &&
								set.executedReps != null
									? ' · saved'
									: ''}</option
							>{/each}</select
					></label
				>{/if}
			<ul class:tap-grid={preferences.layout === 'tap' && !editing}>
				<!--
					Keyed by the set's identity, not its id alone (0.6.2): SetRow captures
					its machine and weight format once, for the stale-tab guard and its
					draft. When a photo block is named (or undone) they change, and the
					row must start again: fresh identity, last time's numbers. Before,
					the row kept the placeholder's identity, showed no prefill, and its
					save was refused until a reload.
				-->
				{#each group.sets as set (`${set.id}:${set.gymEquipmentId}:${set.loadConvention}`)}<SetRow
						{set}
						layout={editing ? 'table' : preferences.layout}
						rirChoice={preferences.rir}
						showNotes={preferences.notes}
						showHistory={preferences.history}
						steppers={preferences.steppers}
						hidden={preferences.layout === 'guided' && !editing && set.id !== currentSet(group)}
						onstartsave={() => timer?.prepare()}
						sessionEnded={data.session.endedAt != null}
						allowEndedSessionEdit={data.allowEndedSessionEdit}
						{ondirty}
						onsaved={savedSet}
					/>{/each}
			</ul>
			{#if !data.session.endedAt}<form
					class="add-set"
					class:tool-hidden={!editing}
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
						class:tool-hidden={!editing}
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
	{#if !data.session.endedAt && data.picker}
		<!-- The add sheet (0.8.0, machines spec Parts I and J). -->
		<button
			class="add-trigger"
			class:tool-hidden={!editing && data.groups.length > 0}
			onclick={() => (pickerOpen = true)}>+ {pickerUi.addExercise}</button
		>
		<AddSheet
			picker={data.picker}
			sessionId={data.session.id}
			photoGymId={data.photoEnabled ? data.session.gymId : null}
			bind:open={pickerOpen}
		/>
		{#if swapTarget}
			{#key swapTarget.occurrenceId}
				<AddSheet
					picker={data.picker}
					sessionId={data.session.id}
					swap={swapTarget}
					bind:open={swapOpen}
				/>
			{/key}
		{/if}
		{#if bindTarget}
			{#key bindTarget.occurrenceId}
				<AddSheet
					picker={data.picker}
					sessionId={data.session.id}
					bind={bindTarget}
					bind:open={bindOpen}
				/>
			{/key}
		{/if}
	{/if}
</main>
{#if !data.session.endedAt}<footer>
		<div class="footer-inner">
			{#if data.photoEnabled}<WorkoutPhotoUpload
					{photos}
					accepted={data.photoNoticeAccepted}
				/>{/if}
			{#key data.session.id}<RestTimer
					bind:this={timer}
					sessionId={data.session.id}
					userId={data.user!.id}
				/>{/key}
			<p aria-live="polite">
				{dirtyIds.length
					? `${dirtyIds.length} unsaved ${dirtyIds.length === 1 ? 'set' : 'sets'} · drafts kept in this tab`
					: 'Saved sets are stored in your workout'}
			</p>
			<div class="footer-actions">
				<a href={backHref}>Pause</a><button
					type="button"
					class="jump-add"
					onclick={() => (pickerOpen = true)}>{pickerUi.addExercise}</button
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
	.tool-hidden {
		display: none !important;
	}
	.exercise[hidden] {
		display: none;
	}
	.modern.workout {
		max-width: 520px;
		padding-top: 12px;
	}
	.modern header {
		padding: 12px 0 4px;
	}
	.modern .eyebrow,
	.modern progress,
	.modern .progress-copy,
	.modern > .back {
		display: none;
	}
	.modern .exercise {
		background: transparent;
		border: 0;
		border-radius: 0;
		padding: 0 0 14px;
		margin-bottom: 20px;
		border-bottom: 1px solid #2e3b32;
	}
	.modern .exercise-heading {
		margin-bottom: 8px;
		align-items: center;
	}
	.modern .number {
		display: none;
	}
	.modern h2 {
		font-size: 19px;
	}
	.modern .muted {
		color: #a7b8ac;
		font-size: 12px;
	}
	.machine-photo {
		display: block;
		width: 100%;
		max-height: 240px;
		object-fit: contain;
		border-radius: 14px;
		margin-bottom: 18px;
		background: #18211b;
	}
	.no-photo {
		padding: 28px;
		text-align: center;
		background: #152119;
		border-radius: 14px;
		color: #a3b6aa;
		margin-bottom: 18px;
		font-size: 13px;
	}
	.exercise-picker,
	.set-picker {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		color: #afc2b5;
		font-size: 13px;
		margin: 12px 0 18px;
	}
	.exercise-picker select,
	.set-picker select {
		max-width: 80%;
		min-height: 44px;
		background: #17261c;
		color: #eef6ef;
		border: 1px solid #34513e;
		border-radius: 10px;
		padding: 8px;
		font-size: 16px;
	}
	.tap-grid {
		display: grid;
		grid-template-columns: repeat(5, minmax(0, 1fr));
		gap: 8px;
	}
	.edit-intro {
		margin: 8px 0 20px;
		padding: 16px;
		background: #18241c;
		border-radius: 14px;
	}
	.edit-intro p {
		font-size: 13px;
		line-height: 1.5;
		color: #b2c3b8;
		margin: 8px 0;
	}
	.edit-intro a {
		display: inline-block;
		min-height: 44px;
		padding: 12px 0;
		text-decoration: underline;
		color: #b0e8c1;
		font-size: 14px;
	}
	[data-layout='notebook'] .exercise {
		font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
	}
	.remove-set {
		min-height: 44px;
		font-size: 12px;
		color: #acb8ca;
		margin-top: 6px;
	}
	.workout {
		max-width: 680px;
		margin: auto;
		padding: 28px 16px 220px;
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
	.heading-text {
		flex: 1;
		min-width: 0;
	}
	.save-program {
		margin-bottom: 20px;
		padding: 14px 18px;
		border: 1px solid #2b3648;
		border-radius: 18px;
		background: #121a28;
	}
	.save-program h2 {
		margin-bottom: 4px;
	}
	.save-link {
		display: flex;
		align-items: center;
		min-height: 44px;
		margin-top: 8px;
		padding: 0 14px;
		border: 1px solid #3f3f46;
		border-radius: 10px;
		color: #c7d2fe;
	}
	.save-link.primary {
		justify-content: center;
		border-color: #6366f1;
		background: #4f46e5;
		color: #fff;
		font-weight: 600;
	}
	.undo-bar,
	.program-update {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		margin-bottom: 16px;
		padding: 8px 14px;
		border-radius: 12px;
		background: #1e1b4b;
		color: #e0e7ff;
	}
	.undo-bar button,
	.program-update a {
		min-height: 44px;
		font-weight: 600;
		color: #a5b4fc;
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
	.add-trigger {
		width: 100%;
		min-height: 52px;
		border: 1px dashed #46546b;
		border-radius: 12px;
		color: #c7d2fe;
		font-weight: 600;
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
	.footer-actions .jump-add {
		background: none;
		color: #c7d2fe;
	}
	.history-tools {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 20px;
		color: #c7d2fe;
		font-size: 14px;
	}
	.error {
		color: #fda4af;
		padding: 12px 0;
	}
	.to-name {
		margin-bottom: 16px;
		color: #fcd34d;
		font-size: 14px;
		font-weight: 600;
	}
</style>
