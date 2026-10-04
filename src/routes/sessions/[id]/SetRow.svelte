<script lang="ts">
	import { enhance } from '$app/forms';
	import { beforeNavigate } from '$app/navigation';
	import { onMount, untrack } from 'svelte';
	import type { PageData } from './$types';
	import type { WorkoutViewMode } from '$lib/workout-view.svelte';
	import { workoutUi as ui } from '$lib/workout-ui';
	type Set = PageData['groups'][number]['sets'][number];
	let {
		set,
		sessionEnded,
		allowEndedSessionEdit,
		ondirty,
		onsaved = () => {},
		viewMode = 'advanced'
	}: {
		set: Set;
		sessionEnded: boolean;
		allowEndedSessionEdit: boolean;
		ondirty: (id: string, dirty: boolean) => void;
		/** A set was saved (Part F: starts the rest timer). */
		onsaved?: (id: string) => void;
		viewMode?: WorkoutViewMode;
	} = $props();
	const identity = untrack(() => `${set.gymEquipmentId ?? 'legacy'}:${set.loadConvention}`);
	const key = untrack(() => `doclifts:set-draft:${set.id}`);
	let load = $state<number | undefined>(
		untrack(() => set.executedLoad ?? set.prescribedLoad ?? undefined)
	);
	// Part F: reps are shown before anything is typed, so the right numbers
	// save in one tap (workoutUi.repsPrefill: the bottom of the target range).
	const repsShown = () =>
		set.executedReps ??
		(ui.repsPrefill === 'min'
			? set.prescribedRepsMin
			: ui.repsPrefill === 'max'
				? set.prescribedRepsMax
				: null) ??
		undefined;
	let reps = $state<number | undefined>(untrack(repsShown));
	let rir = $state<number | undefined>(untrack(() => set.executedRir ?? undefined));
	let notes = $state(untrack(() => set.notes ?? ''));
	const values = () => JSON.stringify([load ?? null, reps ?? null, rir ?? null, notes]);
	const persisted = () =>
		JSON.stringify([
			set.executedLoad,
			set.executedReps,
			set.executedRir,
			set.notes,
			set.gymEquipmentId,
			set.loadConvention
		]);
	let baseline = $state(untrack(values));
	let ready = $state(false);
	let storageOk = $state(true);
	let saving = $state(false);
	let message = $state('');
	let notesOpen = $state(untrack(() => Boolean(set.notes)));
	let detailsOpen = $state(false);
	const simple = $derived(viewMode === 'simple');
	const showDetails = $derived(!simple || detailsOpen);
	const dirty = $derived(values() !== baseline);
	const completed = $derived(set.executedLoad != null && set.executedReps != null);
	const editable = $derived(!sessionEnded || allowEndedSessionEdit);
	const seconds = $derived(set.targetMetric === 'seconds');
	// One tap moves weight by the machine's own increment when it is known.
	const weightStep = $derived(
		set.incrementLb ?? ui.weightStep[set.loadConvention] ?? ui.weightStep.default
	);
	const repStep = $derived(seconds ? ui.secondsStep : ui.repsStep);
	const round = (n: number) => Math.round(n * 100) / 100;
	function stepLoad(direction: 1 | -1) {
		load = Math.max(0, round((load ?? 0) + direction * weightStep));
	}
	function stepReps(direction: 1 | -1) {
		reps = Math.max(0, (reps ?? 0) + direction * repStep);
	}
	/** After a save, bring the next set still to log into view; no keyboard. */
	function showNext() {
		const rows = [...document.querySelectorAll<HTMLElement>('li[id^="set-"]')];
		const next = rows
			.slice(rows.findIndex((r) => r.id === `set-${set.id}`) + 1)
			.find((r) => !r.classList.contains('completed'));
		next?.scrollIntoView({ behavior: 'smooth', block: 'center' });
	}
	onMount(() => {
		try {
			const raw = sessionStorage.getItem(key);
			if (raw && editable) {
				const draft = JSON.parse(raw);
				if (
					draft.identity === identity &&
					draft.persisted === persisted() &&
					Array.isArray(draft.values) &&
					draft.values.length === 4 &&
					draft.values.slice(0, 3).every((v: unknown) => v === null || typeof v === 'number') &&
					typeof draft.values[3] === 'string'
				) {
					[load, reps, rir] = draft.values.slice(0, 3).map((v: number | null) => v ?? undefined);
					notes = draft.values[3];
					notesOpen = Boolean(notes);
				} else sessionStorage.removeItem(key);
			}
		} catch {
			storageOk = false;
		}
		ready = true;
		return () => ondirty(set.id, false);
	});
	$effect(() => {
		if (!ready || !editable) return;
		ondirty(set.id, dirty);
		try {
			if (dirty)
				sessionStorage.setItem(
					key,
					JSON.stringify({ identity, persisted: persisted(), values: JSON.parse(values()) })
				);
			else sessionStorage.removeItem(key);
		} catch {
			storageOk = false;
		}
	});
	beforeNavigate(({ cancel }) => {
		if (
			dirty &&
			!storageOk &&
			!confirm('This browser cannot keep your draft. Leave without saving this set?')
		)
			cancel();
	});
</script>

<li id="set-{set.id}" class:completed={completed && !dirty} class:dirty>
	<div class="set-heading">
		<span>Set {set.position} <small>{set.setRole === 'top' ? 'Top set' : set.setRole}</small></span
		><span class="status" aria-live="polite"
			>{saving
				? 'Saving…'
				: message
					? 'Needs attention'
					: dirty
						? 'Unsaved'
						: completed
							? '✓ Saved'
							: 'Ready'}</span
		>
	</div>
	<div class="target">
		Target: {set.prescribedLoad ?? '—'} × {set.prescribedRepsMin ?? '—'}{set.prescribedRepsMax !==
		set.prescribedRepsMin
			? `–${set.prescribedRepsMax ?? '—'}`
			: ''}{set.targetMetric === 'seconds' ? ' sec' : ''}{!simple && set.prescribedRir != null
			? ` · ${set.prescribedRir} RIR`
			: ''}
	</div>
	{#if set.history?.executedLoad != null && set.history?.executedReps != null}<div class="history">
			Last: {set.history.executedLoad} × {set.history.executedReps}{set.targetMetric === 'seconds'
				? ' sec'
				: ''}{!simple && set.history.executedRir != null ? ` · ${set.history.executedRir} RIR` : ''}
		</div>{/if}
	{#if set.suggestionReasoning}<p class="suggestion">{set.suggestionReasoning}</p>{/if}
	{#if editable}
		<form
			method="POST"
			action="?/updateSet"
			use:enhance={() => {
				saving = true;
				message = '';
				return async ({ result, update }) => {
					try {
						if (result.type === 'success') {
							baseline = values();
							try {
								sessionStorage.removeItem(key);
							} catch {
								/* Draft warning remains visible. */
							}
							await update({ reset: false });
							onsaved(set.id);
							showNext();
						} else if (result.type === 'failure') {
							const errors = result.data?.fieldErrors as Record<string, string[]> | undefined;
							message = errors
								? Object.values(errors).flat().join(' ')
								: String(result.data?.message ?? 'Check this set and try again.');
						} else message = 'Could not save. Your entry is still here. Try again.';
					} finally {
						saving = false;
					}
				};
			}}
		>
			<input type="hidden" name="setId" value={set.id} /><input
				type="hidden"
				name="expectedIdentity"
				value={identity}
			/>
			{#if allowEndedSessionEdit}<input type="hidden" name="allowEndedSessionEdit" value="1" />{/if}
			<fieldset disabled={saving}>
				<div class="entry">
					<div class="stepper">
						<span class="label">Weight</span>
						<div class="controls">
							<button type="button" aria-label={ui.lessWeight} onclick={() => stepLoad(-1)}
								>−</button
							><input
								type="number"
								name="executedLoad"
								aria-label="Weight"
								min="0"
								step="0.5"
								inputmode="decimal"
								bind:value={load}
							/><button type="button" aria-label={ui.moreWeight} onclick={() => stepLoad(1)}
								>+</button
							>
						</div>
					</div>
					<div class="stepper">
						<span class="label">{seconds ? 'Seconds' : 'Reps'}</span>
						<div class="controls">
							<button type="button" aria-label={ui.lessReps(seconds)} onclick={() => stepReps(-1)}
								>−</button
							><input
								type="number"
								name="executedReps"
								aria-label={seconds ? 'Seconds' : 'Reps'}
								min="0"
								step="1"
								inputmode="numeric"
								bind:value={reps}
							/><button type="button" aria-label={ui.moreReps(seconds)} onclick={() => stepReps(1)}
								>+</button
							>
						</div>
					</div>
				</div>
				<div class="commit" class:compact={!showDetails}>
					<label class="rir" class:hidden={!showDetails}
						><abbr title="Reps in reserve">RIR</abbr><input
							type="number"
							name="executedRir"
							min="0"
							max="10"
							step="1"
							inputmode="numeric"
							placeholder="—"
							oninvalid={() => (detailsOpen = true)}
							bind:value={rir}
						/></label
					><button
						class="save"
						type="submit"
						aria-label={ui.saveSet(set.position)}
						disabled={saving}>{saving ? 'Saving…' : simple ? 'Save set' : '✓'}</button
					>
				</div>
				{#if simple}<button
						type="button"
						class="note-toggle"
						aria-expanded={detailsOpen}
						onclick={() => (detailsOpen = !detailsOpen)}
						>{detailsOpen
							? 'Hide set details'
							: notes || rir != null
								? 'Notes & effort · entered'
								: '+ Notes & effort'}</button
					>{/if}
				<button
					class="note-toggle"
					class:hidden={simple}
					type="button"
					onclick={() => (notesOpen = !notesOpen)}
					aria-expanded={notesOpen}
					>{notesOpen ? 'Hide note' : notes ? 'Edit note' : '+ Note'}</button
				>
				<label class:hidden={simple ? !showDetails : !notesOpen}
					>Set note<input
						name="notes"
						type="text"
						bind:value={notes}
						placeholder="How did it feel?"
					/></label
				>
			</fieldset>
			{#if message}<p role="alert" class="error">{message}</p>{/if}
			{#if dirty && !storageOk}<p class="error">
					Draft storage is unavailable. Save before leaving.
				</p>{/if}
		</form>
	{:else}<p class="result">
			{completed
				? `${set.executedLoad} × ${set.executedReps}${set.targetMetric === 'seconds' ? ' sec' : ''}`
				: 'Not logged'}{set.executedRir != null ? ` · ${set.executedRir} RIR` : ''}
		</p>
		{#if set.notes}<p class="history">{set.notes}</p>{/if}{/if}
</li>

<style>
	li {
		padding: 18px 0;
		border-top: 1px solid #293345;
		scroll-margin-top: 24px;
	}
	.set-heading {
		display: flex;
		justify-content: space-between;
		gap: 8px;
		font-size: 14px;
		font-weight: 600;
	}
	small {
		margin-left: 6px;
		font-weight: 400;
		color: #a8b3c5;
		text-transform: capitalize;
	}
	.status {
		color: #a8b3c5;
		font-size: 12px;
	}
	.completed .status {
		color: #6ee7b7;
	}
	.dirty .status {
		color: #fcd34d;
	}
	.target,
	.history {
		font-size: 12px;
		color: #acb8ca;
		margin-top: 5px;
	}
	.suggestion {
		font-size: 12px;
		color: #c7d2fe;
		margin-top: 5px;
	}
	.entry {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 10px;
		margin-top: 12px;
	}
	.label {
		font-size: 12px;
		color: #c4cede;
	}
	.controls {
		display: grid;
		grid-template-columns: 44px minmax(0, 1fr) 44px;
		gap: 4px;
		margin-top: 5px;
	}
	.controls input {
		margin-top: 0;
		text-align: center;
		padding: 8px 2px;
	}
	.controls button {
		height: 48px;
		border: 1px solid #4b5870;
		border-radius: 9px;
		font-size: 22px;
		color: #c7d2fe;
		background: #111a2c;
	}
	.commit {
		display: grid;
		grid-template-columns: 72px 1fr;
		gap: 10px;
		align-items: end;
		margin-top: 10px;
	}
	.commit.compact {
		grid-template-columns: 1fr;
	}
	.rir input {
		height: 44px;
		font-size: 16px;
		text-align: center;
	}
	label {
		font-size: 12px;
		color: #c4cede;
		min-width: 0;
		display: block;
	}
	input {
		display: block;
		width: 100%;
		min-width: 0;
		height: 48px;
		margin-top: 5px;
		border: 1px solid #4b5870;
		border-radius: 9px;
		padding: 8px;
		font-size: 18px;
		font-variant-numeric: tabular-nums;
		background: #0b1220;
		color: #f1f5f9;
	}
	.save {
		height: 56px;
		border-radius: 12px;
		background: #c7d2fe;
		color: #172044;
		font-weight: 700;
		font-size: 26px;
		cursor: pointer;
	}
	.completed .save {
		background: #203d36;
		color: #8af0c5;
	}
	.note-toggle {
		min-height: 44px;
		font-size: 12px;
		color: #aebcce;
		cursor: pointer;
	}
	.error {
		font-size: 13px;
		color: #fda4af;
		margin-top: 8px;
	}
	.result {
		margin-top: 10px;
		font-size: 20px;
	}
	:disabled {
		opacity: 0.6;
	}
	.hidden {
		display: none;
	}
</style>
