export type ImportedSet = {
	load: number;
	reps: number;
	evidence: 'explicit' | 'user_authorized_estimate';
};
export type ImportedLine = {
	sourceLine: number;
	text: string;
	sets: ImportedSet[];
	loadConvention: string;
	interpretationNote: string | null;
};
