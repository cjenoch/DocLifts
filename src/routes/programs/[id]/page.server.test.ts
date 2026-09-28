import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { eq, isNotNull, isNull } from 'drizzle-orm';
import { setupTestDb, resetTestDb, type TestDb } from '$lib/server/test-db';
import { endSession, startSessionForDay } from '$lib/server/sessions';

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

import { actions } from './+page.server';
import * as s from '$lib/server/db/schema';

let harness: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
	harness = await setupTestDb();
	testDb.db = harness.db;
});
beforeEach(async () => {
	await resetTestDb(harness.client);
});
afterAll(async () => {
	await harness?.end();
});

type ActionEvent = Parameters<(typeof actions)['deleteSession']>[0];
const post = (id: string, form: Record<string, string>): ActionEvent => {
	const fd = new FormData();
	for (const [k, v] of Object.entries(form)) fd.append(k, v);
	return {
		request: new Request('http://test.local/', { method: 'POST', body: fd }),
		params: { id }
	} as unknown as ActionEvent;
};

async function endedSession() {
	const db = testDb.db!;
	const [program] = await db.insert(s.programs).values({ name: 'P' }).returning();
	const [day] = await db
		.insert(s.days)
		.values({ programId: program.id, name: 'D', position: 1 })
		.returning();
	const started = await startSessionForDay(db, day.id);
	if (!started.ok) throw new Error(started.message);
	await endSession(db, started.sessionId);
	return { programId: program.id, sessionId: started.sessionId };
}

async function deletedAtOf(sessionId: string) {
	const [row] = await testDb.db!.select().from(s.sessions).where(eq(s.sessions.id, sessionId));
	return row?.deletedAt ?? null;
}

it('deleteSession rejects a malformed program id with 400', async () => {
	const result = await actions.deleteSession(post('nope', { sessionId: randomUUID() }));
	expect(result).toMatchObject({ status: 400, data: { message: 'Invalid program id' } });
});

it('deleteSession rejects a malformed session id with 400', async () => {
	const { programId } = await endedSession();
	const result = await actions.deleteSession(post(programId, { sessionId: 'bad' }));
	expect(result).toMatchObject({ status: 400 });
});

it('deleteSession returns 404 for a session that does not exist', async () => {
	const { programId } = await endedSession();
	const result = await actions.deleteSession(post(programId, { sessionId: randomUUID() }));
	expect(result).toMatchObject({ status: 404 });
});

it('deleteSession soft-deletes an ended session', async () => {
	const { programId, sessionId } = await endedSession();
	const result = await actions.deleteSession(post(programId, { sessionId }));
	expect(result).toEqual({ ok: true });
	expect(await deletedAtOf(sessionId)).not.toBeNull();
});

it('restoreSession rejects a malformed program id with 400', async () => {
	const result = await actions.restoreSession(post('nope', { sessionId: randomUUID() }));
	expect(result).toMatchObject({ status: 400, data: { message: 'Invalid program id' } });
});

it('restoreSession restores a trashed session', async () => {
	const { programId, sessionId } = await endedSession();
	await actions.deleteSession(post(programId, { sessionId }));
	const result = await actions.restoreSession(post(programId, { sessionId }));
	expect(result).toEqual({ ok: true });
	expect(await deletedAtOf(sessionId)).toBeNull();
});

it('restoreSession returns 404 for a session that is not in trash', async () => {
	const { programId, sessionId } = await endedSession();
	const result = await actions.restoreSession(post(programId, { sessionId }));
	expect(result).toMatchObject({ status: 404 });
});

it('permanentDeleteSession requires the typed confirmation', async () => {
	const { programId, sessionId } = await endedSession();
	await actions.deleteSession(post(programId, { sessionId }));
	const result = await actions.permanentDeleteSession(post(programId, { sessionId }));
	expect(result).toMatchObject({ status: 400 });
	expect(await deletedAtOf(sessionId)).not.toBeNull();
});

it('permanentDeleteSession hard-deletes a trashed session', async () => {
	const { programId, sessionId } = await endedSession();
	await actions.deleteSession(post(programId, { sessionId }));
	const result = await actions.permanentDeleteSession(
		post(programId, { sessionId, confirmDelete: 'd' })
	);
	expect(result).toEqual({ ok: true });
	const rows = await testDb.db!.select().from(s.sessions).where(eq(s.sessions.id, sessionId));
	expect(rows).toHaveLength(0);
});

it('purgeTrash rejects a malformed program id with 400', async () => {
	const result = await actions.purgeTrash(
		post('nope', { confirmPurge: 'PURGE', expectedCount: '0' })
	);
	expect(result).toMatchObject({ status: 400, data: { message: 'Invalid program id' } });
});

it('purgeTrash returns 409 when the trash count changed', async () => {
	const { programId, sessionId } = await endedSession();
	await actions.deleteSession(post(programId, { sessionId }));
	const result = await actions.purgeTrash(
		post(programId, { confirmPurge: 'PURGE', expectedCount: '2' })
	);
	expect(result).toMatchObject({ status: 409 });
	// Nothing purged on a count mismatch.
	expect(await deletedAtOf(sessionId)).not.toBeNull();
});

it('purgeTrash empties the trash when the count matches', async () => {
	const { programId, sessionId } = await endedSession();
	await actions.deleteSession(post(programId, { sessionId }));
	const result = await actions.purgeTrash(
		post(programId, { confirmPurge: 'PURGE', expectedCount: '1' })
	);
	expect(result).toMatchObject({ ok: true, purged: 1 });
	const remaining = await testDb.db!
		.select()
		.from(s.sessions)
		.where(isNotNull(s.sessions.deletedAt));
	expect(remaining).toHaveLength(0);
	const active = await testDb.db!
		.select()
		.from(s.sessions)
		.where(isNull(s.sessions.deletedAt));
	expect(active).toHaveLength(0);
});
