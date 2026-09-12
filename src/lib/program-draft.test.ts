import { describe, expect, it } from 'vitest';
import {
	blankProgramDraft,
	blankSetDraft,
	MAX_PROGRAM_DRAFT_CHARS,
	MAX_PROGRAM_FORM_BYTES,
	programDraftSchema,
	programFormBytes
} from './program-draft';

const requestId = '22222222-2222-4222-8222-222222222222';
function notesDraft(note: string) {
	const draft = blankProgramDraft();
	draft.name = 'Transport test';
	draft.days[0].exercises[0].newExercise = {
		name: 'Press',
		equipmentType: 'dumbbell',
		isLowerBody: false
	};
	draft.days[0].exercises[0].sets = Array.from({ length: 13 }, () => ({
		...blankSetDraft(),
		notes: note
	}));
	return draft;
}

describe('programFormBytes', () => {
	it('counts exactly the two UTF-8 urlencoded hidden fields, including escaped request IDs', () => {
		const draft = notesDraft('ASCII + & = % /\n');
		const id = `${requestId}+&界`;
		const encoded = new URLSearchParams({
			payload: JSON.stringify(draft),
			requestId: id
		}).toString();
		expect(programFormBytes(draft, id)).toBe(Buffer.byteLength(encoded, 'utf8'));
		expect(programFormBytes(draft, id)).toBeLessThan(MAX_PROGRAM_FORM_BYTES);
	});

	it('distinguishes normal ASCII from Unicode expansion below the JSON character cap', () => {
		const ascii = notesDraft('x'.repeat(5000));
		const unicode = notesDraft('界'.repeat(5000));
		expect(programDraftSchema.safeParse(unicode).success).toBe(true);
		expect(JSON.stringify(unicode).length).toBe(JSON.stringify(ascii).length);
		expect(JSON.stringify(unicode).length).toBeLessThan(MAX_PROGRAM_DRAFT_CHARS);
		expect(programFormBytes(ascii, requestId)).toBeLessThan(MAX_PROGRAM_FORM_BYTES);
		expect(programFormBytes(unicode, requestId)).toBeGreaterThan(MAX_PROGRAM_FORM_BYTES);
	});

	it.each([-1, 0, 1])('counts the conservative form boundary at offset %i', (offset) => {
		expect(MAX_PROGRAM_FORM_BYTES).toBe(500_000);
		const draft = notesDraft('界'.repeat(4200));
		const encoded = new URLSearchParams({ payload: JSON.stringify(draft), requestId }).toString();
		let remaining = 500_000 + offset - Buffer.byteLength(encoded, 'utf8');
		expect(remaining).toBeGreaterThan(0);
		for (const set of draft.days[0].exercises[0].sets) {
			const count = Math.min(remaining, 5000 - set.notes!.length);
			set.notes += 'x'.repeat(count);
			remaining -= count;
		}
		expect(remaining).toBe(0);
		expect(programDraftSchema.safeParse(draft).success).toBe(true);
		expect(programFormBytes(draft, requestId)).toBe(500_000 + offset);
	});
});
