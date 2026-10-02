/**
 * Every user-visible string for fixing the gym list (0.7.0, machines spec
 * Parts G, H and K), in one place. Pages and tests read them from here.
 */
export const machineAdminUi = {
	noModel: 'No model',
	archivedNote: 'This machine is removed. It still shows on past workouts.',
	// Part G
	removeMachine: 'Remove this machine',
	removeGym: 'Remove this gym',
	removeConfirm: 'Remove',
	machineDeleteText: 'This machine has no history. It will be deleted.',
	machineArchiveText: 'Your past workouts keep this machine. It will no longer appear in lists.',
	gymDeleteText: 'This gym has no history. It will be deleted.',
	gymArchiveText: 'Past workouts stay. The gym and its machines leave your lists.',
	finishFirst: 'An open workout uses this. Finish the workout first.',
	archived: 'Archived',
	restore: 'Restore',
	removed: (outcome: string) =>
		outcome === 'deleted'
			? 'Deleted.'
			: 'Removed. Past workouts keep it; restore it under Archived.',
	// Part H
	changeModel: 'Change model',
	changeModelIntro:
		'The machine keeps its history. Search for the model on its placard, by name or code.',
	searchPlaceholder: 'Model name or code',
	search: 'Search',
	modelChanged: 'Model changed. History stays with this machine.',
	stackOffer: (lb: number) => `Use the manufacturer's ${lb} lb stack?`,
	stackApplied: (lb: number | null | undefined) => `Stack set to ${lb ?? '—'} lb.`,
	replaceExplain: (label: string) =>
		`${label} records weight differently, so this machine cannot change to it. Replace it instead: suggestions start fresh on the new machine, and past workouts keep this one.`,
	replaceButton: 'Replace this machine',
	// Part K
	sameMachineAs: 'Same machine as…',
	sameMachineIntro: 'Two rows for one machine? Pick the other one to merge them.',
	mergeMoves: (sets: number, workouts: number, photos: number, from: string, to: string) =>
		`Moves ${sets} ${sets === 1 ? 'set' : 'sets'} from ${workouts} ${workouts === 1 ? 'workout' : 'workouts'}${from ? ` (${from === to ? from : `${from} to ${to}`})` : ''} and ${photos} ${photos === 1 ? 'photo' : 'photos'}.`,
	formatsDiffer:
		'The two machines have sets in different weight formats. Those histories stay separate after the merge.',
	keepWhich: 'Keep',
	mergeButton: 'Merge',
	mergedFrom: (label: string, date: string) => `${label} was merged into this machine on ${date}.`,
	undoMerge: 'Undo merge'
} as const;
