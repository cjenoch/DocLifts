import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { isHttpError } from '@sveltejs/kit';
import { setupTestDb, resetTestDb, type TestDb } from '$lib/server/test-db';
import { load } from './+page.server';
import type { PageServerLoad } from './$types';

const testDb = vi.hoisted(() => ({ db: null as TestDb | null }));
vi.mock('$lib/server/db', () => ({
	get db() {
		return testDb.db;
	}
}));

let harness: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
	harness = await setupTestDb();
	testDb.db = harness.db;
});
beforeEach(async () => {
	await resetTestDb(harness.client);
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
	await harness?.end();
});

const event = (id: string) => ({ params: { id } }) as Parameters<PageServerLoad>[0];

it('returns HTTP 404 for a valid UUID absent from an empty database', async () => {
	const result = await Promise.resolve(load(event(randomUUID()))).catch((cause: unknown) => cause);
	expect(isHttpError(result, 404)).toBe(true);
	expect(result).toMatchObject({ body: { message: 'Program not found' } });
});

it.each(['Database connection failed', 'Program not found'])(
	'does not disguise database failures as HTTP 404: %s',
	async (message) => {
		const failure = new Error(message);
		const select = harness.db.select.bind(harness.db);
		vi.spyOn(harness.db, 'select')
			.mockImplementationOnce(select) // Let the library query succeed; fail the program lookup.
			.mockImplementation(() => {
				throw failure;
			});
		await expect(load(event(randomUUID()))).rejects.toBe(failure);
	}
);

it('keeps malformed program identifiers as HTTP 400', async () => {
	const result = await Promise.resolve(load(event('bad'))).catch((cause: unknown) => cause);
	expect(isHttpError(result, 400)).toBe(true);
});
