import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { setupTestDb, resetTestDbWithUsers, withTwoUsers, type TestDb } from '$lib/server/test-db';

const testDb = vi.hoisted(() => ({ db: null as TestDb | null }));
vi.mock('$lib/server/db', async () => {
	const schema = await import('$lib/server/db/schema');
	return {
		get db() {
			return testDb.db;
		},
		...schema
	};
});

import { POST } from './+server';
import { authUsers } from '$lib/server/db/schema';

// How this is used on a phone: the root layout posts the browser's zone here
// once, when it differs from the stored one. The CSRF rule for form-encoded
// POSTs is csrfBoundary's (hooks), covered by its own tests and the e2e.

let harness: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
	harness = await setupTestDb();
	testDb.db = harness.db;
});
beforeEach(async () => {
	await resetTestDbWithUsers(harness.db, harness.client, 0);
});
afterAll(async () => {
	await harness?.end();
});

type Event = Parameters<typeof POST>[0];
const post = (userId: string, body: BodyInit, type?: string) =>
	POST({
		request: new Request('http://test.local/account/time-zone', {
			method: 'POST',
			body,
			headers: type ? { 'content-type': type } : undefined
		}),
		locals: { user: { id: userId } } as App.Locals
	} as unknown as Event);

const stored = async (id: string) =>
	(
		await testDb.db!.select({ tz: authUsers.timeZone }).from(authUsers).where(eq(authUsers.id, id))
	)[0].tz;

it("stores the caller's zone and no one else's", async () => {
	const { alice, bob } = await withTwoUsers(testDb.db!);
	const ok = await post(alice, new URLSearchParams({ timeZone: 'America/Detroit' }));
	expect(ok.status).toBe(204);
	expect(await stored(alice)).toBe('America/Detroit');
	expect(await stored(bob)).toBeNull();
});

it('refuses an invalid zone with 400 and stores nothing', async () => {
	const { alice } = await withTwoUsers(testDb.db!);
	const refused = await post(alice, new URLSearchParams({ timeZone: 'Nowhere/Atlantis' }));
	expect(refused.status).toBe(400);
	expect(await stored(alice)).toBeNull();
	const missing = await post(alice, new URLSearchParams({}));
	expect(missing.status).toBe(400);
	expect(await stored(alice)).toBeNull();
});

it('refuses a body outside the form encodings the CSRF rule covers', async () => {
	const { alice } = await withTwoUsers(testDb.db!);
	const refused = await post(
		alice,
		JSON.stringify({ timeZone: 'America/Detroit' }),
		'application/json'
	);
	expect(refused.status).toBe(415);
	expect(await stored(alice)).toBeNull();
});
