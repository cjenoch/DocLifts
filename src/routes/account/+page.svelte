<script lang="ts">
	import type { PageData, ActionData } from './$types';
	import PasswordInput from '$lib/PasswordInput.svelte';
	import { pageTitle } from '$lib/app-shell';

	let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<svelte:head><title>{pageTitle('Account')}</title></svelte:head>

<main class="mx-auto max-w-sm px-4 py-6">
	<h1 class="mb-6 text-2xl font-semibold">Account</h1>
	{#if data.photoRemoved}<p role="status" class="mb-4 text-emerald-300">
			Saved photo removed. Your lifting records are unchanged.
		</p>{/if}
	<p class="text-sm text-zinc-400">Signed in as</p>
	<p class="mb-6 font-medium break-all text-zinc-100" data-testid="account-email">{data.email}</p>

	<section
		class="mb-6 rounded-xl border border-zinc-700 bg-zinc-900 p-4"
		aria-labelledby="view-heading"
	>
		<h2 id="view-heading" class="font-semibold">Your workout view</h2>
		<p class="mt-2 text-sm text-zinc-300">
			Inside a workout, use View to choose Guided, Set table, Notebook or Tap sets.
		</p>
		<p class="mt-2 text-sm text-zinc-400">
			Customize chooses RIR, notes and previous performance. Edit workout exposes exercise and set
			controls. The clock opens optional timer alerts. These choices do not change your workouts or
			progression.
		</p>
		<p class="mt-2 text-sm text-zinc-400">
			Workout preferences are remembered for your account and program in this browser. Choose
			separately on each device.
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
	<a
		href="/privacy"
		class="mb-3 flex min-h-11 items-center justify-center rounded border border-zinc-700 px-4"
		>Privacy and your data</a
	>
	<section
		class="my-6 space-y-3 rounded-xl border border-red-900 p-4"
		aria-labelledby="delete-account"
	>
		<h2 id="delete-account" class="font-semibold">Delete your account</h2>
		<p class="text-sm text-zinc-300">
			Permanently remove your account, workout and imported history, notes, programs, gyms and saved
			photos. This cannot be undone. Your sessions and connected agents lose access as soon as the
			request is accepted.
		</p>
		<p class="text-sm text-zinc-400">
			Removal may remain pending while private objects are cleaned up. Backup copies expire
			separately. Provider copies and data already copied by agents cannot be recalled. Complete
			data export is not yet available.
		</p>
		{#if form?.error}<p role="alert" class="text-amber-300">{form.error}</p>{/if}
		{#if data.deletionEnabled}
			<form method="POST" action="?/deleteAccount" class="space-y-3">
				<PasswordInput
					id="deletion-password"
					label="Current password"
					name="password"
					autocomplete="current-password"
					required
					maxlength={128}
				/>
				<label class="block"
					>Type DELETE to confirm<input
						name="confirmation"
						autocomplete="off"
						autocapitalize="characters"
						spellcheck="false"
						required
						class="mt-1 min-h-11 w-full rounded border border-zinc-600 bg-zinc-900 px-3"
					/></label
				>
				<label class="flex min-h-11 items-center gap-3"
					><input type="checkbox" name="understand" value="yes" required />I understand that my
					account and training history will be permanently removed.</label
				>
				<button class="min-h-11 w-full rounded border border-red-700 px-3 text-red-300"
					>Delete my account permanently</button
				>
			</form>
		{:else}
			<p class="text-sm">
				Self-service removal is awaiting operational activation. Contact <a
					class="text-indigo-300 underline"
					href="mailto:support@runthe.ai">support@runthe.ai</a
				> to request deletion.
			</p>
		{/if}
	</section>

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
