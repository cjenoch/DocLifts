<script lang="ts">
	import { requestId as newRequestId } from '$lib/request-id';
	import { enhance } from '$app/forms';
	import { onMount, tick, untrack } from 'svelte';
	import type { ActionData, PageData } from './$types';
	import SetRow from './SetRow.svelte';
	import MachinePicker from '$lib/MachinePicker.svelte';
	import AddSheet from '$lib/AddSheet.svelte';
	import { pickerUi } from '$lib/picker-ui';
	import TrashAction from '$lib/TrashAction.svelte';
	import { workoutUi } from '$lib/workout-ui';
	import { photoClientSettings, resizeForUpload } from '$lib/photo-client';
	import type { SubmitFunction } from '@sveltejs/kit';
	import type { Action } from 'svelte/action';
	let { data, form }: { data: PageData; form: ActionData } = $props();
	let dirtyIds = $state<string[]>([]);
	let appending = $state<string | null>(null);
	// The add sheet opens on a tap (0.8.0). An empty quick workout no longer
	// opens it by itself: it is full-screen, and would cover "Photo next machine".
	let pickerOpen = $state(false);
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
	// Photo in the workout (0.6.0). A photo opens a block at once; the page
	// then reads it while sets are logged. Photo ids the page should read once
	// (just uploaded), ids being read now, and match cards put off with "Later".
	let autoRead = $state<string[]>([]);
	let readingIds = $state<string[]>([]);
	let laterIds = $state<string[]>([]);
	let photoStage = $state<string | null>(null);
	let photoError = $state('');
	let photoRequestId = $state('');
	let photoForm: HTMLFormElement | undefined = $state();
	onMount(() => {
		photoRequestId = newRequestId();
	});
	const toName = $derived(Object.keys(data.photoBlocks).length);

	const photoSubmit: SubmitFunction = async ({ formData, cancel }) => {
		if (photoStage) return cancel();
		photoError = '';
		photoStage = photoClientSettings.labels.preparing;
		const chosen = formData.get('photo');
		if (!(chosen instanceof File) || chosen.size === 0) {
			photoStage = null;
			return cancel();
		}
		const sent = await resizeForUpload(chosen);
		formData.set('photo', sent, sent.name);
		formData.set('clientOriginalBytes', String(chosen.size));
		formData.set('clientResized', sent === chosen ? '0' : '1');
		// The phone's own clock for the placeholder's label ("Photo 2:32 PM").
		formData.set(
			'timeLabel',
			new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
		);
		photoStage = workoutUi.photoAdding;
		return async ({ result, update }) => {
			try {
				if (result.type === 'success' && result.data?.photoId) {
					autoRead = [...autoRead, String(result.data.photoId)];
					photoRequestId = newRequestId();
				} else if (result.type === 'failure') {
					photoError = String(result.data?.message ?? workoutUi.photoReadFailed);
				} else if (result.type === 'error') {
					photoError = 'The photo did not get through. Try again.';
					return;
				}
				await update({ reset: true });
			} finally {
				photoStage = null;
			}
		};
	};

	const readSubmit =
		(photoId: string): SubmitFunction =>
		() => {
			readingIds = [...readingIds, photoId];
			autoRead = autoRead.filter((id) => id !== photoId);
			return async ({ update }) => {
				try {
					await update();
				} finally {
					readingIds = readingIds.filter((id) => id !== photoId);
				}
			};
		};

	/** Submits the block's read form once, right after its photo was added. */
	const readOnce: Action<HTMLFormElement, boolean> = (form, go) => {
		if (go) form.requestSubmit();
	};

	const allSets = $derived(data.groups.flatMap((g) => g.sets));
	const completed = $derived(
		allSets.filter((s) => s.executedLoad != null && s.executedReps != null).length
	);
</script>

<svelte:head><title>{heading} · DocLifts</title></svelte:head>
<main class="workout">
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
			{#if group.occurrenceId && data.photoBlocks[group.occurrenceId]}
				{@const pb = data.photoBlocks[group.occurrenceId]}
				<div class="photo-block" data-testid="photo-block">
					{#if pb.kind === 'reading' && (readingIds.includes(pb.photoId) || autoRead.includes(pb.photoId))}
						<p class="photo-line" aria-live="polite">{workoutUi.photoReading}</p>
					{:else if pb.kind === 'match' && !laterIds.includes(group.occurrenceId)}
						<form method="POST" action="?/identify" use:enhance class="identify">
							<p class="model">{pb.modelLabel}</p>
							<input type="hidden" name="occurrenceId" value={group.occurrenceId} />
							<input type="hidden" name="modelId" value={pb.modelId} />
							<label
								>{workoutUi.photoExerciseLabel}<input
									name="exerciseName"
									value={pb.exerciseName}
									maxlength="120"
									autocomplete="off"
									autocapitalize="words"
									spellcheck="false"
								/></label
							>
							<label
								>{workoutUi.photoWeightLabel}<select name="loadConvention">
									{#if pb.equipmentType === 'machine-plate'}<option
											value="plates_per_side"
											selected={pb.loadConvention === 'plates_per_side'}>Plates per side</option
										><option value="total_plates" selected={pb.loadConvention === 'total_plates'}
											>All plates combined</option
										>{/if}
									<option value="per_arm" selected={pb.loadConvention === 'per_arm'}
										>Per hand / arm</option
									><option value="displayed" selected={pb.loadConvention === 'displayed'}
										>Total or displayed weight</option
									><option value="unknown" selected={pb.loadConvention === 'unknown'}
										>Not sure — keep separate</option
									>
								</select></label
							>
							<div class="identify-actions">
								<button class="use">{workoutUi.photoUseThis}</button><button
									type="button"
									class="later"
									onclick={() => (laterIds = [...laterIds, group.occurrenceId!])}
									>{workoutUi.photoLater}</button
								>
							</div>
							<a class="other" href="/photos/{pb.photoId}/review">{workoutUi.photoOtherMachine}</a>
						</form>
					{:else if pb.kind !== 'match'}
						<p class="photo-line">{workoutUi.photoReadFailed}</p>
					{/if}
					{#if pb.kind === 'reading'}
						<form
							method="POST"
							action="?/readPhoto"
							class="photo-actions"
							use:enhance={readSubmit(pb.photoId)}
							use:readOnce={autoRead.includes(pb.photoId)}
						>
							<input type="hidden" name="photoId" value={pb.photoId} />
							{#if !readingIds.includes(pb.photoId) && !autoRead.includes(pb.photoId)}<button
									>{workoutUi.photoReadAgain}</button
								><a href="/photos/{pb.photoId}/review">{workoutUi.photoNameIt}</a>{/if}
						</form>
					{:else if pb.kind === 'none' || laterIds.includes(group.occurrenceId)}
						<div class="photo-actions">
							<a href="/photos/{pb.photoId}/review">{workoutUi.photoNameIt}</a>
						</div>
					{/if}
				</div>
			{/if}
			{#if !data.session.endedAt && group.occurrenceId && data.namedPhotoBlocks[group.occurrenceId]}
				<form
					method="POST"
					action="?/undoIdentify"
					class="photo-named"
					data-testid="photo-named"
					use:enhance={({ formData }) => {
						// The new placeholder's label carries the phone's own time.
						formData.set(
							'timeLabel',
							new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
						);
					}}
				>
					<input type="hidden" name="occurrenceId" value={group.occurrenceId} />
					<span
						>{workoutUi.photoNamedFrom(data.namedPhotoBlocks[group.occurrenceId].modelLabel)}</span
					><button>{workoutUi.photoUndo}</button>
				</form>
			{/if}
			{#if !data.session.endedAt && group.occurrenceId && !data.photoBlocks[group.occurrenceId]}<details
					class="equipment"
				>
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
	{#if !data.session.endedAt && data.picker}
		<!-- The add sheet (0.8.0, machines spec Parts I and J). -->
		<button class="add-trigger" onclick={() => (pickerOpen = true)}>+ {pickerUi.addExercise}</button
		>
		<AddSheet
			picker={data.picker}
			sessionId={data.session.id}
			photoGymId={data.photoEnabled ? data.session.gymId : null}
			bind:open={pickerOpen}
		/>
	{/if}
</main>
{#if !data.session.endedAt}<footer>
		<div class="footer-inner">
			{#if data.photoEnabled}<form
					method="POST"
					action="?/photo"
					enctype="multipart/form-data"
					class="photo-form"
					bind:this={photoForm}
					use:enhance={photoSubmit}
				>
					<input type="hidden" name="requestId" value={photoRequestId} />
					<!-- No capture attribute: the phone offers camera, library and files (0.4.2). -->
					<label class="photo-next" class:busy={photoStage !== null}
						>{photoStage ?? workoutUi.photoNextMachine}<input
							type="file"
							name="photo"
							id="photo-next-input"
							accept="image/jpeg,image/png,image/webp"
							class="sr-only"
							disabled={photoStage !== null}
							onchange={() => photoForm?.requestSubmit()}
						/></label
					>
					{#if photoError}<p role="alert" class="photo-error">{photoError}</p>{/if}
				</form>{/if}
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
	.photo-block {
		margin-bottom: 14px;
		font-size: 14px;
	}
	.photo-line {
		color: #b6c5da;
	}
	.photo-actions {
		display: flex;
		gap: 16px;
		align-items: center;
		margin-top: 6px;
	}
	.photo-actions a,
	.photo-actions button {
		min-height: 44px;
		display: inline-flex;
		align-items: center;
		color: #c7d2fe;
		font-weight: 600;
	}
	.identify {
		display: grid;
		gap: 10px;
		border: 1px solid #3b4a63;
		border-radius: 12px;
		padding: 12px;
	}
	.identify .model {
		font-weight: 600;
		color: #e2e8f0;
	}
	.identify label {
		display: grid;
		gap: 4px;
		color: #b6c5da;
		font-size: 13px;
	}
	.identify input,
	.identify select {
		background: #0b1220;
		color: #e2e8f0;
		border: 1px solid #46546b;
		border-radius: 9px;
		padding: 10px;
		font-size: 16px;
	}
	.identify-actions {
		display: flex;
		gap: 8px;
	}
	.identify-actions button {
		min-height: 44px;
		flex: 1;
		border-radius: 9px;
		font-weight: 600;
	}
	.identify-actions .use {
		background: #c7d2fe;
		color: #182044;
	}
	.identify-actions .later {
		border: 1px solid #46546b;
		color: #c7d2fe;
	}
	.identify .other {
		min-height: 44px;
		display: inline-flex;
		align-items: center;
		color: #c7d2fe;
		font-size: 13px;
		font-weight: 600;
	}
	.photo-named {
		display: flex;
		gap: 12px;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 12px;
		font-size: 13px;
		color: #b6c5da;
	}
	.photo-named button {
		min-height: 44px;
		color: #c7d2fe;
		font-weight: 600;
		flex: none;
	}
	.photo-form {
		margin-bottom: 8px;
	}
	.photo-next {
		min-height: 48px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 10px;
		background: #059669;
		color: #fff;
		font-weight: 700;
		font-size: 15px;
		cursor: pointer;
	}
	.photo-next.busy {
		opacity: 0.7;
	}
	.photo-error {
		color: #fda4af;
		font-size: 12px;
		text-align: center;
		margin-top: 6px;
	}
</style>
