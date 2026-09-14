<script lang="ts">
	import { enhance } from '$app/forms';
	let {
		action,
		label,
		sessionId,
		expectedCount,
		confirmation,
		confirmationField,
		confirmationValue,
		destructive = false
	}: {
		action: string;
		label: string;
		sessionId?: string;
		expectedCount?: number;
		confirmation?: string;
		confirmationField?: string;
		confirmationValue?: string;
		destructive?: boolean;
	} = $props();
	let busy = $state(false);
	let confirming = $state(false);
	let message = $state('');
</script>

<form
	method="POST"
	{action}
	use:enhance={({ formData, cancel }) => {
		if (busy || (confirmation && !confirming)) {
			cancel();
			return;
		}
		if (confirmationField && confirmationValue) formData.set(confirmationField, confirmationValue);
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
	{#if sessionId}<input type="hidden" name="sessionId" value={sessionId} />{/if}
	{#if expectedCount !== undefined}<input
			type="hidden"
			name="expectedCount"
			value={expectedCount}
		/>{/if}
	{#if confirmation && !confirming}
		<button type="button" class:destructive onclick={() => (confirming = true)}>{label}</button>
	{:else if confirmation}
		<div class="confirmation" role="group" aria-label="Confirm permanent deletion">
			<p>{confirmation}</p>
			<div class="actions">
				<button type="button" disabled={busy} onclick={() => (confirming = false)}>Cancel</button
				><button type="submit" class:destructive disabled={busy}
					>{busy ? 'Deleting…' : label}</button
				>
			</div>
		</div>
	{:else}
		<button type="submit" disabled={busy}>{busy ? 'Restoring…' : label}</button>
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
	p {
		color: #fda4af;
		font-size: 13px;
		margin-top: 8px;
	}
</style>
