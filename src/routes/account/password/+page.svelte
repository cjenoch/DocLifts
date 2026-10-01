<script lang="ts">
	import type { ActionData, PageData } from './$types';

	let { form, data }: { form: ActionData; data: PageData } = $props();
</script>

<svelte:head><title>Change password — DocLifts</title></svelte:head>

<main class="mx-auto max-w-sm px-4 py-10">
	<h1 class="mb-6 text-2xl font-semibold">Change password</h1>

	{#if data.changed && !form}
		<p
			class="mb-4 rounded border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-800"
			role="status"
		>
			Password changed. Every other device has been signed out; this one stays signed in.
		</p>
	{/if}

	{#if form?.error}
		<p
			class="mb-4 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800"
			role="alert"
			data-reason={form.reason}
		>
			{form.error}
		</p>
	{/if}

	<form method="POST" class="space-y-4">
		<label class="block">
			<span class="mb-1 block text-sm font-medium">Current password</span>
			<input
				name="currentPassword"
				type="password"
				autocomplete="current-password"
				required
				class="w-full rounded border border-neutral-300 px-3 py-2"
			/>
		</label>

		<label class="block">
			<span class="mb-1 block text-sm font-medium">New password</span>
			<input
				name="newPassword"
				type="password"
				autocomplete="new-password"
				minlength={data.minLength}
				required
				aria-describedby="new-password-hint"
				class="w-full rounded border border-neutral-300 px-3 py-2"
			/>
		</label>

		<label class="block">
			<span class="mb-1 block text-sm font-medium">New password again</span>
			<input
				name="confirmPassword"
				type="password"
				autocomplete="new-password"
				minlength={data.minLength}
				required
				class="w-full rounded border border-neutral-300 px-3 py-2"
			/>
		</label>

		<!--
			Length is the whole policy (spec §2 item 4): no symbol, digit or case
			rules. Saying so is part of the policy — otherwise people add a symbol
			"to be safe" and then cannot type it on a phone.
		-->
		<p id="new-password-hint" class="text-sm text-neutral-600">
			At least {data.minLength} characters. Any characters count; length is what matters.
		</p>

		<button type="submit" class="w-full rounded bg-neutral-900 px-3 py-2 font-medium text-white">
			Change password
		</button>
	</form>
</main>
