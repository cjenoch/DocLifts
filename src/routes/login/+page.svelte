<script lang="ts">
	import type { ActionData } from './$types';
	import PasswordInput from '$lib/PasswordInput.svelte';

	let { form, data }: { form: ActionData; data: { demoMode?: boolean } } = $props();

	// Demo mode is a fictional, disposable dataset on a throwaway local stack
	// (compose.demo.yml, localhost only). Surfacing the shared credentials is
	// what makes the demo usable at all; it is never shown in any other mode,
	// and the values match the defaults in src/lib/server/demo.ts.
	const demoEmail = 'demo@doclifts.local';
	const demoPassword = 'doclifts-demo-2026';
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
			<!--
				Shown only for the rate-limit case, where the action returns 429
				with Better Auth's own Retry-After. Rendering the number is the
				point: without it the message is just "try again shortly" with no
				idea how shortly. The login form itself stays usable, because
				the window is 10s and a person can simply try again.
			-->
			{#if form.retryAfter}
				<span class="mt-1 block text-red-700">
					Try again in about {form.retryAfter} second{form.retryAfter === '1' ? '' : 's'}.
				</span>
			{/if}
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

		<PasswordInput
			id="password"
			label="Password"
			name="password"
			autocomplete="current-password"
			required
		/>

		<button type="submit" class="w-full rounded bg-neutral-900 px-3 py-2 font-medium text-white">
			Sign in
		</button>
	</form>

	{#if data?.demoMode}
		<div class="mt-8 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm">
			<p class="font-medium text-amber-900">Demo mode</p>
			<p class="mt-1 text-amber-800">Fictional sample data on a local throwaway stack.</p>
			<dl class="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-amber-900">
				<dt class="font-medium">Email</dt>
				<dd><code>{demoEmail}</code></dd>
				<dt class="font-medium">Password</dt>
				<dd><code>{demoPassword}</code></dd>
			</dl>
		</div>
	{/if}
</main>
