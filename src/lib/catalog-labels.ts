/**
 * Display labels for equipment models. Client-safe (no server imports), so
 * both the browse page and the detail page render the same words.
 */
export const LOADING_TYPE_LABELS: Record<string, string> = {
	'machine-stack': 'Selectorized (stack)',
	'machine-plate': 'Plate loaded',
	cable: 'Cable'
};
export const LATERALITY_LABELS: Record<string, string> = {
	bilateral: 'Bilateral',
	independent: 'Independent arms',
	not_applicable: 'n/a',
	unknown: 'Unknown'
};
export const BODY_REGION_LABELS: Record<string, string> = {
	chest: 'Chest',
	back: 'Back',
	shoulders: 'Shoulders',
	arms: 'Arms',
	legs: 'Legs',
	glutes: 'Glutes',
	core: 'Core',
	full_body: 'Full body',
	cable: 'Cable station'
};

export type Badge = { label: string; tone: 'verified' | 'unverified' | 'yours' };

/**
 * The confidence badge. `inferred` and `line_only` are "unverified" — check the
 * placard before trusting them. A row the viewer owns is "yours" whatever its
 * confidence says, because it is their data, not the catalog's.
 */
export function confidenceBadge(
	model: { confidence: string; ownerUserId: string | null },
	viewerId: string
): Badge {
	if (model.ownerUserId === viewerId) return { label: 'yours', tone: 'yours' };
	switch (model.confidence) {
		case 'manufacturer_page':
			return { label: 'manufacturer', tone: 'verified' };
		case 'reseller_or_manual':
			return { label: 'reseller / manual', tone: 'verified' };
		case 'user':
			return { label: 'user entered', tone: 'unverified' };
		default:
			return { label: 'unverified', tone: 'unverified' };
	}
}

export function resistanceLabel(model: {
	startingResistance: number | null;
	startingResistanceBasis: string | null;
}): string {
	if (model.startingResistance == null) return '—';
	const basis =
		model.startingResistanceBasis === 'per_arm'
			? ' per arm'
			: model.startingResistanceBasis === 'total'
				? ' total'
				: '';
	return `${model.startingResistance} lb${basis}`;
}

/** Only real web links become anchors; "reseller spec" stays text. */
export const isHttpUrl = (v: string | null): v is string => !!v && /^https?:\/\//.test(v);
