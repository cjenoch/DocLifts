<script lang="ts">
	import { untrack } from 'svelte';
	import {
		blankProgramDraft,
		blankExerciseDraft,
		blankSetDraft,
		MAX_PROGRAM_DRAFT_CHARS,
		MAX_PROGRAM_FORM_BYTES,
		programFormBytes,
		programDraftSchema,
		type ProgramDraft
	} from '$lib/program-draft';
	import { travelingPplDraft } from '$lib/traveling-ppl';

	type LibraryExercise = { id: string; name: string; equipmentType: string; isLowerBody: boolean };
	type ExerciseDraft = ProgramDraft['days'][number]['exercises'][number];
	type SetDraft = ExerciseDraft['sets'][number];
	let {
		data,
		form = null
	}: {
		data: {
			library: LibraryExercise[];
			requestId: string;
			draft: ProgramDraft;
			sourceProgramId: string | null;
		};
		form?: { error?: string; draft?: unknown; requestId?: string } | null;
	} = $props();

	// Invalid server submissions can have arbitrary shapes. Recover known editable
	// fields rather than rendering untrusted nested objects or losing valid values.
	function recover(value: unknown, fallback: unknown): unknown {
		if (Array.isArray(fallback)) {
			if (!Array.isArray(value)) return fallback;
			return value.slice(0, 100).map((entry) => recover(entry, fallback[0]));
		}
		if (fallback && typeof fallback === 'object') {
			const source = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
			return Object.fromEntries(
				Object.entries(fallback).map(([key, item]) => [key, recover(source[key], item)])
			);
		}
		if (fallback === null)
			return value === null || typeof value === 'string' || typeof value === 'number'
				? value
				: null;
		return typeof value === typeof fallback ? value : fallback;
	}
	function initialDraft(): ProgramDraft {
		if (!form?.draft) return structuredClone(data.draft);
		const parsed = programDraftSchema.safeParse(form.draft);
		if (parsed.success) return parsed.data;
		// A complete shape keeps empty/malformed rows editable on a failed POST.
		const shape: ProgramDraft = {
			name: '',
			description: null,
			days: [
				{
					name: '',
					notes: null,
					alternateGroupId: null,
					exercises: [{ ...blankExerciseDraft(), sets: [blankSetDraft()] }]
				}
			]
		};
		const restored = recover(form.draft, shape) as ProgramDraft;
		// newExercise is nullable, but when present it is an object, not a scalar.
		const raw = form.draft as { days?: { exercises?: { newExercise?: unknown }[] }[] };
		restored.days.forEach((day, d) =>
			day.exercises.forEach((exercise, e) => {
				const quick = raw.days?.[d]?.exercises?.[e]?.newExercise;
				// A nullable fallback accepts scalars, but bindings below require an object.
				exercise.newExercise = null;
				if (quick && typeof quick === 'object' && !Array.isArray(quick)) {
					exercise.newExercise = recover(quick, {
						name: '',
						equipmentType: 'dumbbell',
						isLowerBody: false
					}) as ExerciseDraft['newExercise'];
					exercise.exerciseId = null;
				}
			})
		);
		return restored;
	}
	let draft = $state<ProgramDraft>(untrack(initialDraft));
	let requestId = $state(untrack(() => form?.requestId || data.requestId));
	let reviewing = $state(false);
	let validationError = $state('');
	let submitting = $state(false);
	const equipmentTypes = [
		'barbell',
		'barbell-ez',
		'machine-plate',
		'machine-stack',
		'cable',
		'dumbbell',
		'smith',
		'bodyweight',
		'band'
	];
	const numericFields = [
		{ key: 'targetRepsMin', label: 'minimum target', min: 1, max: 3600, required: true, step: 1 },
		{ key: 'targetRepsMax', label: 'maximum target', min: 1, max: 3600, required: true, step: 1 },
		{ key: 'targetRir', label: 'RIR', min: 0, max: 10, required: false, step: 1 },
		{
			key: 'restSecondsMin',
			label: 'minimum rest seconds',
			min: 0,
			max: 3600,
			required: false,
			step: 1
		},
		{
			key: 'restSecondsMax',
			label: 'maximum rest seconds',
			min: 0,
			max: 3600,
			required: false,
			step: 1
		},
		{ key: 'initialLoad', label: 'initial load', min: 0, max: 999, required: false, step: 0.01 }
	] as const;

	function edited() {
		reviewing = false;
		validationError = '';
	}
	function move<T>(rows: T[], index: number, direction: number) {
		const next = index + direction;
		if (next < 0 || next >= rows.length) return;
		[rows[index], rows[next]] = [rows[next], rows[index]];
		edited();
	}
	function remove<T>(rows: T[], index: number) {
		rows.splice(index, 1);
		edited();
	}
	function chooseExercise(exercise: ExerciseDraft, value: string) {
		exercise.exerciseId = value && value !== 'new' ? value : null;
		exercise.newExercise =
			value === 'new' ? { name: '', equipmentType: 'dumbbell', isLowerBody: false } : null;
		edited();
	}
	function numberChanged(set: SetDraft, key: (typeof numericFields)[number]['key'], value: string) {
		if (key === 'targetRepsMin' || key === 'targetRepsMax')
			set[key] = value === '' ? 0 : Number(value);
		else set[key] = value === '' ? null : Number(value);
		edited();
	}
	function review() {
		const result = programDraftSchema.safeParse($state.snapshot(draft));
		if (!result.success) {
			validationError = result.error.issues
				.map((issue) => `${issue.path.join('.') || 'Program'}: ${issue.message}`)
				.join('\n');
			return;
		}
		if (JSON.stringify(result.data).length > MAX_PROGRAM_DRAFT_CHARS) {
			validationError = `Program draft is too large (maximum ${MAX_PROGRAM_DRAFT_CHARS.toLocaleString('en-US')} characters). Shorten notes or remove draft rows before reviewing. Your edits have been kept; nothing has been saved.`;
			return;
		}
		if (programFormBytes(result.data, requestId) > MAX_PROGRAM_FORM_BYTES) {
			validationError = `Program draft is too large to submit (maximum ${MAX_PROGRAM_FORM_BYTES.toLocaleString('en-US')} bytes). Shorten notes or remove draft rows before reviewing. Your edits have been kept; nothing has been saved.`;
			return;
		}
		draft = result.data;
		validationError = '';
		reviewing = true;
	}
	function exerciseName(exercise: ExerciseDraft) {
		return (
			exercise.newExercise?.name ||
			data.library.find((entry) => entry.id === exercise.exerciseId)?.name ||
			'Choose an exercise'
		);
	}
</script>

<svelte:head
	><title>{data.sourceProgramId ? 'Edit program' : 'Create program'} · DocLifts</title></svelte:head
>

<div class="program-editor mx-auto max-w-3xl px-4 py-6">
	<a
		href={data.sourceProgramId ? `/programs/${data.sourceProgramId}` : '/'}
		class="text-sm text-indigo-400">← Cancel without saving</a
	>
	<h1 class="mt-3 text-2xl font-semibold">
		{data.sourceProgramId ? 'Edit program as new version' : 'Create program'}
	</h1>
	<p class="mt-2 text-sm text-zinc-400">
		{#if data.sourceProgramId}Saving creates a new version and archives this source program. Past
			workouts stay unchanged.
		{:else}Build a draft, review it, then save. Nothing is saved when choosing a preset or editing
			fields.{/if}
	</p>
	<p class="mt-2 text-sm text-zinc-400">
		Physical machines are chosen in the workout, not in this template. Initial load is optional and
		used only for cold starts.
	</p>
	<p class="mt-2 text-sm text-zinc-400">
		SECONDARY means straight working-set engine semantics, not exercise priority. MAIN requires
		exactly one top set followed by backoffs; optional warmups come first. SECONDARY and ISOLATION
		use working sets with optional leading warmups.
	</p>
	{#if form?.error || validationError}
		<div
			role="alert"
			class="my-4 rounded-lg border border-red-800 bg-red-950/40 p-3 whitespace-pre-wrap text-red-200"
		>
			{validationError || form?.error}
		</div>
	{/if}
	<noscript
		>This editor needs JavaScript to build and review a structured draft. No program has been saved.</noscript
	>
	<form
		method="POST"
		accept-charset="UTF-8"
		onsubmit={(event) => {
			if (!reviewing || submitting) {
				event.preventDefault();
				return;
			}
			submitting = true;
		}}
	>
		<input type="hidden" name="payload" value={JSON.stringify(draft)} />
		<input type="hidden" name="requestId" value={requestId} />
		{#if reviewing}
			<section aria-labelledby="review-heading" class="mt-6 space-y-4">
				<h2 id="review-heading" class="text-xl font-semibold">Review program</h2>
				<h3 class="font-semibold">{draft.name}</h3>
				{#if draft.description}<p class="whitespace-pre-wrap text-zinc-300">
						{draft.description}
					</p>{/if}
				{#each draft.days as day, d}
					<article class="rounded-xl border border-zinc-700 bg-zinc-900 p-4">
						<h3 class="font-semibold">{d + 1}. {day.name}</h3>
						{#if day.alternateGroupId}<p>Alternate group: {day.alternateGroupId}</p>{/if}
						{#if day.notes}<p class="text-sm whitespace-pre-wrap text-zinc-400">{day.notes}</p>{/if}
						{#each day.exercises as exercise, e}
							<div class="mt-4 border-t border-zinc-700 pt-3">
								<h4 class="font-medium">{e + 1}. {exerciseName(exercise)}</h4>
								<p class="text-sm">
									{exercise.tier} · {exercise.progressionPolicy} · {exercise.newExercise
										?.equipmentType ||
										data.library.find((entry) => entry.id === exercise.exerciseId)?.equipmentType}
									{#if exercise.newExercise}
										· New library exercise · {exercise.newExercise.isLowerBody
											? 'Lower body'
											: 'Upper body / other'}{/if}
								</p>
								{#if exercise.notes}<p class="text-sm whitespace-pre-wrap text-zinc-400">
										{exercise.notes}
									</p>{/if}
								<ol class="mt-2 space-y-2 text-sm">
									{#each exercise.sets as set, s}
										<li class="rounded bg-zinc-950 p-2">
											Set {s + 1}: {set.setRole} · {set.targetRepsMin}–{set.targetRepsMax}
											{set.targetMetric} · RIR {set.targetRir ?? '—'} · Rest {set.restSecondsMin ??
												'—'}–{set.restSecondsMax ?? '—'} sec · Initial load {set.initialLoad ??
												'blank'}
											{#if set.notes}<p class="whitespace-pre-wrap text-zinc-400">
													{set.notes}
												</p>{/if}
										</li>
									{/each}
								</ol>
							</div>
						{/each}
					</article>
				{/each}
				<div class="flex flex-wrap gap-3">
					<button type="button" disabled={submitting} onclick={edited}>Back to editing</button>
					<button class="primary" type="submit" disabled={submitting}
						>{submitting
							? 'Saving…'
							: data.sourceProgramId
								? 'Save as new version'
								: 'Save program'}</button
					>
				</div>
			</section>
		{:else}
			<div class="my-5 flex flex-wrap gap-3">
				<button
					type="button"
					onclick={() => {
						draft = blankProgramDraft();
						edited();
					}}>Start blank draft</button
				>
				<button
					type="button"
					onclick={() => {
						draft = travelingPplDraft(data.library);
						edited();
					}}>Use Traveling PPL preset</button
				>
			</div>
			<p class="mb-4 text-xs text-zinc-400">
				Starting blank or choosing the preset replaces only the current unsaved draft. Remove
				controls below remove draft rows only.
			</p>
			<label
				>Program name<input
					required
					maxlength="200"
					bind:value={draft.name}
					oninput={edited}
				/></label
			>
			<label
				>Description<textarea
					value={draft.description ?? ''}
					oninput={(event) => {
						draft.description = event.currentTarget.value || null;
						edited();
					}}
				></textarea></label
			>
			{#each draft.days as day, d}
				{@const dayLabel = `Day ${d + 1}`}
				<section
					class="my-5 min-w-0 rounded-xl border border-zinc-700 bg-zinc-900/60 p-3 sm:p-4"
					aria-label={dayLabel}
				>
					<h2 class="mb-3 text-lg font-semibold">{dayLabel}</h2>
					<div class="mb-3 flex flex-wrap gap-2">
						<button
							type="button"
							aria-label={`Move day ${d + 1} up`}
							disabled={d === 0}
							onclick={() => move(draft.days, d, -1)}>↑ Day</button
						>
						<button
							type="button"
							aria-label={`Move day ${d + 1} down`}
							disabled={d === draft.days.length - 1}
							onclick={() => move(draft.days, d, 1)}>↓ Day</button
						>
						<button
							type="button"
							aria-label={`Remove draft day ${d + 1}`}
							onclick={() => remove(draft.days, d)}>Remove draft day</button
						>
					</div>
					<label>{dayLabel} name<input required bind:value={day.name} oninput={edited} /></label>
					<label
						>{dayLabel} notes<textarea
							value={day.notes ?? ''}
							oninput={(event) => {
								day.notes = event.currentTarget.value || null;
								edited();
							}}
						></textarea></label
					>
					<label
						>{dayLabel} alternate group<input
							value={day.alternateGroupId ?? ''}
							placeholder="Optional, e.g. legs"
							oninput={(event) => {
								day.alternateGroupId = event.currentTarget.value || null;
								edited();
							}}
						/></label
					>
					{#each day.exercises as exercise, e}
						{@const exLabel = `${dayLabel} exercise ${e + 1}`}
						<section
							class="my-4 min-w-0 rounded-lg border border-zinc-700 bg-zinc-950/50 p-3"
							aria-label={exLabel}
						>
							<h3 class="mb-2 font-semibold">Exercise {e + 1}: {exerciseName(exercise)}</h3>
							<div class="mb-3 flex flex-wrap gap-2">
								<button
									type="button"
									aria-label={`Move ${exLabel.toLowerCase()} up`}
									disabled={e === 0}
									onclick={() => move(day.exercises, e, -1)}>↑ Exercise</button
								>
								<button
									type="button"
									aria-label={`Move ${exLabel.toLowerCase()} down`}
									disabled={e === day.exercises.length - 1}
									onclick={() => move(day.exercises, e, 1)}>↓ Exercise</button
								>
								<button
									type="button"
									aria-label={`Remove draft ${exLabel.toLowerCase()}`}
									onclick={() => remove(day.exercises, e)}>Remove draft exercise</button
								>
							</div>
							<label
								>{exLabel} library exercise<select
									aria-label={`${exLabel} library exercise`}
									value={exercise.newExercise ? 'new' : (exercise.exerciseId ?? '')}
									onchange={(event) => chooseExercise(exercise, event.currentTarget.value)}
								>
									<option value="">Choose an exercise</option>
									{#each data.library as entry}<option value={entry.id}
											>{entry.name} ({entry.equipmentType})</option
										>{/each}
									<option value="new">Quick-add new exercise</option>
								</select></label
							>
							{#if exercise.newExercise}
								<label
									>{exLabel} new exercise name<input
										required
										bind:value={exercise.newExercise.name}
										oninput={edited}
									/></label
								>
								<label
									>{exLabel} equipment type<select
										aria-label={`${exLabel} equipment type`}
										bind:value={exercise.newExercise.equipmentType}
										onchange={edited}
										>{#each equipmentTypes as type}<option value={type}>{type}</option
											>{/each}</select
									></label
								>
								<label
									>{exLabel} lower body<select
										aria-label={`${exLabel} lower body`}
										value={String(exercise.newExercise.isLowerBody)}
										onchange={(event) => {
											if (exercise.newExercise)
												exercise.newExercise.isLowerBody = event.currentTarget.value === 'true';
											edited();
										}}
										><option value="false">No — upper body / other</option><option value="true"
											>Yes — lower body</option
										></select
									></label
								>
							{:else if exercise.exerciseId}
								<p class="mb-3 text-xs text-zinc-400">
									Library equipment and lower-body metadata stay unchanged. Choose a different
									exercise or quick-add a distinct name to use different equipment.
								</p>
							{/if}
							<div class="grid gap-3 sm:grid-cols-2">
								<label
									>{exLabel} tier<select
										aria-label={`${exLabel} tier`}
										bind:value={exercise.tier}
										onchange={edited}
										><option value="main">MAIN — top + backoffs</option><option value="secondary"
											>SECONDARY — straight sets</option
										><option value="isolation">ISOLATION — straight sets</option></select
									></label
								>
								<label
									>{exLabel} progression policy<select
										aria-label={`${exLabel} progression policy`}
										bind:value={exercise.progressionPolicy}
										onchange={edited}
										><option value="standard">Standard</option><option value="cautious"
											>Cautious — manual advancement</option
										><option value="hold">Hold — no progression</option></select
									></label
								>
							</div>
							<label
								>{exLabel} notes<textarea
									value={exercise.notes ?? ''}
									oninput={(event) => {
										exercise.notes = event.currentTarget.value || null;
										edited();
									}}
								></textarea></label
							>
							{#each exercise.sets as prescription, s}
								{@const setLabel = `${exLabel} set ${s + 1}`}
								<fieldset class="my-3 min-w-0 rounded-lg border border-zinc-700 p-3">
									<legend class="px-1 text-sm font-semibold">Set {s + 1}</legend>
									<div class="mb-3 flex flex-wrap gap-2">
										<button
											type="button"
											aria-label={`Move ${setLabel.toLowerCase()} up`}
											disabled={s === 0}
											onclick={() => move(exercise.sets, s, -1)}>↑ Set</button
										>
										<button
											type="button"
											aria-label={`Move ${setLabel.toLowerCase()} down`}
											disabled={s === exercise.sets.length - 1}
											onclick={() => move(exercise.sets, s, 1)}>↓ Set</button
										>
										<button
											type="button"
											aria-label={`Remove draft ${setLabel.toLowerCase()}`}
											onclick={() => remove(exercise.sets, s)}>Remove draft set</button
										>
									</div>
									<div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
										<label
											>{setLabel} role<select
												aria-label={`${setLabel} role`}
												bind:value={prescription.setRole}
												onchange={edited}
												><option value="warmup">Warmup</option><option value="top">Top</option
												><option value="backoff">Backoff</option><option value="working"
													>Working</option
												></select
											></label
										>
										<label
											>{setLabel} target metric<select
												aria-label={`${setLabel} target metric`}
												bind:value={prescription.targetMetric}
												onchange={edited}
												><option value="reps">Reps</option><option value="seconds">Seconds</option
												></select
											></label
										>
										{#each numericFields as field}
											<label
												>{setLabel}
												{field.label}<input
													type="number"
													inputmode="decimal"
													min={field.min}
													max={field.max}
													step={field.step}
													required={field.required}
													value={prescription[field.key] ?? ''}
													oninput={(event) =>
														numberChanged(prescription, field.key, event.currentTarget.value)}
												/></label
											>
										{/each}
									</div>
									<label
										>{setLabel} notes<textarea
											value={prescription.notes ?? ''}
											oninput={(event) => {
												prescription.notes = event.currentTarget.value || null;
												edited();
											}}
										></textarea></label
									>
								</fieldset>
							{/each}
							<button
								type="button"
								aria-label={`Add set to ${exLabel.toLowerCase()}`}
								onclick={() => {
									exercise.sets.push(blankSetDraft());
									edited();
								}}>Add set</button
							>
						</section>
					{/each}
					<button
						type="button"
						aria-label={`Add exercise to day ${d + 1}`}
						onclick={() => {
							day.exercises.push(blankExerciseDraft());
							edited();
						}}>Add exercise</button
					>
				</section>
			{/each}
			<div class="my-5 flex flex-wrap gap-3">
				<button
					type="button"
					onclick={() => {
						draft.days.push({
							name: '',
							notes: null,
							alternateGroupId: null,
							exercises: [blankExerciseDraft()]
						});
						edited();
					}}>Add day</button
				>
				<button type="button" class="primary" onclick={review}>Review program</button>
			</div>
		{/if}
	</form>
</div>

<style>
	.program-editor {
		overflow-wrap: anywhere;
	}
	label {
		display: block;
		min-width: 0;
		margin-bottom: 0.75rem;
		font-size: 0.8rem;
		color: #d4d4d8;
	}
	input:not([type='hidden']),
	select,
	textarea {
		display: block;
		box-sizing: border-box;
		width: 100%;
		min-width: 0;
		min-height: 44px;
		margin-top: 0.3rem;
		border: 1px solid #52525b;
		border-radius: 0.375rem;
		background: #09090b;
		color: #fafafa;
		padding: 0.6rem;
		font: inherit;
		font-size: 1rem;
	}
	textarea {
		min-height: 70px;
	}
	button {
		min-height: 44px;
		border: 1px solid #52525b;
		border-radius: 0.5rem;
		padding: 0.5rem 0.75rem;
		background: #27272a;
		color: #fafafa;
		font-size: 0.875rem;
	}
	button:disabled {
		opacity: 0.45;
	}
	button.primary {
		background: #4f46e5;
		border-color: #6366f1;
		font-weight: 600;
	}
	button:focus-visible,
	input:focus-visible,
	select:focus-visible,
	textarea:focus-visible,
	a:focus-visible {
		outline: 2px solid #a5b4fc;
		outline-offset: 3px;
	}
</style>
