<script lang="ts">
	/**
	 * The program editor, rebuilt for a phone (editor spec, Part N): three short
	 * screens in place of one long form. Program (name, description, days),
	 * Day (exercises as one summary line each, alternates), Exercise (its sets:
	 * four fields for equal working sets, or each set under "Customize sets").
	 *
	 * The saved shape does not change: the same draft, the same review step,
	 * the same `payload` + `requestId` POST to `saveProgramDraft`, the same size
	 * limits. The draft is kept in sessionStorage, so going back between screens
	 * and reloading the page both keep it; saving or cancelling clears it.
	 */
	import { onMount, untrack } from 'svelte';
	import {
		blankExerciseDraft,
		blankSetDraft,
		MAX_PROGRAM_DRAFT_CHARS,
		MAX_PROGRAM_FORM_BYTES,
		programFormBytes,
		programDraftSchema,
		type ProgramDraft
	} from '$lib/program-draft';
	import { STARTER_TEMPLATES } from '$lib/starter-templates';
	import {
		DEFAULT_PATTERN,
		PATTERN_LIMITS,
		dayCount,
		exerciseKey,
		locate,
		patternOf,
		reroleForTier,
		setsFromPattern,
		summaryLine,
		type Pattern
	} from '$lib/program-pattern';
	import { editorUi as ui } from '$lib/editor-ui';
	import ExerciseChooser from './ExerciseChooser.svelte';

	type LibraryExercise = { id: string; name: string; equipmentType: string; isLowerBody: boolean };
	type DayDraft = ProgramDraft['days'][number];
	type ExerciseDraft = DayDraft['exercises'][number];
	type SetDraft = ExerciseDraft['sets'][number];
	type View =
		| { level: 'program' }
		| { level: 'day'; d: number }
		| { level: 'exercise'; d: number; e: number };
	let {
		data,
		form = null
	}: {
		data: {
			library: LibraryExercise[];
			requestId: string;
			draft: ProgramDraft;
			sourceProgramId: string | null;
			/** Which stored draft this page keeps (Part M: one per source workout). */
			draftKey?: string;
			/** Open on this day's screen (Part M: the day built from a workout). */
			openDay?: number | null;
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
	function restore(raw: unknown): ProgramDraft {
		const parsed = programDraftSchema.safeParse(raw);
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
		const restored = recover(raw, shape) as ProgramDraft;
		// newExercise is nullable, but when present it is an object, not a scalar.
		const source = raw as { days?: { exercises?: { newExercise?: unknown }[] }[] };
		restored.days.forEach((day, d) =>
			day.exercises.forEach((exercise, e) => {
				const quick = source?.days?.[d]?.exercises?.[e]?.newExercise;
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
	const blankDay = (n: number): DayDraft => ({
		name: ui.untitledDay(n),
		notes: null,
		alternateGroupId: null,
		exercises: []
	});
	function initialDraft(): ProgramDraft {
		if (form?.draft) return restore(form.draft);
		const draft = structuredClone(data.draft);
		// A new program starts with no exercise rows: they are added from the picker.
		if (!data.sourceProgramId)
			for (const day of draft.days)
				day.exercises = day.exercises.filter((x) => x.exerciseId || x.newExercise);
		return draft;
	}
	let draft = $state<ProgramDraft>(untrack(initialDraft));
	let requestId = $state(untrack(() => form?.requestId || data.requestId));
	let view = $state<View>(
		untrack(() =>
			data.openDay != null && !form?.draft
				? { level: 'day', d: data.openDay }
				: { level: 'program' }
		)
	);
	let reviewing = $state(false);
	let validationError = $state('');
	let submitting = $state(false);
	let showIssues = $state(false);
	let customizing = $state(false);
	let chooser = $state<{ d: number; e: number | null } | null>(null);

	// The draft survives a reload: one stored draft per new program, and one per
	// program being edited. Browser storage is a convenience; it may be absent.
	const storageKey = $derived(
		`doclifts:program-draft:${data.draftKey ?? data.sourceProgramId ?? 'new'}`
	);
	let restored = $state(false);
	onMount(() => {
		if (!form?.draft) {
			try {
				const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null');
				if (saved?.draft) {
					draft = restore(saved.draft);
					if (typeof saved.requestId === 'string') requestId = saved.requestId;
					if (saved.view && validView(saved.view)) view = saved.view;
				}
			} catch {
				/* Optional. */
			}
		}
		restored = true;
	});
	$effect(() => {
		const snapshot = JSON.stringify({ draft, requestId, view });
		if (!restored || submitting) return;
		try {
			sessionStorage.setItem(storageKey, snapshot);
		} catch {
			/* Optional. */
		}
	});
	function forget() {
		try {
			sessionStorage.removeItem(storageKey);
		} catch {
			/* Optional. */
		}
	}
	function validView(v: View): boolean {
		if (v.level === 'program') return true;
		if (!draft.days[v.d]) return false;
		return v.level === 'day' || !!draft.days[v.d].exercises[v.e];
	}

	const located = $derived(
		showIssues
			? locate(programDraftSchema.safeParse($state.snapshot(draft)).error?.issues ?? [])
			: locate([])
	);
	const totalIssues = $derived(
		located.program.length + draft.days.reduce((n, _, d) => n + dayCount(located, d), 0)
	);

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
	function review() {
		const result = programDraftSchema.safeParse($state.snapshot(draft));
		if (!result.success) {
			showIssues = true;
			validationError = ui.fixFirst;
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
		showIssues = false;
		reviewing = true;
		view = { level: 'program' };
	}
	function exerciseName(exercise: ExerciseDraft) {
		return (
			exercise.newExercise?.name ||
			data.library.find((entry) => entry.id === exercise.exerciseId)?.name ||
			ui.chooseExercise
		);
	}
	function equipmentOf(exercise: ExerciseDraft) {
		return (
			exercise.newExercise?.equipmentType ??
			data.library.find((entry) => entry.id === exercise.exerciseId)?.equipmentType ??
			''
		);
	}
	const drafted = $derived(
		draft.days.flatMap((day) =>
			day.exercises.flatMap((x) => (x.newExercise?.name.trim() ? [x.newExercise] : []))
		)
	);

	function openDay(d: number) {
		view = { level: 'day', d };
		window.scrollTo?.(0, 0);
	}
	function openExercise(d: number, e: number) {
		// Sets that differ open in "Customize sets", and stay there while edited.
		customizing = patternOf(draft.days[d].exercises[e]) === null;
		view = { level: 'exercise', d, e };
		window.scrollTo?.(0, 0);
	}
	function choose(
		choice: { exerciseId: string } | { newExercise: NonNullable<ExerciseDraft['newExercise']> }
	) {
		if (!chooser) return;
		const { d, e } = chooser;
		const identity =
			'exerciseId' in choice
				? { exerciseId: choice.exerciseId, newExercise: null }
				: { exerciseId: null, newExercise: choice.newExercise };
		if (e === null) {
			draft.days[d].exercises.push({
				...identity,
				tier: 'secondary',
				progressionPolicy: 'standard',
				notes: null,
				sets: setsFromPattern(DEFAULT_PATTERN)
			});
			chooser = null;
			edited();
			openExercise(d, draft.days[d].exercises.length - 1);
			return;
		}
		Object.assign(draft.days[d].exercises[e], identity);
		chooser = null;
		edited();
	}

	// Alternates: days that share an alternate group are "one or the other".
	function alternateWith(d: number, other: number | null) {
		const day = draft.days[d];
		if (other === null) day.alternateGroupId = null;
		else {
			const target = draft.days[other];
			const group =
				target.alternateGroupId ??
				day.alternateGroupId ??
				`alt-${Math.max(0, ...draft.days.map((x) => Number(x.alternateGroupId?.match(/^alt-(\d+)$/)?.[1] ?? 0))) + 1}`;
			target.alternateGroupId = group;
			day.alternateGroupId = group;
		}
		edited();
	}

	function setPattern(exercise: ExerciseDraft, next: Pattern) {
		const clamp = (v: number, [lo, hi]: readonly [number, number]) =>
			Math.min(hi, Math.max(lo, Math.round(v) || lo));
		const pattern = {
			sets: clamp(next.sets, PATTERN_LIMITS.sets),
			repsMin: clamp(next.repsMin, PATTERN_LIMITS.reps),
			repsMax: clamp(next.repsMax, PATTERN_LIMITS.reps),
			rir: clamp(next.rir, PATTERN_LIMITS.rir),
			rest: next.rest
		};
		exercise.sets = setsFromPattern(pattern);
		edited();
	}
	/** "Back to equal sets": the pattern nearest the sets as they are. */
	function nearestPattern(exercise: ExerciseDraft): Pattern {
		const work = exercise.sets.filter((s) => s.setRole !== 'warmup');
		const first = work[0] ?? exercise.sets[0];
		if (!first) return DEFAULT_PATTERN;
		return {
			sets: work.length || 1,
			repsMin: first.targetRepsMin,
			repsMax: first.targetRepsMax,
			rir: first.targetRir ?? DEFAULT_PATTERN.rir,
			rest: (first.restSecondsMin ?? 90) >= 120 ? 'long' : 'short'
		};
	}
	function setTier(exercise: ExerciseDraft, tier: ExerciseDraft['tier']) {
		exercise.tier = tier;
		reroleForTier(exercise);
		edited();
	}
	function numberChanged(set: SetDraft, key: keyof SetDraft, value: string) {
		if (key === 'targetRepsMin' || key === 'targetRepsMax')
			set[key] = value === '' ? 0 : Number(value);
		else if (
			key === 'targetRir' ||
			key === 'restSecondsMin' ||
			key === 'restSecondsMax' ||
			key === 'initialLoad'
		)
			set[key] = value === '' ? null : Number(value);
		edited();
	}
	const setNumberFields = [
		{ key: 'targetRepsMin', label: ui.targetMin, mode: 'numeric' },
		{ key: 'targetRepsMax', label: ui.targetMax, mode: 'numeric' },
		{ key: 'targetRir', label: ui.rir, mode: 'numeric' },
		{ key: 'restSecondsMin', label: ui.restMin, mode: 'numeric' },
		{ key: 'restSecondsMax', label: ui.restMax, mode: 'numeric' },
		{ key: 'initialLoad', label: ui.initialLoad, mode: 'decimal' }
	] as const;
</script>

<svelte:head
	><title>{data.sourceProgramId ? 'Edit program' : 'Create program'} · DocLifts</title></svelte:head
>

<div class="program-editor mx-auto max-w-3xl px-4 py-6">
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
			forget();
		}}
	>
		<input type="hidden" name="payload" value={JSON.stringify(draft)} />
		<input type="hidden" name="requestId" value={requestId} />

		{#if reviewing || view.level === 'program'}
			<a
				href={data.sourceProgramId ? `/programs/${data.sourceProgramId}` : '/'}
				class="text-sm text-indigo-400"
				onclick={forget}>{ui.cancel}</a
			>
			<h1 class="mt-3 text-2xl font-semibold">
				{data.sourceProgramId ? ui.editTitle : ui.createTitle}
			</h1>
			<p class="muted mt-2">{data.sourceProgramId ? ui.editNote : ui.createNote}</p>
		{/if}
		{#if (form?.error || validationError) && (reviewing || view.level === 'program')}
			<div role="alert" class="alert">
				{validationError || form?.error}
				{#if totalIssues && view.level === 'program'}
					<span class="count">{ui.problems(totalIssues)}</span>
				{/if}
			</div>
		{/if}

		{#if reviewing}
			<section aria-labelledby="review-heading" class="mt-2 space-y-4">
				<h2 id="review-heading" class="text-xl font-semibold">Review program</h2>
				<h3 class="font-semibold">{draft.name}</h3>
				{#if draft.description}<p class="whitespace-pre-wrap text-zinc-300">
						{draft.description}
					</p>{/if}
				{#each draft.days as day, d (d)}
					<article class="card">
						<h3 class="font-semibold">{d + 1}. {day.name}</h3>
						{#if day.alternateGroupId}<p class="muted">
								{ui.alternatesWith}: {draft.days
									.filter((x, i) => i !== d && x.alternateGroupId === day.alternateGroupId)
									.map((x) => x.name)
									.join(', ')}
							</p>{/if}
						{#if day.notes}<p class="muted whitespace-pre-wrap">{day.notes}</p>{/if}
						<ol class="mt-2 space-y-1">
							{#each day.exercises as exercise, e (e)}
								<li>{summaryLine(exerciseName(exercise), exercise)}</li>
							{/each}
						</ol>
					</article>
				{/each}
				<div class="actions">
					<button type="button" disabled={submitting} onclick={() => (reviewing = false)}
						>{ui.backToEditing}</button
					>
					<button class="primary" type="submit" disabled={submitting}
						>{submitting ? ui.saving : data.sourceProgramId ? ui.saveVersion : ui.save}</button
					>
				</div>
			</section>
		{:else if view.level === 'program'}
			{#if !data.sourceProgramId}
				<div class="starts">
					<button
						type="button"
						onclick={() => {
							draft = { name: '', description: null, days: [blankDay(1)] };
							edited();
						}}>{ui.startBlank}</button
					>
					{#each STARTER_TEMPLATES as template (template.key)}
						<button
							type="button"
							onclick={() => {
								draft = template.build(data.library);
								edited();
							}}>{ui.useTemplate(template.label)}</button
						>
					{/each}
				</div>
				<p class="muted text-xs">{ui.startingNote}</p>
			{/if}
			{#each located.program as message (message)}<p class="issue">{message}</p>{/each}
			<label
				>{ui.programName}<input
					required
					maxlength="200"
					autocomplete="off"
					autocapitalize="words"
					bind:value={draft.name}
					oninput={edited}
				/></label
			>
			<label
				>{ui.description}<textarea
					value={draft.description ?? ''}
					oninput={(event) => {
						draft.description = event.currentTarget.value || null;
						edited();
					}}
				></textarea></label
			>
			<h2 class="section">{ui.days}</h2>
			<ol class="rows">
				{#each draft.days as day, d (d)}
					{@const count = dayCount(located, d)}
					<li class="row-card" data-testid="day-row">
						<label class="compact"
							>{ui.dayName(d + 1)}<input
								required
								maxlength="200"
								autocomplete="off"
								autocapitalize="words"
								bind:value={day.name}
								oninput={edited}
							/></label
						>
						<button type="button" class="open" onclick={() => openDay(d)}
							><span>{ui.openDay(day.name || ui.untitledDay(d + 1))}</span><small
								>{ui.exerciseCount(day.exercises.length)}{#if count}
									· <span class="count">{ui.problems(count)}</span>{/if}</small
							></button
						>
						<div class="tools">
							<button
								type="button"
								aria-label={ui.moveUp(`day ${d + 1}`)}
								disabled={d === 0}
								onclick={() => move(draft.days, d, -1)}>↑</button
							>
							<button
								type="button"
								aria-label={ui.moveDown(`day ${d + 1}`)}
								disabled={d === draft.days.length - 1}
								onclick={() => move(draft.days, d, 1)}>↓</button
							>
							<button
								type="button"
								class="danger"
								aria-label={ui.remove(`day ${d + 1}`)}
								onclick={() => remove(draft.days, d)}>✕</button
							>
						</div>
					</li>
				{/each}
			</ol>
			<div class="actions">
				<button
					type="button"
					onclick={() => {
						draft.days.push(blankDay(draft.days.length + 1));
						edited();
						openDay(draft.days.length - 1);
					}}>{ui.addDay}</button
				>
				<button type="button" class="primary" onclick={review}>{ui.review}</button>
			</div>
		{:else if view.level === 'day' && draft.days[view.d]}
			{@const d = view.d}
			{@const day = draft.days[d]}
			<button type="button" class="back" onclick={() => (view = { level: 'program' })}
				>{ui.backToProgram}</button
			>
			<h1 class="mt-2 text-2xl font-semibold">{day.name || ui.untitledDay(d + 1)}</h1>
			{#each located.day.get(d) ?? [] as message (message)}<p class="issue">{message}</p>{/each}
			<label
				>{ui.dayName(d + 1)}<input
					required
					maxlength="200"
					autocomplete="off"
					autocapitalize="words"
					bind:value={day.name}
					oninput={edited}
				/></label
			>
			{#if draft.days.length > 1}
				<p class="label">{ui.alternatesWith}</p>
				<div class="chips">
					<button
						type="button"
						class="chip"
						aria-pressed={!day.alternateGroupId}
						onclick={() => alternateWith(d, null)}>{ui.noAlternate}</button
					>
					{#each draft.days as other, o (o)}
						{#if o !== d}
							<button
								type="button"
								class="chip"
								aria-pressed={!!day.alternateGroupId &&
									other.alternateGroupId === day.alternateGroupId}
								onclick={() => alternateWith(d, o)}>{other.name || ui.untitledDay(o + 1)}</button
							>
						{/if}
					{/each}
				</div>
				<p class="muted text-xs">{ui.alternatesNote}</p>
			{/if}
			<label
				>{ui.dayNotes}<textarea
					value={day.notes ?? ''}
					oninput={(event) => {
						day.notes = event.currentTarget.value || null;
						edited();
					}}
				></textarea></label
			>
			<h2 class="section">{ui.exercises}</h2>
			<ol class="rows">
				{#each day.exercises as exercise, e (e)}
					{@const problems = located.exercise.get(exerciseKey(d, e))?.length ?? 0}
					<li class="row-card" data-testid="exercise-row">
						<button type="button" class="open" onclick={() => openExercise(d, e)}
							><span>{summaryLine(exerciseName(exercise), exercise)}</span>{#if problems}<small
									><span class="count">{ui.problems(problems)}</span></small
								>{/if}</button
						>
						<div class="tools">
							<button
								type="button"
								aria-label={ui.moveUp(exerciseName(exercise))}
								disabled={e === 0}
								onclick={() => move(day.exercises, e, -1)}>↑</button
							>
							<button
								type="button"
								aria-label={ui.moveDown(exerciseName(exercise))}
								disabled={e === day.exercises.length - 1}
								onclick={() => move(day.exercises, e, 1)}>↓</button
							>
							<button
								type="button"
								class="danger"
								aria-label={ui.remove(exerciseName(exercise))}
								onclick={() => remove(day.exercises, e)}>✕</button
							>
						</div>
					</li>
				{/each}
			</ol>
			<div class="actions">
				<button type="button" class="primary" onclick={() => (chooser = { d, e: null })}
					>{ui.addExercise}</button
				>
			</div>
		{:else if view.level === 'exercise' && draft.days[view.d]?.exercises[view.e]}
			{@const d = view.d}
			{@const e = view.e}
			{@const day = draft.days[d]}
			{@const exercise = day.exercises[e]}
			{@const pattern = patternOf(exercise)}
			{@const custom = customizing || !pattern}
			<button type="button" class="back" onclick={() => openDay(d)}
				>{ui.backToDay(day.name || ui.untitledDay(d + 1))}</button
			>
			<h1 class="mt-2 text-2xl font-semibold">{exerciseName(exercise)}</h1>
			<p class="muted">{ui.equipmentLabels[equipmentOf(exercise)] ?? ''}</p>
			<button type="button" class="link" onclick={() => (chooser = { d, e })}
				>{exercise.exerciseId || exercise.newExercise
					? ui.changeExercise
					: ui.chooseExercise}</button
			>
			{#if located.exercise.get(exerciseKey(d, e))?.length}
				<div role="alert" class="alert">
					{#each located.exercise.get(exerciseKey(d, e)) ?? [] as message (message)}<p>
							{message}
						</p>{/each}
				</div>
			{/if}

			{#if !custom && pattern}
				<div class="pattern" data-testid="pattern">
					{@render stepper(ui.sets, 'sets', pattern.sets, (v) =>
						setPattern(exercise, { ...pattern, sets: v })
					)}
					<p class="label">{ui.repRange}</p>
					<div class="pair">
						<label class="compact"
							>{ui.repsMin}<input
								type="number"
								inputmode="numeric"
								min="1"
								max="3600"
								value={pattern.repsMin}
								onchange={(event) =>
									setPattern(exercise, { ...pattern, repsMin: Number(event.currentTarget.value) })}
							/></label
						>
						<label class="compact"
							>{ui.repsMax}<input
								type="number"
								inputmode="numeric"
								min="1"
								max="3600"
								value={pattern.repsMax}
								onchange={(event) =>
									setPattern(exercise, { ...pattern, repsMax: Number(event.currentTarget.value) })}
							/></label
						>
					</div>
					{@render stepper(ui.rir, 'reps in reserve', pattern.rir, (v) =>
						setPattern(exercise, { ...pattern, rir: v })
					)}
					<p class="label">{ui.rest}</p>
					<div class="chips">
						<button
							type="button"
							class="chip"
							aria-pressed={pattern.rest === 'short'}
							onclick={() => setPattern(exercise, { ...pattern, rest: 'short' })}
							>{ui.restShort}</button
						>
						<button
							type="button"
							class="chip"
							aria-pressed={pattern.rest === 'long'}
							onclick={() => setPattern(exercise, { ...pattern, rest: 'long' })}
							>{ui.restLong}</button
						>
					</div>
					<button type="button" class="link" onclick={() => (customizing = true)}
						>{ui.customize}</button
					>
				</div>
			{:else}
				<p class="muted text-xs">{ui.customNote}</p>
				{#each exercise.sets as set, s (s)}
					<fieldset class="set">
						<legend>{ui.set(s + 1)}</legend>
						<p class="label">{ui.role}</p>
						<div class="chips">
							{#each Object.entries(ui.roles) as [role, label] (role)}
								<button
									type="button"
									class="chip"
									aria-label={`${ui.set(s + 1)} ${label}`}
									aria-pressed={set.setRole === role}
									onclick={() => {
										set.setRole = role as SetDraft['setRole'];
										edited();
									}}>{label}</button
								>
							{/each}
						</div>
						<p class="label">{ui.metric}</p>
						<div class="chips">
							{#each Object.entries(ui.metrics) as [metric, label] (metric)}
								<button
									type="button"
									class="chip"
									aria-label={`${ui.set(s + 1)} ${label}`}
									aria-pressed={set.targetMetric === metric}
									onclick={() => {
										set.targetMetric = metric as SetDraft['targetMetric'];
										edited();
									}}>{label}</button
								>
							{/each}
						</div>
						<div class="grid">
							{#each setNumberFields as field (field.key)}
								<label class="compact"
									>{field.label}<input
										type="number"
										inputmode={field.mode}
										aria-label={`${ui.set(s + 1)} ${field.label}`}
										step={field.key === 'initialLoad' ? '0.01' : '1'}
										min="0"
										value={set[field.key] ?? ''}
										oninput={(event) => numberChanged(set, field.key, event.currentTarget.value)}
									/></label
								>
							{/each}
						</div>
						<label
							>{ui.setNotes}<textarea
								aria-label={`${ui.set(s + 1)} ${ui.setNotes}`}
								value={set.notes ?? ''}
								oninput={(event) => {
									set.notes = event.currentTarget.value || null;
									edited();
								}}
							></textarea></label
						>
						<div class="tools">
							<button
								type="button"
								aria-label={ui.moveUp(`set ${s + 1}`)}
								disabled={s === 0}
								onclick={() => move(exercise.sets, s, -1)}>↑</button
							>
							<button
								type="button"
								aria-label={ui.moveDown(`set ${s + 1}`)}
								disabled={s === exercise.sets.length - 1}
								onclick={() => move(exercise.sets, s, 1)}>↓</button
							>
							<button
								type="button"
								class="danger"
								aria-label={ui.remove(`set ${s + 1}`)}
								onclick={() => remove(exercise.sets, s)}>✕</button
							>
						</div>
					</fieldset>
				{/each}
				<div class="actions">
					<button
						type="button"
						onclick={() => {
							const last = exercise.sets.at(-1);
							exercise.sets.push(
								last
									? {
											...$state.snapshot(last),
											setRole: last.setRole === 'top' ? 'backoff' : last.setRole
										}
									: blankSetDraft()
							);
							edited();
						}}>{ui.addSet}</button
					>
					{#if exercise.tier !== 'main'}
						<button
							type="button"
							onclick={() => {
								setPattern(exercise, pattern ?? nearestPattern(exercise));
								customizing = false;
							}}>{ui.usePattern}</button
						>
					{/if}
				</div>
			{/if}

			<details class="advanced">
				<summary>{ui.advanced}</summary>
				<p class="label">{ui.tier}</p>
				<div class="chips">
					{#each Object.entries(ui.tiers) as [tier, label] (tier)}
						<button
							type="button"
							class="chip"
							aria-pressed={exercise.tier === tier}
							onclick={() => setTier(exercise, tier as ExerciseDraft['tier'])}>{label}</button
						>
					{/each}
				</div>
				<p class="label">{ui.policy}</p>
				<div class="chips">
					{#each Object.entries(ui.policies) as [policy, label] (policy)}
						<button
							type="button"
							class="chip"
							aria-pressed={exercise.progressionPolicy === policy}
							onclick={() => {
								exercise.progressionPolicy = policy as ExerciseDraft['progressionPolicy'];
								edited();
							}}>{label}</button
						>
					{/each}
				</div>
				<label
					>{ui.exerciseNotes}<textarea
						value={exercise.notes ?? ''}
						oninput={(event) => {
							exercise.notes = event.currentTarget.value || null;
							edited();
						}}
					></textarea></label
				>
			</details>
			<div class="actions">
				<button type="button" class="primary" onclick={() => openDay(d)}
					>{ui.backToDay(day.name || ui.untitledDay(d + 1))}</button
				>
			</div>
		{:else}
			<button type="button" class="back" onclick={() => (view = { level: 'program' })}
				>{ui.backToProgram}</button
			>
		{/if}
	</form>
</div>

{#if chooser}
	<ExerciseChooser
		library={data.library}
		{drafted}
		onchoose={choose}
		onclose={() => (chooser = null)}
	/>
{/if}

{#snippet stepper(label: string, what: string, value: number, set: (v: number) => void)}
	<p class="label">{label}</p>
	<div class="stepper">
		<button type="button" aria-label={ui.less(what)} onclick={() => set(value - 1)}>−</button>
		<output aria-label={label}>{value}</output>
		<button type="button" aria-label={ui.more(what)} onclick={() => set(value + 1)}>+</button>
	</div>
{/snippet}

<style>
	.program-editor {
		overflow-wrap: anywhere;
	}
	label {
		display: block;
		min-width: 0;
		margin: 0.75rem 0;
		font-size: 0.8rem;
		color: #d4d4d8;
	}
	label.compact {
		margin: 0;
	}
	input:not([type='hidden']):not([type='checkbox']),
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
	button.danger {
		color: #fca5a5;
	}
	button.back,
	button.link {
		border: 0;
		background: none;
		padding: 0;
		color: #a5b4fc;
	}
	.muted {
		color: #a1a1aa;
		font-size: 0.875rem;
	}
	.label {
		margin: 0.75rem 0 0.4rem;
		font-size: 0.8rem;
		color: #d4d4d8;
	}
	.section {
		margin: 1.5rem 0 0.5rem;
		font-size: 1.05rem;
		font-weight: 600;
	}
	.alert {
		margin: 0.75rem 0;
		padding: 0.75rem;
		border: 1px solid #991b1b;
		border-radius: 0.5rem;
		background: rgb(69 10 10 / 0.4);
		color: #fecaca;
		white-space: pre-wrap;
	}
	.issue {
		margin: 0.5rem 0;
		color: #fca5a5;
		font-size: 0.875rem;
	}
	.count {
		color: #fca5a5;
		font-weight: 600;
	}
	.starts,
	.actions,
	.chips,
	.tools {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	.starts,
	.actions {
		margin: 1rem 0;
	}
	.rows {
		display: grid;
		gap: 0.75rem;
	}
	.row-card,
	.card,
	.set {
		min-width: 0;
		padding: 0.75rem;
		border: 1px solid #3f3f46;
		border-radius: 0.75rem;
		background: rgb(24 24 27 / 0.6);
	}
	.row-card .open {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		width: 100%;
		margin: 0.5rem 0;
		text-align: left;
	}
	.row-card .open small {
		color: #a1a1aa;
	}
	.tools button {
		min-width: 44px;
	}
	.chip {
		border-radius: 999px;
		color: #d4d4d8;
	}
	.chip[aria-pressed='true'] {
		border-color: #818cf8;
		background: #1e1b4b;
		color: #e0e7ff;
	}
	.pair,
	.grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.75rem;
	}
	.grid {
		margin-top: 0.75rem;
	}
	.stepper {
		display: flex;
		align-items: center;
		gap: 0.75rem;
	}
	.stepper button {
		min-width: 52px;
		font-size: 1.25rem;
	}
	.stepper output {
		min-width: 2.5rem;
		text-align: center;
		font-size: 1.25rem;
		font-variant-numeric: tabular-nums;
	}
	.pattern .link,
	.advanced {
		margin-top: 1rem;
	}
	.set {
		margin: 0.75rem 0;
	}
	.set legend {
		padding: 0 0.25rem;
		font-weight: 600;
	}
	.advanced summary {
		display: flex;
		align-items: center;
		min-height: 44px;
		color: #a5b4fc;
		cursor: pointer;
	}
	button:focus-visible,
	input:focus-visible,
	textarea:focus-visible,
	a:focus-visible,
	summary:focus-visible {
		outline: 2px solid #a5b4fc;
		outline-offset: 3px;
	}
</style>
