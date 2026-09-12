import { expect, it, vi } from 'vitest';
import { actions as createActions } from './new/+page.server';
import { actions as editActions } from './[id]/edit/+page.server';

vi.mock('$lib/server/db', () => ({ db: {} }));
vi.mock('$lib/server/program-builder', () => ({
	listProgramExercises: vi.fn(),
	loadProgramDraft: vi.fn(),
	saveProgramDraft: vi.fn()
}));

it.each([
	['create', createActions.default!],
	['edit', editActions.default!]
] as const)('maps %s body-read failures to bounded generic form errors', async (_, action) => {
	const request = new Request('http://localhost/programs/new', { method: 'POST' });
	vi.spyOn(request, 'formData').mockRejectedValue(new Error('untrusted body '.repeat(100_000)));
	const result = await action({
		request,
		params: { id: '11111111-1111-4111-8111-111111111111' }
	} as Parameters<typeof createActions.default>[0] & Parameters<typeof editActions.default>[0]);
	expect(result).toMatchObject({
		status: 400,
		data: { error: expect.stringMatching(/unable to read.*retry/i) }
	});
	expect(JSON.stringify(result).length).toBeLessThan(300);
	expect(JSON.stringify(result)).not.toContain('untrusted body');
	expect(result).not.toHaveProperty('data.draft');
	expect(result).not.toHaveProperty('data.requestId');
});
