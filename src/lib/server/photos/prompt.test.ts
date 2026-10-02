import { describe, expect, it } from 'vitest';
import { SYSTEM_PROMPT } from './analyze';

/**
 * The photo prompt's rules are owner-approved text: a rule is changed by the
 * owner after testing on real photos, never reworded in passing.
 */
describe('SYSTEM_PROMPT', () => {
	const RULE_3A =
		'3a. If any character of the model code is unclear, too small, blurred or partly hidden, return null for model_code and give it confidence 0. Write the characters you could make out in notes. A wrong code is worse than no code.';

	it('carries rule 3a verbatim, immediately after rule 3 (0.5.1)', () => {
		// On the owner's photos: wrong codes 5 -> 1 in 30 scored reads, 15/15
		// correct codes kept (docs/photos.md).
		const lines = SYSTEM_PROMPT.split('\n');
		expect(lines).toContain(RULE_3A);
		const at = lines.indexOf(RULE_3A);
		expect(lines[at - 1]).toMatch(/^3\. Transcribe the model code character for character/);
		expect(lines[at + 1]).toMatch(/^4\. /);
	});

	it('keeps rules 1 to 8 in order', () => {
		const numbers = SYSTEM_PROMPT.split('\n')
			.map((l) => l.match(/^(\d+a?)\. /)?.[1])
			.filter(Boolean);
		expect(numbers).toEqual(['1', '2', '3', '3a', '4', '5', '6', '7', '8']);
	});
});
