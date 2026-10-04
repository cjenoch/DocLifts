import { beforeNavigate, invalidateAll } from '$app/navigation';
import { onMount } from 'svelte';
import { workoutUi } from '$lib/workout-ui';
import type { SubmitFunction } from '@sveltejs/kit';
type SetLike = {
	executedLoad: number | null;
	executedReps: number | null;
	executedRir: number | null;
	notes: string | null;
};
export const isLogged = (x: SetLike) =>
	x.executedLoad != null || x.executedReps != null || x.executedRir != null || !!x.notes;

/** Page-owned removal state; menus may disappear without cancelling pending work. */
export class WorkoutEdits {
	pendingRemove = $state<{ occurrenceId: string; name: string } | null>(null);
	private removeTimer: ReturnType<typeof setTimeout> | undefined;
	editError = $state('');
	constructor() {
		beforeNavigate(() => this.flushRemove(true));
		onMount(() => {
			const leave = () => this.flushRemove(true);
			window.addEventListener('pagehide', leave);
			return () => window.removeEventListener('pagehide', leave);
		});
	}
	private sendRemove = async (occurrenceId: string, keepalive = false) => {
		const body = new FormData();
		body.set('occurrenceId', occurrenceId);
		const response = await fetch('?/removeExercise', {
			method: 'POST',
			body,
			keepalive,
			headers: { 'x-sveltekit-action': 'true' }
		}).catch(() => null);
		const result = response ? await response.json().catch(() => null) : null;
		if (!keepalive) {
			if (result?.type !== 'success')
				this.editError = 'Could not remove that exercise. Please reload.';
			await invalidateAll();
		}
	};
	flushRemove = (keepalive = false) => {
		clearTimeout(this.removeTimer);
		const pending = this.pendingRemove;
		this.pendingRemove = null;
		if (pending) void this.sendRemove(pending.occurrenceId, keepalive);
	};
	startRemove = (occurrenceId: string, name: string) => {
		this.flushRemove();
		this.editError = '';
		this.pendingRemove = { occurrenceId, name };
		this.removeTimer = setTimeout(() => this.flushRemove(), workoutUi.undoSeconds * 1000);
	};
	undoRemove = () => {
		clearTimeout(this.removeTimer);
		this.pendingRemove = null;
	};
	editSubmit: SubmitFunction = ({ cancel, formData, formElement }) => {
		// The menu closes on any choice, as it would on a phone's action sheet.
		const details = formElement.closest('details');
		if (details) details.open = false;
		const count = Number(formData.get('loggedCount') ?? 0);
		const name = String(formData.get('exerciseName') ?? '');
		if (count > 0 && !confirm(workoutUi.confirmRemoveLogged(name, count))) {
			cancel();
			return;
		}
		this.flushRemove();
		this.editError = '';
		return async ({ result, update }) => {
			if (result.type === 'failure') this.editError = String(result.data?.message ?? '');
			await update({ reset: false });
		};
	};
}
