/**
 * Retired program versions are read-only (owner decision, 2026-11-08).
 *
 * How this is used on a phone: the owner opens an old version from History or
 * a bookmark between sets; it must not start a workout on the outdated
 * template, and a workout already open on it must still resume.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { createTestUser, resetTestDb, setupTestDb, withTwoUsers } from './test-db';
import * as s from './db/schema';
import { duplicateProgramForEditInTransaction } from './programs';
import { startSessionForDay } from './sessions';
import { currentProgramVersion, programVersionState } from './program-versions';
import { ensureQuickProgram } from './quick-workouts';
import { programUi } from '../program-ui';

let h: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
	h = await setupTestDb();
});
afterAll(async () => {
	await h?.end();
});
beforeEach(async () => {
	await resetTestDb(h.client);
});

async function program(userId: string, name = 'Push Pull') {
	const [p] = await h.db.insert(s.programs).values({ name, userId }).returning();
	const [d] = await h.db
		.insert(s.days)
		.values({ programId: p.id, name: 'Day A', position: 1 })
		.returning();
	return { programId: p.id, dayId: d.id };
}

/** An edit: deep copy, source marked inactive. Returns the new version's id. */
async function edit(userId: string, programId: string) {
	return h.db.transaction(async (tx) => {
		const copy = await duplicateProgramForEditInTransaction(tx, userId, programId);
		return copy.id;
	});
}

async function dayOf(programId: string) {
	const [d] = await h.db.select().from(s.days).where(eq(s.days.programId, programId));
	return d.id;
}

async function sessionCount(userId: string) {
	const [row] = await h.db
		.select({ n: sql<number>`count(*)::int` })
		.from(s.sessions)
		.where(eq(s.sessions.userId, userId));
	return row.n;
}

it('starts a workout on the active version, and refuses one on a retired version with no row written', async () => {
	const userId = await createTestUser(h.db, 'versions');
	const v1 = await program(userId);
	// Positive first: the active version starts.
	const first = await startSessionForDay(h.db, userId, v1.dayId);
	expect(first.ok).toBe(true);
	await h.db.update(s.sessions).set({ endedAt: new Date() }).where(eq(s.sessions.userId, userId));
	expect(await sessionCount(userId)).toBe(1);

	const v2 = await edit(userId, v1.programId);
	const refused = await startSessionForDay(h.db, userId, v1.dayId);
	expect(refused).toEqual({ ok: false, status: 409, message: programUi.startRefused });
	expect(await sessionCount(userId)).toBe(1);

	// The current version still starts.
	const onV2 = await startSessionForDay(h.db, userId, await dayOf(v2));
	expect(onV2.ok).toBe(true);
	expect(await sessionCount(userId)).toBe(2);
});

it('resumes a workout that was open on a version when it was replaced', async () => {
	const userId = await createTestUser(h.db, 'versions');
	const v1 = await program(userId);
	const open = await startSessionForDay(h.db, userId, v1.dayId);
	if (!open.ok) throw new Error(open.message);
	await edit(userId, v1.programId);
	expect((await programVersionState(h.db, userId, v1.programId))?.isActive).toBe(false);

	const again = await startSessionForDay(h.db, userId, v1.dayId);
	expect(again).toEqual({ ok: true, sessionId: open.sessionId });
	expect(await sessionCount(userId)).toBe(1);
});

it('refuses a start that races the edit retiring its version', async () => {
	// The edit holds its source FOR UPDATE until commit. A start that read the
	// version as active before that must still not create a session on it.
	const userId = await createTestUser(h.db, 'versions');
	const v1 = await program(userId);
	let racing: ReturnType<typeof startSessionForDay> | undefined;
	await h.db.transaction(async (tx) => {
		await duplicateProgramForEditInTransaction(tx, userId, v1.programId);
		racing = startSessionForDay(h.db, userId, v1.dayId);
		// Let the start reach its lock wait before the edit commits.
		await new Promise((resolve) => setTimeout(resolve, 300));
	});
	expect(await racing).toEqual({ ok: false, status: 409, message: programUi.startRefused });
	expect(await sessionCount(userId)).toBe(0);
});

it('keeps the quick-workout program startable', async () => {
	const userId = await createTestUser(h.db, 'versions');
	const { dayId } = await ensureQuickProgram(h.db, userId);
	const started = await startSessionForDay(h.db, userId, dayId);
	expect(started.ok).toBe(true);
	expect(await sessionCount(userId)).toBe(1);
});

it('walks the lineage forward to the newest active version', async () => {
	const userId = await createTestUser(h.db, 'versions');
	const v1 = await program(userId);
	const v2 = await edit(userId, v1.programId);
	const v3 = await edit(userId, v2);
	expect(await currentProgramVersion(h.db, userId, v1.programId)).toEqual({
		id: v3,
		name: 'Push Pull'
	});
	expect((await currentProgramVersion(h.db, userId, v2))?.id).toBe(v3);
	// The active version has no successor.
	expect(await currentProgramVersion(h.db, userId, v3)).toBeNull();
});

it('finds no current version when the lineage ends retired or is broken', async () => {
	const userId = await createTestUser(h.db, 'versions');
	const v1 = await program(userId);
	const v2 = await edit(userId, v1.programId);
	expect((await currentProgramVersion(h.db, userId, v1.programId))?.id).toBe(v2);
	await h.db.update(s.programs).set({ isActive: false }).where(eq(s.programs.id, v2));
	expect(await currentProgramVersion(h.db, userId, v1.programId)).toBeNull();
	// Deleting the successor breaks the chain (ON DELETE SET NULL).
	await h.db.delete(s.days).where(eq(s.days.programId, v2));
	await h.db.delete(s.programs).where(and(eq(s.programs.id, v2), eq(s.programs.userId, userId)));
	expect(await currentProgramVersion(h.db, userId, v1.programId)).toBeNull();
});

it("returns the owner their current version, and nothing to another user; another user's retired day is a 404", async () => {
	const { alice, bob } = await withTwoUsers(h.db);
	const v1 = await program(alice);
	const v2 = await edit(alice, v1.programId);
	expect((await currentProgramVersion(h.db, alice, v1.programId))?.id).toBe(v2);
	expect(await currentProgramVersion(h.db, bob, v1.programId)).toBeNull();
	expect(await programVersionState(h.db, bob, v1.programId)).toBeNull();
	// D6: bob gets the same 404 as an unknown day, not the retired 409.
	expect(await startSessionForDay(h.db, bob, v1.dayId)).toEqual({
		ok: false,
		status: 404,
		message: 'Day not found'
	});
	expect(await sessionCount(bob)).toBe(0);
});

it('does not follow a lineage into another user’s program', async () => {
	// A child row owned by someone else (not producible by the app, but the
	// walk must not cross owners even if it existed).
	const { alice, bob } = await withTwoUsers(h.db);
	const v1 = await program(alice);
	await h.db.update(s.programs).set({ isActive: false }).where(eq(s.programs.id, v1.programId));
	const [foreign] = await h.db
		.insert(s.programs)
		.values({ name: 'Bob copy', userId: bob, sourceProgramId: v1.programId })
		.returning();
	const [own] = await h.db
		.insert(s.programs)
		.values({ name: 'Alice v2', userId: alice, sourceProgramId: v1.programId })
		.returning();
	expect(await currentProgramVersion(h.db, alice, v1.programId)).toEqual({
		id: own.id,
		name: 'Alice v2'
	});
	await h.db.delete(s.programs).where(eq(s.programs.id, own.id));
	expect(await currentProgramVersion(h.db, alice, v1.programId)).toBeNull();
	// Bob owns an active child of Alice's program, and still learns nothing
	// about Alice's program: the walk starts only from a program he owns.
	expect(foreign.userId).toBe(bob);
	expect(await currentProgramVersion(h.db, bob, v1.programId)).toBeNull();
});
