<script lang="ts">
	/**
	 * The program editor's exercise picker (editor spec, Part N): replaces the
	 * old library dropdown. Search, the user's exercises, the ones already new
	 * in this draft, and "Create" — the only place equipment type and lower
	 * body are asked, because they matter only for a new exercise.
	 */
	import { editorUi as ui } from '$lib/editor-ui';

	type LibraryExercise = { id: string; name: string; equipmentType: string; isLowerBody: boolean };
	type NewExercise = { name: string; equipmentType: string; isLowerBody: boolean };
	let {
		library,
		drafted,
		onchoose,
		onclose
	}: {
		library: LibraryExercise[];
		/** New exercises already in the draft, so a second day can reuse one. */
		drafted: NewExercise[];
		onchoose: (choice: { exerciseId: string } | { newExercise: NewExercise }) => void;
		onclose: () => void;
	} = $props();

	const TYPES = Object.keys(ui.equipmentLabels);
	let query = $state('');
	let creating = $state<NewExercise | null>(null);
	const q = $derived(query.trim().toLowerCase());
	const matches = (name: string) => !q || name.toLowerCase().includes(q);
	const fromLibrary = $derived(library.filter((e) => matches(e.name)));
	const fromDraft = $derived(
		drafted.filter(
			(e, i) =>
				matches(e.name) &&
				drafted.findIndex((x) => x.name.toLowerCase() === e.name.toLowerCase()) === i &&
				!library.some((x) => x.name.toLowerCase() === e.name.toLowerCase())
		)
	);
	const canCreate = $derived(
		q.length > 0 && ![...library, ...drafted].some((e) => e.name.trim().toLowerCase() === q)
	);
</script>

<div class="sheet" role="dialog" aria-modal="true" aria-label={ui.pickerTitle}>
	<header class="head">
		<h2>{ui.pickerTitle}</h2>
		<button type="button" class="link" onclick={onclose}>{ui.close}</button>
	</header>
	<div class="body">
		{#if creating}
			<label class="field"
				>Name<input
					bind:value={creating.name}
					maxlength="200"
					autocomplete="off"
					autocapitalize="sentences"
				/></label
			>
			<p class="label">{ui.equipment}</p>
			<div class="chips">
				{#each TYPES as type (type)}
					<button
						type="button"
						class="chip"
						aria-pressed={creating.equipmentType === type}
						onclick={() => creating && (creating.equipmentType = type)}
						>{ui.equipmentLabels[type]}</button
					>
				{/each}
			</div>
			<label class="check"
				><input type="checkbox" bind:checked={creating.isLowerBody} />{ui.lowerBody}</label
			>
			<button
				type="button"
				class="cta"
				disabled={!creating.name.trim()}
				onclick={() =>
					creating && onchoose({ newExercise: { ...creating, name: creating.name.trim() } })}
				>{ui.use}</button
			>
		{:else}
			<input
				type="search"
				class="search"
				bind:value={query}
				placeholder={ui.search}
				aria-label={ui.search}
				autocomplete="off"
				autocapitalize="none"
				spellcheck="false"
			/>
			{#if canCreate}
				<button
					type="button"
					class="row primary"
					onclick={() =>
						(creating = { name: query.trim(), equipmentType: 'dumbbell', isLowerBody: false })}
					>{ui.create(query.trim())}</button
				>
			{/if}
			{#if fromDraft.length}
				<h3>{ui.newInDraft}</h3>
				{#each fromDraft as e (e.name)}
					<button
						type="button"
						class="row"
						data-testid="chooser-row"
						onclick={() => onchoose({ newExercise: { ...e } })}
						><span>{e.name}</span><small
							>{ui.equipmentLabels[e.equipmentType] ?? e.equipmentType}</small
						></button
					>
				{/each}
			{/if}
			<h3>{ui.library}</h3>
			{#each fromLibrary as e (e.id)}
				<button
					type="button"
					class="row"
					data-testid="chooser-row"
					onclick={() => onchoose({ exerciseId: e.id })}
					><span>{e.name}</span><small
						>{ui.equipmentLabels[e.equipmentType] ?? e.equipmentType}</small
					></button
				>
			{/each}
		{/if}
	</div>
</div>

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
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 12px 16px;
		border-bottom: 1px solid #27272a;
	}
	h2 {
		font-size: 1.125rem;
		font-weight: 600;
	}
	.body {
		flex: 1;
		overflow-y: auto;
		padding: 12px 16px 32px;
	}
	.link {
		min-height: 44px;
		padding: 0 8px;
		color: #c7d2fe;
	}
	.search,
	.field input {
		display: block;
		width: 100%;
		margin: 4px 0;
		padding: 12px;
		border-radius: 10px;
		background: #18181b;
		border: 1px solid #3f3f46;
		font-size: 16px;
	}
	.field,
	.label {
		display: block;
		margin-top: 12px;
		font-size: 14px;
		color: #d4d4d8;
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
		flex-direction: column;
		align-items: flex-start;
		width: 100%;
		min-height: 52px;
		padding: 8px 4px;
		text-align: left;
		border-bottom: 1px solid #1f1f23;
	}
	.row small {
		color: #a1a1aa;
		font-size: 12px;
	}
	.row.primary {
		align-items: center;
		justify-content: center;
		border: 0;
		border-radius: 10px;
		background: #059669;
		color: #fff;
		font-weight: 600;
		margin-top: 8px;
	}
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 8px;
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
	.check {
		display: flex;
		align-items: center;
		gap: 12px;
		min-height: 44px;
		margin-top: 12px;
		font-size: 14px;
	}
	.check input {
		width: 20px;
		height: 20px;
	}
	.cta {
		display: block;
		width: 100%;
		min-height: 52px;
		margin-top: 16px;
		border-radius: 10px;
		background: #c7d2fe;
		color: #182044;
		font-weight: 700;
	}
	.cta:disabled {
		opacity: 0.5;
	}
</style>
