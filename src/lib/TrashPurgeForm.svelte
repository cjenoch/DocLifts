<script lang="ts">
	import { enhance } from '$app/forms';

	// Typed-confirmation purge form. The user must TYPE "PURGE" into the input
	// before the submit button enables — the single-keystroke reveal of the
	// old TrashAction was judged too weak for an irreversible bulk delete
	// (owner decision + audit finding, 2026-09-26). The server-side Zod
	// literal on confirmPurge stays authoritative; this is the UX half.
	let {
		action,
		expectedCount,
		confirmation
	}: {
		action: string;
		expectedCount: number;
		confirmation: string;
	} = $props();

	let busy = $state(false);
	let confirming = $state(false);
	let typed = $state('');
	let message = $state('');
</script>

<form
	method="POST"
	{action}
	use:enhance={({ formData, cancel }) => {
		if (busy || !confirming || typed !== 'PURGE') {
			cancel();
			return;
		}
		formData.set('confirmPurge', typed);
		busy = true;
		message = '';
		return async ({ result, update }) => {
			try {
				if (result.type === 'success') await update({ reset: false });
				else
					message =
						result.type === 'failure'
							? String(result.data?.message ?? 'Please try again.')
							: 'Could not complete that action. Please try again.';
			} finally {
				busy = false;
			}
		};
	}}
>
	<input type="hidden" name="expectedCount" value={expectedCount} />
	{#if !confirming}
		<button type="button" class="destructive" onclick={() => (confirming = true)}
			>Empty Trash ({expectedCount})</button
		>
	{:else}
		<div class="confirmation" role="group" aria-label="Confirm permanent purge">
			<p>{confirmation}</p>
			<input
				type="text"
				bind:value={typed}
				placeholder="Type PURGE"
				autocomplete="off"
				spellcheck="false"
				aria-label="Type PURGE to confirm"
				disabled={busy}
			/>
			<div class="actions">
				<button type="button" disabled={busy} onclick={() => (confirming = false)}>Cancel</button
				><button type="submit" class="destructive" disabled={busy || typed !== 'PURGE'}
					>{busy ? 'Purging…' : 'Permanently delete'}</button
				>
			</div>
		</div>
	{/if}
	{#if message}<p role="alert">{message}</p>{/if}
</form>

<style>
	.confirmation {
		padding: 12px;
		border: 1px solid #66404c;
		border-radius: 10px;
		max-width: 420px;
	}
	.confirmation p {
		margin: 0 0 12px;
		color: #e2e8f0;
		line-height: 1.5;
	}
	.confirmation input {
		width: 100%;
		min-height: 44px;
		margin-bottom: 12px;
		padding: 10px 12px;
		border: 1px solid #66404c;
		border-radius: 9px;
		background: transparent;
		color: #fda4af;
		font-size: 14px;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}
	button {
		min-height: 44px;
		padding: 10px 16px;
		border-radius: 9px;
		background: #c7d2fe;
		color: #172044;
		font-size: 14px;
		font-weight: 600;
		cursor: pointer;
	}
	button.destructive {
		background: transparent;
		border: 1px solid #66404c;
		color: #fda4af;
	}
	button:disabled {
		opacity: 0.6;
		cursor: wait;
	}
</style>
