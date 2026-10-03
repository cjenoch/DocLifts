<script lang="ts">
	import type { PageData, ActionData } from './$types';
	let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<svelte:head><title>Email verification · DocLifts</title></svelte:head>
<main class="mx-auto max-w-sm px-4 py-10">
	<h1 class="text-2xl font-semibold">Email verification</h1>
	<p class="my-4 text-zinc-300">
		{data.error
			? 'That verification link is invalid or expired. Request a new one below.'
			: 'If you just followed your verification link, you can now sign in. Otherwise, check your inbox or request a new link.'}
	</p>
	<a
		href="/login"
		class="inline-flex min-h-11 items-center rounded bg-indigo-600 px-4 py-2 font-semibold"
		>Sign in</a
	>
	{#if data.mailEnabled}
		<h2 class="mt-8 text-lg font-semibold">Resend verification email</h2>
		{#if form?.message}<p class="my-4" role="status">{form.message}</p>{/if}
		<form method="POST" class="mt-4 space-y-4">
			<label class="block"
				>Email<input
					class="mt-1 min-h-11 w-full rounded border px-3 py-2"
					type="email"
					name="email"
					autocomplete="username"
					autocapitalize="none"
					spellcheck="false"
					maxlength="320"
					required
				/></label
			>
			<button class="min-h-11 rounded border border-zinc-600 px-4 py-2" type="submit"
				>Send verification email</button
			>
		</form>
	{/if}
</main>
