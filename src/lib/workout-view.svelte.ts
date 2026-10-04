/** Display preference only: never changes prescriptions, progression or saved sets. */
export type WorkoutViewMode = 'simple' | 'advanced';
export const WORKOUT_VIEW = Symbol('workout-view');
export const viewStorageKey = (userId: string) => `doclifts:view:${userId}`;

/** One instance per layout, never shared between server requests or accounts. */
export class WorkoutView {
	mode = $state<WorkoutViewMode>('simple');
	storageAvailable = $state(true);
	private key: string | null | undefined;

	restore(userId: string | null) {
		const key = userId ? viewStorageKey(userId) : null;
		if (key === this.key) return;
		this.key = key;
		this.mode = 'simple';
		this.storageAvailable = true;
		if (!key) return;
		try {
			if (localStorage.getItem(key) === 'advanced') this.mode = 'advanced';
		} catch {
			this.storageAvailable = false;
		}
	}

	choose(mode: WorkoutViewMode) {
		this.mode = mode;
		if (!this.key) return;
		try {
			localStorage.setItem(this.key, mode);
			this.storageAvailable = true;
		} catch {
			this.storageAvailable = false;
		}
	}
}
