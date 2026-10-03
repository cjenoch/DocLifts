<script lang="ts">
	import type { PageData } from './$types';
	import { pageTitle } from '$lib/app-shell';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head><title>{pageTitle('Account')}</title></svelte:head>

<main class="mx-auto max-w-sm px-4 py-6">
	<h1 class="mb-6 text-2xl font-semibold">Account</h1>
	<p class="text-sm text-zinc-400">Signed in as</p>
	<p class="mb-6 font-medium break-all text-zinc-100" data-testid="account-email">{data.email}</p>

	<a
		href="/exercises"
		class="mb-3 flex min-h-11 items-center justify-center rounded-lg border border-zinc-700 bg-zinc-900 px-4 font-semibold text-zinc-200 active:bg-zinc-800"
		>Exercises</a
	>
	<a
		href="/account/password"
		class="mb-3 flex min-h-11 items-center justify-center rounded-lg border border-zinc-700 bg-zinc-900 px-4 font-semibold text-zinc-200 active:bg-zinc-800"
		>Change password</a
	>

	<!--
		Sign out. A <form method="POST" action="/logout"> and not an <a href>:
		the route answers 405 to GET on purpose, so a link, a prefetch, or an
		<img> can never sign somebody out by merely being loaded. See
		src/routes/logout. (It once existed with no rendered control at all,
		found 2026-09-30; it moved here from the nav in 0.5.5.)
	-->
	<form method="POST" action="/logout">
		<button
			type="submit"
			class="flex min-h-11 w-full items-center justify-center rounded-lg border border-red-900 px-4 font-semibold text-red-300 active:bg-red-950"
			>Sign out</button
		>
	</form>
</main>
