import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { setupTestDb, resetTestDbWithUsers, withTwoUsers, type TestDb } from '$lib/server/test-db';
import { endSession, softDeleteEndedSession, startSessionForDay } from '$lib/server/sessions';
import { ensureQuickProgram } from '$lib/server/quick-workouts';

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

import { actions, load } from './+page.server';
import * as s from '$lib/server/db/schema';

let harness: Awaited<ReturnType<typeof setupTestDb>>;
let user: { id: string; label: string };
let userId: string;
beforeAll(async () => {
	harness = await setupTestDb();
	testDb.db = harness.db;
});
beforeEach(async () => {
	// Reset then create the fixture user, in that order, in one call.
	[user] = await resetTestDbWithUsers(harness.db, harness.client, 1, 'history');
	userId = user.id;
});
afterAll(async () => {
	await harness?.end();
});

type HistoryData = {
	month: string;
	prevMonth: string;
	nextMonth: string | null;
	sessions: { id: string }[];
	trashSessions: { id: string; systemKind: string | null; programName: string }[];
	trashCount: number;
};
// The load reads requireUser(locals), so the test posts a signed-in owner
// the way hooks.server.ts populates it.
const call = async (month: string | null, ownerId: string = userId): Promise<HistoryData> => {
	const url = new URL('http://test.local/history');
	if (month !== null) url.searchParams.set('month', month);
	const result = await load({ url, locals: { user: { id: ownerId } } } as Parameters<
		typeof load
	>[0]);
	if (!result || typeof result !== 'object') throw new Error('history load returned nothing');
	return result as unknown as HistoryData;
};

async function sessionInMonth(year: number, monthIndex: number, ownerId: string = userId) {
	const db = testDb.db!;
	const [program] = await db.insert(s.programs).values({ userId: ownerId, name: 'P' }).returning();
	const [day] = await db
		.insert(s.days)
		.values({ programId: program.id, name: 'D', position: 1 })
		.returning();
	const started = await startSessionForDay(db, ownerId, day.id);
	if (!started.ok) throw new Error(started.message);
	await db
		.update(s.sessions)
		.set({ startedAt: new Date(Date.UTC(year, monthIndex, 15, 12)) })
		.where(eq(s.sessions.id, started.sessionId));
	return started.sessionId;
}

it('honours a valid ?month=YYYY-MM parameter', async () => {
	const result = await call('2026-01');
	expect(result.month).toBe('2026-01');
	expect(result.prevMonth).toBe('2025-12');
	expect(result.nextMonth).toBe('2026-02');
});

it('falls back to the current month for a malformed month parameter', async () => {
	const result = await call('january');
	const now = new Date();
	const expected = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
	expect(result.month).toBe(expected);
});

it('falls back to the current month when the parameter is absent', async () => {
	const result = await call(null);
	const now = new Date();
	const expected = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
	expect(result.month).toBe(expected);
});

it('only returns sessions started within the requested month', async () => {
	const sessionId = await sessionInMonth(2026, 0);
	const january = await call('2026-01');
	expect(january.sessions.map((r) => r.id)).toContain(sessionId);
	const february = await call('2026-02');
	expect(february.sessions.map((r) => r.id)).not.toContain(sessionId);
});

// Cross-tenant. Positive first: Alice sees her own session for the month, Bob
// sees none of it. Without the positive half, a predicate returning nothing at
// all would satisfy the negative.
it("lists only the requesting user's sessions for the month", async () => {
	const { alice, bob } = await withTwoUsers(testDb.db!);
	const aliceSession = await sessionInMonth(2026, 0, alice);

	const asAlice = await call('2026-01', alice);
	expect(asAlice.sessions.map((s) => s.id)).toEqual([aliceSession]);

	// Bob has a program and no session: the same month, a different owner.
	const asBob = await call('2026-01', bob);
	expect(asBob.sessions).toEqual([]);
});

// ---------- Trash on History (0.5.2) ----------

type ActionEvent = Parameters<(typeof actions)['restoreSession']>[0];
const post = (form: Record<string, string>, ownerId: string = userId): ActionEvent => {
	const fd = new FormData();
	for (const [k, v] of Object.entries(form)) fd.append(k, v);
	return {
		request: new Request('http://test.local/history', { method: 'POST', body: fd }),
		params: {},
		url: new URL('http://test.local/history'),
		locals: { user: { id: ownerId } } as App.Locals
	} as unknown as ActionEvent;
};

/** A trashed, ended workout: the quick program's day, or a named program's. */
async function trashedWorkout(kind: 'quick' | 'program', ownerId: string = userId) {
	const db = testDb.db!;
	let dayId: string;
	if (kind === 'quick') {
		dayId = (await ensureQuickProgram(db, ownerId)).dayId;
	} else {
		const [program] = await db
			.insert(s.programs)
			.values({ userId: ownerId, name: 'Push Pull' })
			.returning();
		const [day] = await db
			.insert(s.days)
			.values({ programId: program.id, name: 'Push', position: 1 })
			.returning();
		dayId = day.id;
	}
	const started = await startSessionForDay(db, ownerId, dayId);
	if (!started.ok) throw new Error(started.message);
	await endSession(db, ownerId, started.sessionId);
	const trashed = await softDeleteEndedSession(db, ownerId, started.sessionId);
	if (!trashed.ok) throw new Error(trashed.message);
	return started.sessionId;
}

const rowOf = async (id: string) =>
	(await testDb.db!.select().from(s.sessions).where(eq(s.sessions.id, id)))[0];

it('load lists every trashed workout, quick and program, whatever the month', async () => {
	const quick = await trashedWorkout('quick');
	const program = await trashedWorkout('program');
	const result = await call('2020-01');
	expect(result.trashCount).toBe(2);
	expect(result.trashSessions.map((t) => t.id).sort()).toEqual([quick, program].sort());
	expect(result.trashSessions.find((t) => t.id === quick)?.systemKind).toBe('quick');
	expect(result.trashSessions.find((t) => t.id === program)?.programName).toBe('Push Pull');
});

it("load lists the owner's Trash, and none of it to another user", async () => {
	const { alice, bob } = await withTwoUsers(testDb.db!);
	const quick = await trashedWorkout('quick', alice);
	const asAlice = await call(null, alice);
	expect(asAlice.trashSessions.map((t) => t.id)).toEqual([quick]);
	const asBob = await call(null, bob);
	expect(asBob.trashSessions).toEqual([]);
	expect(asBob.trashCount).toBe(0);
});

for (const kind of ['quick', 'program'] as const) {
	it(`restoreSession restores a trashed ${kind} workout`, async () => {
		const id = await trashedWorkout(kind);
		const result = await actions.restoreSession(post({ sessionId: id }));
		expect(result).toEqual({ ok: true });
		expect((await rowOf(id)).deletedAt).toBeNull();
		expect((await call(null)).trashCount).toBe(0);
	});

	it(`permanentDeleteSession deletes a trashed ${kind} workout`, async () => {
		const id = await trashedWorkout(kind);
		const result = await actions.permanentDeleteSession(
			post({ sessionId: id, confirmDelete: 'd' })
		);
		expect(result).toEqual({ ok: true });
		expect(await rowOf(id)).toBeUndefined();
	});
}

it('restoreSession rejects a malformed session id with 400', async () => {
	const result = await actions.restoreSession(post({ sessionId: 'nope' }));
	expect(result).toMatchObject({ status: 400 });
});

it('restoreSession returns 404 for an id that is not in Trash', async () => {
	const result = await actions.restoreSession(post({ sessionId: randomUUID() }));
	expect(result).toMatchObject({ status: 404 });
});

it('permanentDeleteSession without the confirmation is a 400 and deletes nothing', async () => {
	const id = await trashedWorkout('quick');
	const result = await actions.permanentDeleteSession(post({ sessionId: id }));
	expect(result).toMatchObject({ status: 400 });
	expect((await rowOf(id)).deletedAt).not.toBeNull();
});

it('permanentDeleteSession refuses (404) a workout that is not in Trash', async () => {
	const db = testDb.db!;
	const { dayId } = await ensureQuickProgram(db, userId);
	const started = await startSessionForDay(db, userId, dayId);
	if (!started.ok) throw new Error(started.message);
	await endSession(db, userId, started.sessionId);
	const result = await actions.permanentDeleteSession(
		post({ sessionId: started.sessionId, confirmDelete: 'd' })
	);
	expect(result).toMatchObject({ status: 404 });
	expect((await rowOf(started.sessionId)).deletedAt).toBeNull();
});

// Cross-tenant, through the actions. Positive first: the owner's Trash holds
// the workout; then Bob is refused with 404 and the row is exactly as it was;
// then the owner can still act on it.
for (const kind of ['quick', 'program'] as const) {
	it(`another user cannot restore or permanently delete the owner's trashed ${kind} workout`, async () => {
		const { alice, bob } = await withTwoUsers(testDb.db!);
		const id = await trashedWorkout(kind, alice);
		expect((await call(null, alice)).trashSessions.map((t) => t.id)).toEqual([id]);
		const before = await rowOf(id);

		const restore = await actions.restoreSession(post({ sessionId: id }, bob));
		expect(restore).toMatchObject({ status: 404 });
		const del = await actions.permanentDeleteSession(
			post({ sessionId: id, confirmDelete: 'd' }, bob)
		);
		expect(del).toMatchObject({ status: 404 });
		expect(await rowOf(id)).toEqual(before);

		expect(await actions.restoreSession(post({ sessionId: id }, alice))).toEqual({ ok: true });
		expect((await rowOf(id)).deletedAt).toBeNull();
	});
}
