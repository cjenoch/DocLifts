<script lang="ts">
	import type { PageData, ActionData } from './$types';
	import { pageTitle } from '$lib/app-shell';
	let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<svelte:head><title>{pageTitle('Connected agents')}</title></svelte:head>
<main class="mx-auto max-w-lg space-y-5 p-4">
	<a class="text-indigo-300" href="/account">← Account</a>
	<h1 class="text-2xl font-semibold break-words">Connected agents</h1>
	<p>
		Your data, with the tools you choose. Add this server in your agent, then sign in to DocLifts
		and review its access.
	</p>
	<code class="block rounded bg-zinc-900 p-3 break-all">{data.endpoint}</code>
	<p>
		Connections can only read. Photos and pain records are excluded. Notes need separate permission.
	</p>
	{#if form?.message}<p role="status">{form.message}</p>{/if}
	{#each data.connections as connection}
		<section class="space-y-2 rounded border border-zinc-700 p-3">
			<h2 class="font-semibold break-words">{connection.name || 'Agent connection'}</h2>
			<p class="text-sm break-all">{connection.clientId}</p>
			<p>{connection.scopes.join(', ')}</p>
			<form method="POST" action="?/revoke">
				<input type="hidden" name="clientId" value={connection.clientId} /><button
					class="min-h-11 rounded bg-red-950 px-4">Revoke access</button
				>
			</form>
		</section>
	{:else}<p>No connected agents yet.</p>{/each}
	<p class="text-sm text-zinc-400">
		Revoking stops future reads. It cannot recall information an agent already downloaded.
	</p>
</main>
