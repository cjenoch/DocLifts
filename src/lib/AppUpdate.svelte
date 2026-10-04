<script lang="ts">
	import { onMount } from 'svelte';
	import { version } from '$app/environment';
	import { page, updated } from '$app/state';
	let foundUpdate = $state(false);
	let checking = $state(false),
		message = $state('');
	async function check() {
		if (checking) return;
		checking = true;
		message = '';
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 5000);
		try {
			const response = await fetch('/_app/version.json', {
				cache: 'no-store',
				signal: controller.signal
			});
			if (!response.ok) throw new Error('Version check failed');
			const data = await response.json();
			if (typeof data.version !== 'string' || !data.version)
				throw new Error('Invalid build identity');
			foundUpdate = data.version !== version;
			if (!foundUpdate) message = 'This tab has the current build.';
		} catch {
			message = 'Could not check for updates. Try again when connected.';
		} finally {
			clearTimeout(timeout);
			checking = false;
		}
	}
	onMount(() => {
		const visible = () => {
			if (document.visibilityState === 'visible') void check();
		};
		void check();
		window.addEventListener('focus', visible);
		document.addEventListener('visibilitychange', visible);
		return () => {
			window.removeEventListener('focus', visible);
			document.removeEventListener('visibilitychange', visible);
		};
	});
</script>

{#if updated.current || foundUpdate}
	<aside class="update-notice" aria-label="App update" role="status">
		<p><strong>Update available.</strong> Save any entries, then refresh to load it.</p>
		<button type="button" onclick={() => window.location.reload()}>Refresh app</button>
	</aside>
{:else if page.url.pathname === '/account'}
	<div class="update-check">
		<button type="button" disabled={checking} onclick={check}
			>{checking ? 'Checking…' : 'Check for updates'}</button
		>
		{#if message}<p role="status">{message}</p>{/if}
	</div>
{/if}

<style>
	.update-notice,
	.update-check {
		max-width: 480px;
		margin: 8px auto;
		padding: 12px 16px;
		font-size: 13px;
		color: #d4d4d8;
	}
	.update-notice {
		background: #17251d;
		border: 1px solid #385c45;
		border-radius: 12px;
	}
	button {
		min-height: 44px;
		padding: 8px 12px;
		border: 1px solid #526359;
		border-radius: 8px;
		margin-top: 8px;
		font-weight: 600;
	}
	p {
		line-height: 1.5;
	}
	button:disabled {
		opacity: 0.6;
	}
</style>
