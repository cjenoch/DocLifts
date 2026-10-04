/** Account + program-local display choices. Never change a prescription. */
export type WorkoutLayout = 'guided' | 'table' | 'notebook' | 'tap';
export type FieldChoice = 'program' | 'show' | 'hide';
export const workoutLayouts = [
	['guided', 'Guided'],
	['table', 'Set table'],
	['notebook', 'Notebook'],
	['tap', 'Tap sets']
] as const;
export class WorkoutLayoutPreferences {
	layout = $state<WorkoutLayout>('table');
	rir = $state<FieldChoice>('program');
	notes = $state(false);
	history = $state(true);
	steppers = $state(false);
	storageAvailable = $state(true);
	private key = '';
	restore(userId: string, programId: string, quick: boolean) {
		const key = `doclifts:workout-layout:${userId}:${programId}`;
		if (this.key === key) return;
		this.key = key;
		this.layout = quick ? 'guided' : 'table';
		this.rir = 'program';
		this.notes = false;
		this.history = true;
		this.steppers = false;
		try {
			const value = JSON.parse(localStorage.getItem(key) ?? 'null');
			if (workoutLayouts.some(([layout]) => layout === value?.layout)) this.layout = value.layout;
			if (['program', 'show', 'hide'].includes(value?.rir)) this.rir = value.rir;
			for (const field of ['notes', 'history', 'steppers'] as const)
				if (typeof value?.[field] === 'boolean') this[field] = value[field];
			this.storageAvailable = true;
		} catch {
			this.storageAvailable = false;
		}
	}
	save() {
		if (!this.key) return;
		try {
			localStorage.setItem(
				this.key,
				JSON.stringify({
					layout: this.layout,
					rir: this.rir,
					notes: this.notes,
					history: this.history,
					steppers: this.steppers
				})
			);
			this.storageAvailable = true;
		} catch {
			this.storageAvailable = false;
		}
	}
}
