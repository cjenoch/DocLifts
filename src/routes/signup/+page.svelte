<script lang="ts">
	import PasswordInput from '$lib/PasswordInput.svelte';
	import type { PageData, ActionData } from './$types';
	let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<svelte:head><title>Create an account · DocLifts</title></svelte:head>
<main class="mx-auto max-w-sm px-4 py-10">
	<p class="text-3xl font-semibold tracking-tight">DocLifts</p>
	<h1 class="mt-6 text-2xl font-semibold">Create an account</h1>
	{#if !data.enabled}
		<p class="my-6 text-zinc-400">New accounts are paused. Existing members can still sign in.</p>
	{:else if form?.message}
		<p class="my-6 rounded border border-zinc-700 p-4" role="status">{form.message}</p>
		<a class="inline-flex min-h-11 items-center underline" href="/verify"
			>Resend verification email</a
		>
	{:else}
		<p class="my-4 text-zinc-400">
			Join the pilot with your invite code. Verify your email and you’re ready to lift.
		</p>
		{#if form?.error}<p class="my-4 text-red-300" role="alert">{form.error}</p>{/if}
		<form method="POST" class="space-y-4">
			<label class="block"
				>Name<input
					class="mt-1 min-h-11 w-full rounded border px-3 py-2"
					name="name"
					autocomplete="name"
					maxlength="120"
					required
				/></label
			>
			<label class="block"
				>Email<input
					class="mt-1 min-h-11 w-full rounded border px-3 py-2"
					name="email"
					type="email"
					autocomplete="username"
					autocapitalize="none"
					spellcheck="false"
					maxlength="320"
					required
				/></label
			>
			<label class="block"
				>Invite code<input
					class="mt-1 min-h-11 w-full rounded border px-3 py-2"
					name="inviteCode"
					autocomplete="off"
					autocapitalize="none"
					spellcheck="false"
					maxlength="256"
					required
				/></label
			>
			<PasswordInput
				id="password"
				name="password"
				label="Password"
				autocomplete="new-password"
				minlength={data.minimum}
				maxlength={128}
				required
			/>
			<p class="text-sm text-zinc-400">
				At least {data.minimum} characters. A password manager works well.
			</p>
			<PasswordInput
				id="confirmation"
				name="confirmation"
				label="Confirm password"
				autocomplete="new-password"
				minlength={data.minimum}
				maxlength={128}
				required
			/>
			<div class="hidden" aria-hidden="true">
				<label>Website<input name="website" tabindex="-1" autocomplete="off" /></label>
			</div>
			<label class="flex min-h-11 items-start gap-3 py-2"
				><input class="mt-1" type="checkbox" name="consent" value="yes" required /><span
					class="text-sm text-zinc-300"
					>I understand DocLifts is a test system, changes often, and may be unavailable during
					updates.</span
				></label
			>
			<p class="text-sm text-zinc-400">
				Machine-photo AI has usage limits. You can keep recording your workout when AI is
				unavailable. Your photos are not used in test datasets without your permission.
			</p>
			<button class="min-h-11 w-full rounded bg-indigo-600 px-4 py-3 font-semibold" type="submit"
				>Create account</button
			>
		</form>
	{/if}
	<a class="mt-6 inline-flex min-h-11 items-center underline" href="/login"
		>Already have an account? Sign in</a
	>
</main>
