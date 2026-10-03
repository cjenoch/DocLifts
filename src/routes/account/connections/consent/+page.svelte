<script lang="ts">
	import type { PageData, ActionData } from './$types';
	let { data, form }: { data: PageData; form: ActionData } = $props();
	$effect(() => {
		if (form?.redirectUrl) window.location.replace(form.redirectUrl);
	});
</script>

<svelte:head><title>Approve agent access · DocLifts</title></svelte:head>
<main class="mx-auto max-w-lg space-y-5 p-4">
	{#if form?.redirectUrl}
		<h1 class="text-2xl font-semibold break-words">Return to your agent</h1>
		<a
			class="inline-flex min-h-11 items-center rounded bg-indigo-600 px-4"
			href={form.redirectUrl}
			rel="noreferrer"
			data-sveltekit-reload>Continue to agent</a
		>
	{:else}
		<h1 class="text-2xl font-semibold break-words">Connect {data.client.name || 'this agent'}?</h1>
		<p>Signed in as <strong>{data.email}</strong>.</p>
		<p class="text-sm break-all text-zinc-400">Client: {data.client.id}</p>
		<p>This client asks to:</p>
		<ul class="list-disc space-y-2 pl-5">
			{#each data.scopes as scope}<li>{scope.label}</li>{/each}
		</ul>
		<p>
			It cannot change your workouts. Information it reads leaves DocLifts and is handled by that
			service. Approve only a connection you started.
		</p>
		<form method="POST" class="flex gap-3">
			<button name="decision" value="allow" class="min-h-11 rounded bg-indigo-600 px-4"
				>Allow read access</button
			><button name="decision" value="deny" class="min-h-11 rounded border border-zinc-600 px-4"
				>Deny</button
			>
		</form>
		<p class="text-sm text-zinc-400">
			You can revoke access at any time in Account → Connected agents.
		</p>
	{/if}
</main>
