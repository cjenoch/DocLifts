import { describe, expect, it } from 'vitest';
import { confidenceBadge, defaultMachineLabel, isHttpUrl, resistanceLabel } from './catalog-labels';

describe('confidenceBadge', () => {
	const global = (confidence: string) => ({ confidence, ownerUserId: null });
	it('inferred and line_only render as unverified', () => {
		expect(confidenceBadge(global('inferred'), 'u').label).toBe('unverified');
		expect(confidenceBadge(global('line_only'), 'u').label).toBe('unverified');
	});
	it("the viewer's own row renders as yours", () => {
		expect(confidenceBadge({ confidence: 'user', ownerUserId: 'u' }, 'u').label).toBe('yours');
	});
	it('catalog-read rows are not unverified', () => {
		expect(confidenceBadge(global('manufacturer_page'), 'u').tone).toBe('verified');
		expect(confidenceBadge(global('reseller_or_manual'), 'u').tone).toBe('verified');
	});
});

it('resistanceLabel states the basis', () => {
	expect(resistanceLabel({ startingResistance: 12, startingResistanceBasis: 'per_arm' })).toBe(
		'12 lb per arm'
	);
	expect(resistanceLabel({ startingResistance: null, startingResistanceBasis: null })).toBe('—');
});

it('isHttpUrl links only web URLs', () => {
	expect(isHttpUrl('https://gym80.de/en/all-products/')).toBe(true);
	expect(isHttpUrl('reseller spec')).toBe(false);
	expect(isHttpUrl(null)).toBe(false);
});

describe('defaultMachineLabel', () => {
	it('is manufacturer and name, plus the code when there is one', () => {
		expect(
			defaultMachineLabel({
				manufacturer: 'Hammer Strength',
				name: 'Iso-Lateral Row',
				code: 'IL-ROW'
			})
		).toBe('Hammer Strength Iso-Lateral Row (IL-ROW)');
		expect(
			defaultMachineLabel({ manufacturer: 'Nautilus', name: 'Leverage Row', code: null })
		).toBe('Nautilus Leverage Row');
		expect(defaultMachineLabel({ manufacturer: 'Nautilus', name: 'Leverage Row', code: ' ' })).toBe(
			'Nautilus Leverage Row'
		);
	});
	it('never exceeds the 120-character label limit', () => {
		expect(defaultMachineLabel({ manufacturer: 'M', name: 'x'.repeat(200) })).toHaveLength(120);
	});
});
