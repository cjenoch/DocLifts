<script lang="ts">
	import type { ActionData } from './$types';
	import PasswordInput from '$lib/PasswordInput.svelte';
	import BuildVersion from '$lib/BuildVersion.svelte';
	import { appShell } from '$lib/app-shell';

	let { form, data }: { form: ActionData; data: { next?: string } } = $props();

	const seconds = (n: number) => `${n} second${n === 1 ? '' : 's'}`;

	/**
	 * The throttle's wait, stated (spec item 4: never a silent wait). Kept
	 * apart from the error: "do not match" says what was wrong with the
	 * attempt, this says why the submit hung and that the next one will too.
	 * Rendered on the server, so it reads the same without JavaScript.
	 */
	const waitNotice = $derived.by(() => {
		const held = form?.heldSeconds ?? null;
		const next = form?.nextDelaySeconds ?? null;
		if (held === null && next === null) return null;
		return [
			'Several sign-in attempts have failed recently, so each new attempt is held before your password is checked.',
			held !== null ? `This one was held for ${seconds(held)}.` : null,
			next !== null ? `The next will be held for ${seconds(next)}.` : null
		]
			.filter(Boolean)
			.join(' ');
	});

	/**
	 * The countdown while a held attempt is in flight. A plain form POST keeps
	 * this document — and this script — alive until the response arrives, so
	 * counting down from the announced wait needs no `use:enhance` and changes
	 * nothing about how the form submits. Without JavaScript the notice above
	 * already said how long; this only makes the hang visibly a wait.
	 *
	 * Bundled code (no inline handler), so it runs under the nonce'd CSP.
	 */
	let checkingIn = $state<number | null>(null);
	let tick: ReturnType<typeof setInterval> | undefined;

	function startCountdown() {
		const next = form?.nextDelaySeconds ?? null;
		if (next === null) return;
		clearInterval(tick);
		checkingIn = next;
		tick = setInterval(() => {
			checkingIn = Math.max(0, (checkingIn ?? 0) - 1);
			if (checkingIn === 0) clearInterval(tick);
		}, 1000);
	}

	// A page restored from the back/forward cache must not resume a stale count.
	function resetCountdown() {
		clearInterval(tick);
		checkingIn = null;
	}

	$effect(() => () => clearInterval(tick));
</script>

<svelte:window onpageshow={resetCountdown} />

<svelte:head><title>Sign in · DocLifts</title></svelte:head>

<main class="mx-auto max-w-sm px-4 py-16">
	<!-- What this is, in one line (0.5.5). No sign-up link while sign-up is closed. -->
	<h1 class="text-3xl font-semibold tracking-tight text-zinc-100">{appShell.signInHeadline}</h1>
	<p class="mt-2 text-sm font-medium text-zinc-400">{appShell.appName}<BuildVersion /></p>
	<p class="mt-2 mb-8 text-zinc-400" data-testid="tagline">{appShell.tagline}</p>
	<h2 class="mb-6 text-2xl font-semibold">Sign in</h2>

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

	{#if waitNotice}
		<p
			class="mb-4 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
			role="status"
			id="login-wait-notice"
		>
			{waitNotice}
			{#if checkingIn !== null}
				<span class="mt-1 block font-medium">
					{checkingIn > 0
						? `Held: your password will be checked in ${seconds(checkingIn)}.`
						: 'Checking your password…'}
				</span>
			{/if}
		</p>
	{/if}

	<form method="POST" class="space-y-4" onsubmit={startCountdown}>
		<input type="hidden" name="next" value={data.next ?? '/'} />
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
</main>
