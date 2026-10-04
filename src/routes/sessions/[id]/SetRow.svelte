<script lang="ts">
	import { enhance } from '$app/forms';
	import { beforeNavigate } from '$app/navigation';
	import { onMount, untrack, tick } from 'svelte';
	import type { PageData } from './$types';
	import type { WorkoutLayout, FieldChoice } from '$lib/workout-layout.svelte';
	import type { SubmitFunction } from '@sveltejs/kit';
	import { workoutUi as ui } from '$lib/workout-ui';
	type Set = PageData['groups'][number]['sets'][number];
	let {
		set,
		sessionEnded,
		allowEndedSessionEdit,
		ondirty,
		onsaved = () => {},
		layout = 'guided',
		rirChoice = 'program',
		showNotes = false,
		showHistory = true,
		steppers = false,
		hidden = false,
		onstartsave = () => {}
	}: {
		set: Set;
		sessionEnded: boolean;
		allowEndedSessionEdit: boolean;
		ondirty: (id: string, dirty: boolean) => void;
		/** A set was saved (Part F: starts the rest timer). */
		onsaved?: (id: string) => void;
		layout?: WorkoutLayout;
		rirChoice?: FieldChoice;
		showNotes?: boolean;
		showHistory?: boolean;
		steppers?: boolean;
		hidden?: boolean;
		onstartsave?: () => void;
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
	let tapExpanded = $state(false);
	let entryForm: HTMLFormElement = $state()!;
	const rirVisible = $derived(
		rirChoice === 'show' || (rirChoice === 'program' && set.prescribedRir != null)
	);
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
	const saveSubmit: SubmitFunction = () => {
		onstartsave();
		saving = true;
		message = '';
		// Snapshot exactly what this request sends, never edits made during the response.
		const submitted = values();
		return async ({ result, update }) => {
			try {
				if (result.type === 'success') {
					baseline = submitted;
					try {
						sessionStorage.removeItem(key);
					} catch {
						/* Keep the storage warning. */
					}
					await update({ reset: false });
					tapExpanded = false;
					onsaved(set.id);
					await tick();
					if (layout !== 'tap') {
						const rows = [...document.querySelectorAll<HTMLElement>('li[id^="set-"]')];
						const next = rows
							.slice(rows.findIndex((r) => r.id === `set-${set.id}`) + 1)
							.find(
								(r) => !r.hidden && r.offsetParent !== null && !r.classList.contains('completed')
							);
						next?.scrollIntoView({
							behavior: matchMedia('(prefers-reduced-motion: reduce)').matches
								? 'instant'
								: 'smooth',
							block: 'center'
						});
					}
				} else {
					tapExpanded = true;
					const errors =
						result.type === 'failure'
							? (result.data?.fieldErrors as Record<string, string[]> | undefined)
							: undefined;
					message = errors
						? Object.values(errors).flat().join(' ')
						: result.type === 'failure'
							? String(result.data?.message ?? 'Check this set and try again.')
							: 'Could not save. Your entry is still here. Try again.';
				}
			} catch {
				message = 'Could not confirm the save. Your entry is still here. Try again.';
				tapExpanded = true;
			} finally {
				saving = false;
			}
		};
	};
</script>

<li
	id="set-{set.id}"
	{hidden}
	class:completed={completed && !dirty}
	class:dirty
	class="modern-set"
	class:table-row={layout === 'table'}
	class:notebook-row={layout === 'notebook'}
	class:tap-row={layout === 'tap'}
	class:expanded={tapExpanded || dirty || !!message}
>
	{#if layout !== 'tap' || tapExpanded || dirty || message}
		<div class="modern-heading">
			<span
				>Set {set.position} <small>{set.setRole === 'top' ? 'Top set' : set.setRole}</small></span
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
		{#if layout === 'guided'}<p class="target">
				Target: {set.prescribedLoad ?? '—'} × {set.prescribedRepsMin ??
					'—'}{set.prescribedRepsMax !== set.prescribedRepsMin
					? `–${set.prescribedRepsMax ?? '—'}`
					: ''}{seconds ? ' sec' : ''}{rirVisible && set.prescribedRir != null
					? ` · ${set.prescribedRir} RIR`
					: ''}
			</p>{/if}
	{/if}
	{#if editable}
		<form method="POST" action="?/updateSet" bind:this={entryForm} use:enhance={saveSubmit}>
			<input type="hidden" name="setId" value={set.id} /><input
				type="hidden"
				name="expectedIdentity"
				value={identity}
			/>
			{#if allowEndedSessionEdit}<input type="hidden" name="allowEndedSessionEdit" value="1" />{/if}
			{#if layout === 'tap' && !tapExpanded && !dirty && !message}
				<button
					type="button"
					class="tap-circle"
					aria-label={completed ? `Edit set ${set.position}` : ui.saveSet(set.position)}
					disabled={saving}
					onclick={() => {
						if (completed || rirVisible || load == null || reps == null) tapExpanded = true;
						else entryForm.requestSubmit();
					}}
					>{saving ? '…' : (reps ?? '—')}{#if seconds}<small>sec</small>{/if}</button
				>
				<span class="tap-caption"
					>{set.setRole === 'working' ? `Set ${set.position}` : set.setRole} · {load ?? '—'} lb</span
				>
				{#if set.suggestionReasoning}<span class="tap-reason">{set.suggestionReasoning}</span>{/if}
			{/if}
			<fieldset
				disabled={saving}
				class:hidden={layout === 'tap' && !tapExpanded && !dirty && !message}
			>
				<div class="modern-entry">
					{#if showHistory && layout === 'table'}<div class="previous-cell">
							<span>Previous</span><strong
								>{set.history?.executedLoad ?? '—'} × {set.history?.executedReps ?? '—'}{seconds
									? 's'
									: ''}</strong
							>
						</div>{/if}
					<label class="value-cell"
						>Weight · lb
						<div class="value-control">
							{#if steppers}<button
									type="button"
									aria-label={ui.lessWeight}
									onclick={() => stepLoad(-1)}>−</button
								>{/if}<input
								type="number"
								name="executedLoad"
								aria-label="Weight"
								min="0"
								step="0.5"
								inputmode="decimal"
								bind:value={load}
							/>{#if steppers}<button
									type="button"
									aria-label={ui.moreWeight}
									onclick={() => stepLoad(1)}>+</button
								>{/if}
						</div></label
					>
					<label class="value-cell"
						>{seconds ? 'Seconds' : 'Reps'}
						<div class="value-control">
							{#if steppers}<button
									type="button"
									aria-label={ui.lessReps(seconds)}
									onclick={() => stepReps(-1)}>−</button
								>{/if}<input
								type="number"
								name="executedReps"
								aria-label={seconds ? 'Seconds' : 'Reps'}
								min="0"
								step="1"
								inputmode="numeric"
								bind:value={reps}
							/>{#if steppers}<button
									type="button"
									aria-label={ui.moreReps(seconds)}
									onclick={() => stepReps(1)}>+</button
								>{/if}
						</div></label
					>
					{#if layout === 'table' || layout === 'notebook'}<button
							class="modern-save"
							type="submit"
							aria-label={ui.saveSet(set.position)}
							disabled={saving}
							>{saving
								? '…'
								: layout === 'notebook'
									? 'Log'
									: completed && !dirty
										? '✓'
										: '+'}</button
						>{/if}
				</div>
				{#if showHistory && layout !== 'table' && set.history?.executedLoad != null}<p
						class="history"
					>
						Last: {set.history.executedLoad} × {set.history.executedReps}{seconds
							? ' sec'
							: ''}{rirVisible && set.history.executedRir != null
							? ` · ${set.history.executedRir} RIR`
							: ''}
					</p>{/if}
				{#if set.suggestionReasoning}<p class="suggestion">{set.suggestionReasoning}</p>{/if}
				<label class="effort-field" class:hidden={!rirVisible}
					>RIR<input
						type="number"
						name="executedRir"
						aria-label="RIR"
						min="0"
						max="10"
						step="1"
						inputmode="numeric"
						bind:value={rir}
					/><span>reps left{set.prescribedRir != null ? ` · target ${set.prescribedRir}` : ''}</span
					></label
				>
				<label class:hidden={!showNotes}
					>Set note<input
						name="notes"
						type="text"
						bind:value={notes}
						placeholder="How did it feel?"
					/></label
				>
				{#if layout === 'guided' || layout === 'tap'}<button
						class="modern-save full"
						type="submit"
						aria-label={ui.saveSet(set.position)}
						disabled={saving}>{saving ? 'Saving…' : 'Record this set'}</button
					>{/if}
				{#if layout === 'tap'}<button
						type="button"
						class="note-toggle"
						onclick={() => (tapExpanded = false)}>Close set details</button
					>{/if}
			</fieldset>
			{#if message}<p role="alert" class="error">{message}</p>{/if}
			{#if dirty && !storageOk}<p class="error">
					Draft storage is unavailable. Save before leaving.
				</p>{/if}
		</form>
	{:else}<p class="result">
			{completed
				? `${set.executedLoad} × ${set.executedReps}${seconds ? ' sec' : ''}`
				: 'Not logged'}{rirVisible && set.executedRir != null ? ` · ${set.executedRir} RIR` : ''}
		</p>
		{#if showNotes && set.notes}<p class="history">{set.notes}</p>{/if}{/if}
</li>

<style>
	.modern-set {
		padding: 12px 0;
		border-color: #2d3931;
		min-width: 0;
		color: #e9f1eb;
	}
	.modern-set[hidden] {
		display: none;
	}
	.modern-heading {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 6px;
		font-size: 12px;
		margin-bottom: 6px;
	}
	.modern-set small {
		font-size: 11px;
		margin-left: 4px;
		color: #9bac9f;
	}
	.modern-entry {
		display: flex;
		align-items: end;
		gap: 8px;
		margin: 8px 0;
	}
	.value-cell {
		flex: 1;
		min-width: 0;
		font-size: 11px;
		color: #adbbb1;
	}
	.value-control {
		display: flex;
		gap: 3px;
		align-items: center;
	}
	.value-control input {
		font-size: 18px;
		height: 46px;
		text-align: center;
		background: #19271e;
		border-color: #34463b;
		color: #f0f7f2;
	}
	.value-control button {
		min-width: 44px;
		height: 44px;
		font-size: 20px;
	}
	.modern-set:has(.value-control button) .modern-entry {
		flex-wrap: wrap;
	}
	.modern-set:has(.value-control button) .value-cell {
		flex-basis: calc(50% - 8px);
		min-width: 125px;
	}
	.previous-cell {
		font-size: 11px;
		flex: 0 0 62px;
		min-width: 0;
		align-self: center;
		color: #adbbb1;
	}
	.previous-cell strong {
		display: block;
		font-size: 12px;
		font-weight: 400;
		margin-top: 10px;
		overflow-wrap: anywhere;
	}
	.modern-save {
		height: 46px;
		min-width: 44px;
		border-radius: 9px;
		background: #296d48;
		color: #f4fff6;
		padding: 8px;
		font-weight: 650;
		align-self: end;
	}
	.modern-save.full {
		width: 100%;
		margin-top: 14px;
		height: 54px;
		font-size: 16px;
	}
	.completed .modern-save {
		background: #203b2a;
		color: #b1eac1;
	}
	.modern-set .effort-field {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 8px 0;
		font-size: 12px;
	}
	.modern-set .effort-field input {
		width: 56px;
		min-width: 56px;
		height: 44px;
		font-size: 16px;
		margin: 0;
		text-align: center;
	}
	.modern-set .effort-field span {
		color: #a6b5ab;
	}
	.modern-set .hidden {
		display: none;
	}
	.table-row .suggestion,
	.notebook-row .suggestion {
		font-size: 11px;
		margin-top: 4px;
		color: #a8c3b2;
	}
	.notebook-row {
		font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
		padding: 8px 0;
	}
	.notebook-row .modern-heading {
		font-size: 12px;
	}
	.notebook-row .value-control input {
		font-size: 16px;
		height: 44px;
	}
	.tap-row {
		border: 0;
		padding: 4px 0;
		text-align: center;
	}
	.tap-row.expanded {
		grid-column: 1 / -1;
		text-align: left;
		border-top: 1px solid #34463b;
		padding: 12px 0;
	}
	.tap-circle {
		width: 100%;
		aspect-ratio: 1;
		min-height: 44px;
		border: 2px solid #3b674d;
		border-radius: 50%;
		background: #15231a;
		font-size: 22px;
		font-weight: 600;
	}
	.tap-circle small {
		display: block;
		margin: 0;
		font-size: 11px;
	}
	.completed .tap-circle {
		background: #2a744b;
		color: #f1fff5;
	}
	.tap-caption,
	.tap-reason {
		display: block;
		font-size: 10px;
		line-height: 1.4;
		color: #aabbb0;
		margin-top: 6px;
		overflow-wrap: anywhere;
	}
	.tap-reason {
		font-size: 11px;
	}
	.status {
		color: #a8b8ae;
		font-size: 11px;
	}
	.completed .status {
		color: #9be2b6;
	}
	.dirty .status {
		color: #f2cc81;
	}
	small {
		font-weight: 400;
		text-transform: capitalize;
	}
	.target,
	.history,
	.suggestion {
		font-size: 12px;
		color: #b1c2b7;
		margin-top: 6px;
	}
	label {
		display: block;
		font-size: 12px;
		color: #b1c2b7;
		min-width: 0;
	}
	input {
		display: block;
		box-sizing: border-box;
		width: 100%;
		min-width: 0;
		height: 44px;
		margin-top: 4px;
		border: 1px solid #34463b;
		border-radius: 8px;
		padding: 8px;
		font-size: 16px;
		background: #19271e;
		color: #eef7f0;
	}
	.note-toggle {
		min-height: 44px;
		font-size: 12px;
		color: #b1c2b7;
	}
	.error {
		color: #fda4af;
		font-size: 13px;
		margin: 8px 0;
	}
	.result {
		font-size: 18px;
		margin-top: 8px;
	}
	:disabled {
		opacity: 0.6;
	}
	.hidden {
		display: none;
	}
</style>
