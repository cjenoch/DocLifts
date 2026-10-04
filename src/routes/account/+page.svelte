<script lang="ts">
	import { getContext } from 'svelte';
	import { WORKOUT_VIEW, type WorkoutView } from '$lib/workout-view.svelte';
	const view = getContext<WorkoutView>(WORKOUT_VIEW);
	import type { PageData } from './$types';
	import { pageTitle } from '$lib/app-shell';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head><title>{pageTitle('Account')}</title></svelte:head>

<main class="mx-auto max-w-sm px-4 py-6">
	<h1 class="mb-6 text-2xl font-semibold">Account</h1>
	<p class="text-sm text-zinc-400">Signed in as</p>
	<p class="mb-6 font-medium break-all text-zinc-100" data-testid="account-email">{data.email}</p>

	<section
		class="mb-6 rounded-xl border border-zinc-700 bg-zinc-900 p-4"
		aria-labelledby="view-heading"
	>
		<h2 id="view-heading" class="font-semibold">Your workout view</h2>
		<p class="mt-2 text-sm text-zinc-300">
			Use the Simple / Advanced switch at the top of any screen.
		</p>
		<p class="mt-2 text-sm text-zinc-400">
			Simple keeps weight, reps and Save up front. Advanced shows effort and program controls. Both
			views keep the same workouts and progression.
		</p>
		<p class="mt-2 text-sm text-zinc-400">
			{view.storageAvailable
				? 'Remembered for your account in this browser. Choose separately on each device.'
				: 'Browser storage is unavailable. Your choice lasts for this visit.'}
		</p>
	</section>
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

	<a
		href="/account/connections"
		class="mb-3 flex min-h-11 items-center justify-center rounded border border-zinc-700 px-4"
		>Connected agents</a
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
