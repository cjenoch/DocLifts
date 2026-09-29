<script lang="ts">
	import type { ActionData } from './$types';

	let { form }: { form: ActionData } = $props();
</script>

<svelte:head><title>Sign in — DocLifts</title></svelte:head>

<main class="mx-auto max-w-sm px-4 py-16">
	<h1 class="mb-6 text-2xl font-semibold">Sign in</h1>

	{#if form?.error}
		<p
			class="mb-4 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800"
			role="alert"
		>
			{form.error}
		</p>
	{/if}

	<form method="POST" class="space-y-4">
		{#if form?.email}
			<input type="hidden" name="email" value={form.email} />
		{/if}

		<label class="block">
			<span class="mb-1 block text-sm font-medium">Email</span>
			<input
				name="email"
				type="email"
				autocomplete="username"
				required
				value={form?.email ?? ''}
				class="w-full rounded border border-neutral-300 px-3 py-2"
			/>
		</label>

		<label class="block">
			<span class="mb-1 block text-sm font-medium">Password</span>
			<input
				name="password"
				type="password"
				autocomplete="current-password"
				required
				class="w-full rounded border border-neutral-300 px-3 py-2"
			/>
		</label>

		<button type="submit" class="w-full rounded bg-neutral-900 px-3 py-2 font-medium text-white">
			Sign in
		</button>
	</form>
</main>
