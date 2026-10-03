<script lang="ts">
	/**
	 * The add sheet (0.8.0, SPEC "machines, gyms and pickers", Parts I and J):
	 * one full-height sheet with two tabs. Machines: the gym's machines, recent
	 * first, then by body region; a machine leads to its exercises. Exercises:
	 * recent, suggested for the machine, then by region; a free weight is added
	 * at once, a machine exercise leads to the machines of its type. No
	 * dropdowns. The weight format is asked once per exercise and machine, then
	 * reused. Posts to the session's `?/addExercise`, which keeps its request-id
	 * protection against double submits.
	 */
	import { enhance } from '$app/forms';
	import { onMount, tick } from 'svelte';
	import { requestId as newRequestId } from '$lib/request-id';
	import {
		BODY_REGIONS,
		FREE_TYPES,
		MACHINE_TYPES,
		conventionLabel,
		conventionsFor,
		equipmentLabel,
		lowerBodyRegion,
		pickerUi as ui
	} from '$lib/picker-ui';
	import type { PickerData, PickerExercise, PickerMachine } from '$lib/server/picker';
	import { workoutUi } from '$lib/workout-ui';

	let {
		picker,
		sessionId,
		open = $bindable(false),
		/** The workout's own gym, where "Photo a machine" can file a photo. */
		photoGymId = null,
		/**
		 * Bind mode (0.8.1): choose the machine for a planned exercise of a
		 * program workout. Machines only, of the exercise's type, then a
		 * confirm step; posts to `?/bindMachine`.
		 */
		bind = null,
		/**
		 * Swap mode (editor spec, Part L): replace an untouched exercise of this
		 * workout. Exercises only, then a confirm step that, for a planned
		 * exercise of a program, asks "Just today" or "From now on"; posts to
		 * `?/swapExercise`.
		 */
		swap = null
	}: {
		picker: PickerData;
		sessionId: string;
		open?: boolean;
		photoGymId?: string | null;
		bind?: {
			occurrenceId: string;
			exerciseId: string;
			exerciseName: string;
			equipmentType: string;
		} | null;
		swap?: {
			occurrenceId: string;
			exerciseId: string;
			exerciseName: string;
			planned: boolean;
		} | null;
	} = $props();

	type NewMachine = { id: null; label: string; equipmentType: string; bodyRegion: null };
	type MachineChoice = PickerMachine | NewMachine;
	type NewExercise = {
		id: null;
		name: string;
		equipmentType: string;
		bodyRegion: string | null;
		isLowerBody: boolean;
	};
	type ExerciseChoice = PickerExercise | NewExercise;
	type View =
		| { kind: 'list' }
		| { kind: 'machine'; machine: PickerMachine }
		| { kind: 'newMachine' }
		| { kind: 'create' }
		| { kind: 'format'; exercise: ExerciseChoice; machine: MachineChoice | null }
		| { kind: 'confirm'; machine: MachineChoice }
		| { kind: 'swap'; exercise: PickerExercise };

	const tabKey = $derived(`doclifts:sheet-tab:${sessionId}`);
	let tab = $state<'machines' | 'exercises'>('machines');
	let view = $state<View>({ kind: 'list' });
	// svelte-ignore state_referenced_locally
	let gymId = $state(picker.gymId);
	let machineQuery = $state('');
	let exerciseQuery = $state('');
	/** Chosen first: the machine the exercise goes on, or the exercise looking for a machine. */
	let machineContext = $state<MachineChoice | null>(null);
	let exerciseContext = $state<ExerciseChoice | null>(null);
	let format = $state('');
	let newMachineName = $state('');
	let newMachineType = $state<string>('machine-stack');
	let createType = $state('dumbbell');
	let createRegion = $state<string | null>(null);
	let createLower = $state(false);
	let busy = $state(false);
	let message = $state('');
	let requestId = $state('');
	let payload = $state<Record<string, string>>({});
	let formEl: HTMLFormElement | undefined = $state();

	const gym = $derived(picker.gyms.find((g) => g.id === gymId) ?? null);
	const exerciseById = $derived(new Map(picker.exercises.map((e) => [e.id, e])));
	const gymMachines = $derived(picker.machines.filter((m) => m.gymId === gymId));
	const typeFilter = $derived(
		bind
			? bind.equipmentType
			: exerciseContext && !FREE_TYPES.includes(exerciseContext.equipmentType as never)
				? exerciseContext.equipmentType
				: null
	);
	let bindFormEl: HTMLFormElement | undefined = $state();

	onMount(() => {
		requestId = newRequestId();
		let saved: string | null = null;
		try {
			saved = sessionStorage.getItem(tabKey);
		} catch {
			/* A remembered tab is optional. */
		}
		tab = bind
			? 'machines'
			: swap
				? 'exercises'
				: saved === 'machines' || saved === 'exercises'
					? saved
					: gymMachines.length
						? 'machines'
						: 'exercises';
	});

	function setTab(next: 'machines' | 'exercises') {
		tab = next;
		view = { kind: 'list' };
		try {
			sessionStorage.setItem(tabKey, next);
		} catch {
			/* Optional. */
		}
	}
	function reset() {
		view = { kind: 'list' };
		machineContext = null;
		exerciseContext = null;
		machineQuery = '';
		exerciseQuery = '';
		message = '';
	}
	function close() {
		reset();
		open = false;
	}

	const fmtDate = (iso: string) =>
		new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
	const lastLine = (top: PickerExercise['lastTop']) =>
		top ? ui.last(fmtDate(top.at), top.load, top.reps) : '';
	const matchMachine = (m: PickerMachine, q: string) =>
		[m.label, m.modelName ?? '', m.modelCode ?? ''].some((v) =>
			v.toLowerCase().includes(q.toLowerCase())
		);

	const machineGroups = $derived.by(() => {
		const list = gymMachines.filter(
			(m) => (!typeFilter || m.equipmentType === typeFilter) && matchMachine(m, machineQuery)
		);
		return [...BODY_REGIONS, null]
			.map((region) => ({ region, items: list.filter((m) => (m.bodyRegion ?? null) === region) }))
			.filter((g) => g.items.length);
	});
	const recentMachines = $derived(
		(picker.recentMachineIds[gymId ?? ''] ?? [])
			.map((id) => gymMachines.find((m) => m.id === id))
			.filter((m): m is PickerMachine => !!m && (!typeFilter || m.equipmentType === typeFilter))
	);
	const lastMachineHere = $derived(
		exerciseContext?.id && gymId
			? gymMachines.find((m) => m.id === picker.lastMachineAt[`${exerciseContext!.id}|${gymId}`])
			: undefined
	);

	const machineType = $derived(machineContext?.equipmentType ?? null);
	const exerciseFits = (e: PickerExercise) =>
		(!machineType || e.equipmentType === machineType) && e.id !== swap?.exerciseId;
	const query = $derived(exerciseQuery.trim().toLowerCase());
	const exerciseGroups = $derived.by(() => {
		const list = picker.exercises.filter(
			(e) => exerciseFits(e) && (!query || e.name.toLowerCase().includes(query))
		);
		return [...BODY_REGIONS, null]
			.map((region) => ({ region, items: list.filter((e) => (e.bodyRegion ?? null) === region) }))
			.filter((g) => g.items.length);
	});
	const recentExercises = $derived(
		query
			? []
			: picker.recentExerciseIds
					.map((id) => exerciseById.get(id))
					.filter((e): e is PickerExercise => !!e && exerciseFits(e))
	);
	const suggested = $derived(
		machineContext && machineContext.id
			? (machineContext as PickerMachine).exerciseIds
					.map((id) => exerciseById.get(id))
					.filter((e): e is PickerExercise => !!e && exerciseFits(e))
			: []
	);
	const canCreate = $derived(
		!swap &&
			exerciseQuery.trim().length > 0 &&
			!picker.exercises.some((e) => e.name.toLowerCase() === query)
	);

	function rememberedFormat(exercise: ExerciseChoice, machine: MachineChoice | null) {
		if (!exercise.id) return null;
		const key = machine ? `${exercise.id}|${machine.id ?? ''}` : `${exercise.id}|`;
		return picker.conventions[key] ?? null;
	}

	/** An exercise chosen: add it, or ask for what is still missing. */
	function chooseExercise(exercise: ExerciseChoice) {
		message = '';
		if (swap && exercise.id) {
			view = { kind: 'swap', exercise: exercise as PickerExercise };
			return;
		}
		const machine = machineContext;
		if (machine) {
			if (machine.equipmentType !== exercise.equipmentType) {
				message = `${exercise.name} is a ${equipmentLabel(exercise.equipmentType).toLowerCase()} exercise.`;
				return;
			}
			return addOrAsk(exercise, machine);
		}
		if (FREE_TYPES.includes(exercise.equipmentType as never)) {
			// Free weights go in at once: no gym, no equipment (owner, 2026-10-02).
			return submit(
				exercise,
				null,
				rememberedFormat(exercise, null) ?? conventionsFor(exercise.equipmentType).preset
			);
		}
		// A machine exercise: pick the machine it is on, here.
		exerciseContext = exercise;
		machineQuery = '';
		setTab('machines');
	}
	function confirmBind(machine: MachineChoice) {
		if (!bind) return;
		format =
			(machine.id ? picker.conventions[`${bind.exerciseId}|${machine.id}`] : null) ??
			conventionsFor(bind.equipmentType).preset;
		view = { kind: 'confirm', machine };
	}
	async function submitBind(machine: MachineChoice) {
		if (!bind) return;
		const fields: Record<string, string> = {
			occurrenceId: bind.occurrenceId,
			equipmentType: bind.equipmentType,
			loadConvention: format,
			// The confirm step is the old "CHANGE" checkbox (machines spec Part I).
			confirm: 'CHANGE'
		};
		if (gymId) fields.gymId = gymId;
		if (machine.id) fields.gymEquipmentId = machine.id;
		else fields.newMachineName = machine.label;
		payload = fields;
		await tick();
		bindFormEl?.requestSubmit();
	}
	let swapFormEl: HTMLFormElement | undefined = $state();
	async function submitSwap(exercise: PickerExercise, scope: 'today' | 'program') {
		if (!swap) return;
		const fields: Record<string, string> = {
			occurrenceId: swap.occurrenceId,
			exerciseId: exercise.id,
			scope
		};
		// A free weight keeps its remembered weight format, so its history is found.
		if (FREE_TYPES.includes(exercise.equipmentType as never))
			fields.loadConvention =
				rememberedFormat(exercise, null) ?? conventionsFor(exercise.equipmentType).preset;
		payload = fields;
		await tick();
		swapFormEl?.requestSubmit();
	}
	function chooseMachine(machine: PickerMachine) {
		message = '';
		if (bind) return confirmBind(machine);
		if (exerciseContext) {
			if (exerciseContext.equipmentType !== machine.equipmentType) {
				message = `${machine.label} is a ${equipmentLabel(machine.equipmentType).toLowerCase()} machine.`;
				return;
			}
			return addOrAsk(exerciseContext, machine);
		}
		machineContext = machine;
		view = { kind: 'machine', machine };
	}
	function addOrAsk(exercise: ExerciseChoice, machine: MachineChoice) {
		const known = rememberedFormat(exercise, machine);
		if (known) return submit(exercise, machine, known);
		format = conventionsFor(machine.equipmentType).preset;
		view = { kind: 'format', exercise, machine };
	}

	function startCreate() {
		const name = exerciseQuery.trim();
		createType =
			machineType ??
			exerciseById.get(picker.recentExerciseIds[0] ?? '')?.equipmentType ??
			'dumbbell';
		createRegion =
			machineContext && 'bodyRegion' in machineContext ? machineContext.bodyRegion : null;
		createLower = lowerBodyRegion(createRegion);
		view = { kind: 'create' };
		newExerciseName = name;
	}
	let newExerciseName = $state('');
	function finishCreate() {
		const exercise: NewExercise = {
			id: null,
			name: newExerciseName.trim(),
			equipmentType: machineType ?? createType,
			bodyRegion: createRegion,
			isLowerBody: createLower
		};
		if (!exercise.name) return;
		chooseExercise(exercise);
	}
	function finishNewMachine() {
		const label = newMachineName.trim();
		if (!label) return;
		const machine: NewMachine = {
			id: null,
			label,
			equipmentType: newMachineType,
			bodyRegion: null
		};
		if (bind) return confirmBind(machine);
		// Came from an exercise: it goes on this new machine now.
		if (exerciseContext) return addOrAsk(exerciseContext, machine);
		machineContext = machine;
		setTab('exercises');
		exerciseQuery = '';
	}
	function startNewMachine() {
		newMachineName = '';
		newMachineType = typeFilter ?? 'machine-stack';
		view = { kind: 'newMachine' };
	}

	async function submit(
		exercise: ExerciseChoice,
		machine: MachineChoice | null,
		convention: string
	) {
		const fields: Record<string, string> = {
			requestId,
			equipmentType: exercise.equipmentType,
			loadConvention: convention,
			setCount: String(ui.setsDefault.setCount),
			repsMin: String(ui.setsDefault.repsMin),
			repsMax: String(ui.setsDefault.repsMax),
			rir: String(ui.setsDefault.rir),
			tier: 'secondary',
			progressionPolicy: 'standard'
		};
		if (gymId) fields.gymId = gymId;
		if (exercise.id) fields.exerciseId = exercise.id;
		else {
			fields.exerciseName = exercise.name;
			// The server reads a present '1' as lower body, an absent field as not.
			if (exercise.isLowerBody) fields.isLowerBody = '1';
			if (exercise.bodyRegion) fields.bodyRegion = exercise.bodyRegion;
		}
		if (machine?.id) fields.gymEquipmentId = machine.id;
		else if (machine) fields.newMachineName = machine.label;
		payload = fields;
		await tick();
		formEl?.requestSubmit();
	}
</script>

{#if open}
	<div class="sheet" role="dialog" aria-modal="true" aria-label={ui.addExercise}>
		<header class="sheet-head">
			<div class="flex items-center justify-between gap-2">
				<h2 class="text-lg font-semibold">
					{bind
						? ui.chooseMachineFor(bind.exerciseName)
						: swap
							? workoutUi.swapFor(swap.exerciseName)
							: ui.addExercise}
				</h2>
				<button class="min-h-11 px-2 text-indigo-200" onclick={close}>{ui.close}</button>
			</div>
			{#if gym}
				<div class="flex flex-wrap items-center gap-2 text-sm text-zinc-400">
					<span data-testid="sheet-gym">{gym.name}</span>
					{#if picker.gyms.length > 1}
						<details class="relative">
							<summary class="min-h-11 cursor-pointer leading-[2.75rem] text-indigo-300"
								>{ui.switchGym}</summary
							>
							<div class="flex flex-wrap gap-2 py-2">
								{#each picker.gyms as g (g.id)}
									<button
										class="chip"
										aria-pressed={g.id === gymId}
										onclick={(e) => {
											gymId = g.id;
											(e.currentTarget.closest('details') as HTMLDetailsElement).open = false;
										}}>{g.name}</button
									>
								{/each}
							</div>
						</details>
					{/if}
				</div>
			{/if}
			<div class="tabs" role="tablist" hidden={!!bind || !!swap}>
				<button role="tab" aria-selected={tab === 'machines'} onclick={() => setTab('machines')}
					>{ui.machinesTab}</button
				>
				<button role="tab" aria-selected={tab === 'exercises'} onclick={() => setTab('exercises')}
					>{ui.exercisesTab}</button
				>
			</div>
		</header>

		{#if message}<p role="alert" class="px-4 pt-3 text-amber-300">{message}</p>{/if}
		{#if machineContext && tab === 'exercises' && view.kind === 'list'}
			<p class="context" data-testid="machine-context">
				{machineContext.label}
				<button class="text-indigo-300" onclick={reset}>{ui.back}</button>
			</p>
		{/if}
		{#if exerciseContext && tab === 'machines' && view.kind === 'list'}
			<p class="context" data-testid="exercise-context">
				{exerciseContext.name}
				<button class="text-indigo-300" onclick={reset}>{ui.back}</button>
			</p>
		{/if}

		<div class="sheet-body">
			{#if view.kind === 'swap' && swap}
				<p class="font-semibold" data-testid="swap-confirm">
					{workoutUi.swapConfirm(swap.exerciseName, view.exercise.name)}
				</p>
				<p class="mt-1 text-sm text-zinc-400">{workoutUi.swapNote}</p>
				{#if swap.planned}
					<button
						class="cta mt-4"
						disabled={busy}
						onclick={() => view.kind === 'swap' && submitSwap(view.exercise, 'today')}
						>{workoutUi.swapToday}</button
					>
					<button
						class="cta mt-2"
						disabled={busy}
						onclick={() => view.kind === 'swap' && submitSwap(view.exercise, 'program')}
						>{workoutUi.swapFromNow}</button
					>
					<p class="mt-2 text-sm text-zinc-400">{workoutUi.swapFromNowNote}</p>
				{:else}
					<button
						class="cta mt-4"
						disabled={busy}
						onclick={() => view.kind === 'swap' && submitSwap(view.exercise, 'today')}
						>{workoutUi.swapGo}</button
					>
				{/if}
				<button class="row mt-2" onclick={reset}>{ui.back}</button>
			{:else if view.kind === 'confirm'}
				<p class="font-semibold" data-testid="bind-confirm">
					{ui.useMachineFor(view.machine.label)}
				</p>
				<p class="mt-1 text-sm text-zinc-400">{ui.bindNote}</p>
				<p class="mt-3 mb-2 text-sm text-zinc-300">{ui.weightFormat}</p>
				<div class="flex flex-wrap gap-2">
					{#each conventionsFor(view.machine.equipmentType).options as c (c)}
						<button class="chip" aria-pressed={format === c} onclick={() => (format = c)}
							>{conventionLabel(c)}</button
						>
					{/each}
				</div>
				<button
					class="cta mt-4"
					disabled={busy}
					onclick={() => view.kind === 'confirm' && submitBind(view.machine)}
					>{ui.useThisMachine}</button
				>
				<button class="row mt-2" onclick={reset}>{ui.back}</button>
			{:else if view.kind === 'machine'}
				{@const m = view.machine}
				<p class="font-semibold">{m.label}</p>
				{#if m.modelName}<p class="text-sm text-zinc-400">{m.modelName}</p>{/if}
				<div class="mt-3 space-y-2">
					{#each m.exerciseIds as id, i (id)}
						{@const ex = exerciseById.get(id)}
						{#if ex}
							<button
								class="row {i === 0 && id === m.lastExerciseId ? 'primary' : ''}"
								onclick={() => chooseExercise(ex)}
								><span>{ex.name}</span><small>{lastLine(ex.lastTop)}</small></button
							>
						{/if}
					{/each}
					<button
						class="row"
						onclick={() => {
							view = { kind: 'list' };
							setTab('exercises');
						}}>{ui.anotherExercise}</button
					>
					<button class="row" onclick={reset}>{ui.back}</button>
				</div>
			{:else if view.kind === 'format'}
				<p class="font-semibold">{view.exercise.name}</p>
				{#if view.machine}<p class="text-sm text-zinc-400">{view.machine.label}</p>{/if}
				<p class="mt-3 mb-2 text-sm text-zinc-300">{ui.weightFormat}</p>
				<div class="flex flex-wrap gap-2">
					{#each conventionsFor(view.exercise.equipmentType).options as c (c)}
						<button class="chip" aria-pressed={format === c} onclick={() => (format = c)}
							>{conventionLabel(c)}</button
						>
					{/each}
				</div>
				<button
					class="cta mt-4"
					disabled={busy}
					onclick={() => view.kind === 'format' && submit(view.exercise, view.machine, format)}
					>{ui.add}</button
				>
			{:else if view.kind === 'newMachine'}
				<label class="block text-sm text-zinc-300"
					>{ui.machineName}<input
						bind:value={newMachineName}
						maxlength="120"
						autocomplete="off"
						autocapitalize="words"
						class="mt-1 block w-full rounded-lg bg-zinc-800 p-3 text-base"
					/></label
				>
				<p class="mt-3 mb-2 text-sm text-zinc-300">{ui.equipment}</p>
				<div class="flex flex-wrap gap-2">
					{#each typeFilter ? [typeFilter] : MACHINE_TYPES as t (t)}
						<button
							class="chip"
							aria-pressed={newMachineType === t}
							onclick={() => (newMachineType = t)}>{equipmentLabel(t)}</button
						>
					{/each}
				</div>
				<button class="cta mt-4" disabled={!newMachineName.trim()} onclick={finishNewMachine}
					>{ui.add}</button
				>
				<button class="row mt-2" onclick={reset}>{ui.back}</button>
			{:else if view.kind === 'create'}
				<label class="block text-sm text-zinc-300"
					>Name<input
						bind:value={newExerciseName}
						maxlength="120"
						autocomplete="off"
						autocapitalize="sentences"
						class="mt-1 block w-full rounded-lg bg-zinc-800 p-3 text-base"
					/></label
				>
				{#if !machineType}
					<p class="mt-3 mb-2 text-sm text-zinc-300">{ui.equipment}</p>
					<div class="flex flex-wrap gap-2">
						{#each [...FREE_TYPES, ...MACHINE_TYPES] as t (t)}
							<button class="chip" aria-pressed={createType === t} onclick={() => (createType = t)}
								>{equipmentLabel(t)}</button
							>
						{/each}
					</div>
				{/if}
				<p class="mt-3 mb-2 text-sm text-zinc-300">{ui.region}</p>
				<div class="flex flex-wrap gap-2">
					{#each [...BODY_REGIONS, null] as r (r ?? 'other')}
						<button
							class="chip"
							aria-pressed={createRegion === r}
							onclick={() => {
								createRegion = r;
								createLower = lowerBodyRegion(r);
							}}>{r ?? ui.other}</button
						>
					{/each}
				</div>
				<label class="mt-3 flex min-h-11 items-center gap-3 text-sm"
					><input type="checkbox" bind:checked={createLower} class="size-5" />{ui.lowerBody}</label
				>
				<button class="cta mt-4" disabled={!newExerciseName.trim() || busy} onclick={finishCreate}
					>{ui.add}</button
				>
				<button class="row mt-2" onclick={() => (view = { kind: 'list' })}>{ui.back}</button>
			{:else if tab === 'machines'}
				{#if !exerciseContext}
					<div class="space-y-2">
						{#if photoGymId && photoGymId === gymId && !bind}<button
								class="row primary"
								onclick={() => {
									// The workout bar's photo input: close the sheet and open the picker.
									close();
									document.getElementById('photo-next-input')?.click();
								}}>{ui.photoMachine}</button
							>{/if}
						<button class="row" onclick={startNewMachine}>{ui.addByName}</button>
					</div>
				{:else}
					<div class="space-y-2">
						{#if lastMachineHere && (!typeFilter || lastMachineHere.equipmentType === typeFilter)}
							<button class="row primary" onclick={() => chooseMachine(lastMachineHere)}
								>{ui.lastHere(lastMachineHere.label)}</button
							>
						{/if}
						<button class="row" onclick={startNewMachine}>{ui.addByName}</button>
					</div>
				{/if}
				<input
					type="search"
					bind:value={machineQuery}
					placeholder={ui.searchMachines}
					aria-label={ui.searchMachines}
					autocomplete="off"
					autocapitalize="none"
					spellcheck="false"
					class="search"
				/>
				{#if !gymMachines.length}<p class="text-zinc-400">{ui.noMachines}</p>{/if}
				{#if recentMachines.length && !machineQuery}
					<h3>{ui.recentHere}</h3>
					{#each recentMachines as m (m.id)}{@render machineRow(m)}{/each}
				{/if}
				{#each machineGroups as g (g.region ?? 'other')}
					<h3>{g.region ?? ui.other}</h3>
					{#each g.items as m (m.id)}{@render machineRow(m)}{/each}
				{/each}
			{:else}
				<input
					type="search"
					bind:value={exerciseQuery}
					placeholder={ui.searchExercises}
					aria-label={ui.searchExercises}
					autocomplete="off"
					autocapitalize="none"
					spellcheck="false"
					class="search"
				/>
				{#if canCreate}
					<button class="row primary" onclick={startCreate}
						>{ui.create(exerciseQuery.trim())}</button
					>
				{/if}
				{#if suggested.length && !query}
					<h3>{ui.suggested}</h3>
					{#each suggested as e (e.id)}{@render exerciseRow(e)}{/each}
				{/if}
				{#if recentExercises.length}
					<h3>{ui.recent}</h3>
					{#each recentExercises as e (e.id)}{@render exerciseRow(e)}{/each}
				{/if}
				{#each exerciseGroups as g (g.region ?? 'other')}
					<h3>{g.region ?? ui.other}</h3>
					{#each g.items as e (e.id)}{@render exerciseRow(e)}{/each}
				{/each}
				<a href="/exercises" class="mt-4 flex min-h-11 items-center text-sm text-indigo-300"
					>{ui.manageExercises}</a
				>
			{/if}
		</div>

		<form
			method="POST"
			action="?/bindMachine"
			bind:this={bindFormEl}
			class="hidden"
			use:enhance={() => {
				busy = true;
				message = '';
				return async ({ result, update }) => {
					try {
						if (result.type === 'redirect' || result.type === 'success') {
							await update({ reset: false });
							close();
						} else if (result.type === 'failure') {
							message = String(result.data?.message ?? 'Could not use that machine.');
						} else if (result.type === 'error') {
							message = 'That did not get through. Try again.';
						}
					} finally {
						busy = false;
					}
				};
			}}
		>
			{#each Object.entries(payload) as [name, value] (name)}<input
					type="hidden"
					{name}
					{value}
				/>{/each}
		</form>
		<form
			method="POST"
			action="?/swapExercise"
			bind:this={swapFormEl}
			class="hidden"
			use:enhance={() => {
				busy = true;
				message = '';
				return async ({ result, update }) => {
					try {
						if (result.type === 'success') {
							await update({ reset: false });
							close();
						} else if (result.type === 'failure') {
							message = String(result.data?.message ?? 'Could not swap that exercise.');
						} else if (result.type === 'error') {
							message = 'That did not get through. Try again.';
						}
					} finally {
						busy = false;
					}
				};
			}}
		>
			{#each Object.entries(payload) as [name, value] (name)}<input
					type="hidden"
					{name}
					{value}
				/>{/each}
		</form>
		<form
			method="POST"
			action="?/addExercise"
			bind:this={formEl}
			class="hidden"
			use:enhance={() => {
				busy = true;
				message = '';
				return async ({ result, update }) => {
					try {
						if (result.type === 'success' && result.data?.addedExerciseId) {
							requestId = newRequestId();
							await update({ reset: false });
							close();
							await tick();
							document
								.getElementById(`exercise-${result.data.addedExerciseId}`)
								?.scrollIntoView({ behavior: 'smooth', block: 'start' });
						} else if (result.type === 'failure') {
							message = String(result.data?.message ?? 'Could not add that exercise.');
						} else if (result.type === 'error') {
							message = 'That did not get through. Try again.';
						}
					} finally {
						busy = false;
					}
				};
			}}
		>
			{#each Object.entries(payload) as [name, value] (name)}<input
					type="hidden"
					{name}
					{value}
				/>{/each}
		</form>
	</div>
{/if}

{#snippet machineRow(m: PickerMachine)}
	<button class="row machine" onclick={() => chooseMachine(m)} data-testid="machine-row">
		{#if m.photoId}<img
				src={`/photos/${m.photoId}/image`}
				alt=""
				width="40"
				height="40"
				loading="lazy"
				class="size-10 shrink-0 rounded object-cover"
			/>{/if}
		<span class="min-w-0 flex-1">
			<span class="block">{m.label}</span>
			<small
				>{[
					m.modelName && m.modelName !== m.label ? m.modelName : null,
					m.lastExerciseId && m.lastUsedAt
						? `${exerciseById.get(m.lastExerciseId)?.name ?? ''} · ${fmtDate(m.lastUsedAt)}`
						: null
				]
					.filter(Boolean)
					.join(' · ')}</small
			>
		</span>
	</button>
{/snippet}

{#snippet exerciseRow(e: PickerExercise)}
	<button class="row" onclick={() => chooseExercise(e)} data-testid="exercise-row">
		<span class="min-w-0 flex-1">
			<span class="block">{e.name}</span>
			<small
				>{[equipmentLabel(e.equipmentType), lastLine(e.lastTop)].filter(Boolean).join(' · ')}</small
			>
		</span>
	</button>
{/snippet}

<style>
	.sheet {
		position: fixed;
		inset: 0;
		z-index: 60;
		display: flex;
		flex-direction: column;
		background: #09090b;
		padding-top: env(safe-area-inset-top);
		padding-bottom: env(safe-area-inset-bottom);
	}
	.sheet-head {
		padding: 12px 16px 0;
		border-bottom: 1px solid #27272a;
	}
	.sheet-body {
		flex: 1;
		overflow-y: auto;
		padding: 12px 16px 32px;
	}
	.tabs {
		display: flex;
		margin-top: 8px;
	}
	.tabs button {
		flex: 1;
		min-height: 44px;
		font-weight: 600;
		color: #a1a1aa;
		border-bottom: 2px solid transparent;
	}
	.tabs button[aria-selected='true'] {
		color: #e0e7ff;
		border-bottom-color: #818cf8;
	}
	.context {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 12px;
		min-height: 44px;
		padding: 0 16px;
		font-size: 14px;
		color: #d4d4d8;
		background: #18181b;
	}
	.context button {
		min-height: 44px;
	}
	.search {
		display: block;
		width: 100%;
		margin: 12px 0 4px;
		padding: 12px;
		border-radius: 10px;
		background: #18181b;
		border: 1px solid #3f3f46;
		font-size: 16px;
	}
	h3 {
		margin: 16px 0 4px;
		font-size: 12px;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: #71717a;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 12px;
		width: 100%;
		min-height: 52px;
		padding: 8px 4px;
		text-align: left;
		border-bottom: 1px solid #1f1f23;
		cursor: pointer;
	}
	.row small {
		display: block;
		color: #a1a1aa;
		font-size: 12px;
	}
	.row.primary small {
		color: #d1fae5;
	}
	.row.primary {
		justify-content: center;
		border: 0;
		border-radius: 10px;
		background: #059669;
		color: #fff;
		font-weight: 600;
		padding: 8px 12px;
	}
	.chip {
		min-height: 44px;
		padding: 0 14px;
		border-radius: 999px;
		border: 1px solid #3f3f46;
		color: #d4d4d8;
		font-size: 14px;
	}
	.chip[aria-pressed='true'] {
		border-color: #818cf8;
		background: #1e1b4b;
		color: #e0e7ff;
	}
	.cta {
		display: block;
		width: 100%;
		min-height: 52px;
		border-radius: 10px;
		background: #c7d2fe;
		color: #182044;
		font-weight: 700;
	}
	.cta:disabled {
		opacity: 0.5;
	}
</style>
