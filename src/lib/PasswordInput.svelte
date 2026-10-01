<script lang="ts">
	/**
	 * A password field with a reveal toggle — spec §2 item 2, on every password
	 * field (/login and /account/password).
	 *
	 * WHY THIS MATTERS HERE
	 * ---------------------
	 * The owner signs in on an iPhone, where `@` and `!` each take a second tap
	 * and a masked field hides exactly the mistake that produces "do not match".
	 * Seeing what was typed is the cheapest fix for that whole class of failure.
	 *
	 * CSP
	 * ---
	 * No inline script and no inline style. The click handler ships in the app
	 * bundle, which SvelteKit loads through its own nonce'd entry script under
	 * the existing `script-src 'self' 'nonce-…'` policy; the CSP crawl in
	 * e2e/csp.e2e.ts clicks every toggle on the served build and fails on any
	 * violation.
	 *
	 * The button is rendered only after hydration. Without JavaScript it could
	 * do nothing, and a control that does nothing is worse than no control.
	 */
	import type { HTMLInputAttributes } from 'svelte/elements';

	let {
		id,
		label,
		...rest
	}: { id: string; label: string } & Omit<HTMLInputAttributes, 'type' | 'id'> = $props();

	let visible = $state(false);
	let hydrated = $state(false);
	$effect(() => {
		hydrated = true;
	});
</script>

<div>
	<label for={id} class="mb-1 block text-sm font-medium">{label}</label>
	<div class="flex gap-2">
		<input
			{id}
			type={visible ? 'text' : 'password'}
			{...rest}
			autocapitalize="none"
			autocorrect="off"
			spellcheck="false"
			class="w-full min-w-0 flex-1 rounded border border-neutral-300 px-3 py-2"
		/>
		{#if hydrated}
			<button
				type="button"
				aria-controls={id}
				aria-pressed={visible}
				aria-label={`${visible ? 'Hide' : 'Show'} ${label.toLowerCase()}`}
				onclick={() => (visible = !visible)}
				class="shrink-0 rounded border border-neutral-300 px-3 py-2 text-sm"
				>{visible ? 'Hide' : 'Show'}</button
			>
		{/if}
	</div>
</div>
