/**
 * Trash on History (0.5.2): `listDeletedSessionsForUser`, and restore and
 * permanent delete by id through the owner-scoped functions the program page
 * already calls (`restoreSoftDeletedSession`, `hardDeleteSession`). Every
 * case runs against a quick workout AND a program workout, because the quick
 * program has no page and History is the only Trash that can reach it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { createTestUser, resetTestDb, setupTestDb, withTwoUsers, type TestDb } from './test-db';
import * as s from './db/schema';
import { startQuickSession } from './quick-workouts';
import { addSessionExercise, createGym } from './machines';
import {
	endSession,
	hardDeleteSession,
	listDeletedSessionsForProgram,
	listDeletedSessionsForUser,
	restoreSoftDeletedSession,
	softDeleteEndedSession,
	startSessionForDay
} from './sessions';

let db: TestDb;
let handle: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
	handle = await setupTestDb();
	db = handle.db;
});
afterAll(async () => {
	await handle?.end();
});
beforeEach(async () => {
	await resetTestDb(handle.client);
});

/** Mark the first `logged` sets of a session as done, then end it. */
async function logAndEnd(userId: string, sessionId: string, logged: number) {
	const rows = await db
		.select({ id: s.sets.id })
		.from(s.sets)
		.where(eq(s.sets.sessionId, sessionId))
		.orderBy(s.sets.position);
	for (const row of rows.slice(0, logged)) {
		await db
			.update(s.sets)
			.set({ executedLoad: 100, executedReps: 10 })
			.where(eq(s.sets.id, row.id));
	}
	const ended = await endSession(db, userId, sessionId);
	if (!ended.updated) throw new Error('fixture session did not end');
}

/** An ended quick workout with three sets, two of them logged. */
async function quickWorkout(userId: string): Promise<string> {
	const [existing] = await db.select().from(s.gyms).where(eq(s.gyms.userId, userId));
	const gym = existing ?? (await createGym(db, userId, { name: 'Corner gym' }));
	const started = await startQuickSession(db, userId, gym.id);
	if (!started.ok) throw new Error(started.message);
	const [exercise] = await db
		.insert(s.exercises)
		.values({
			name: `Chest press ${crypto.randomUUID().slice(0, 6)}`,
			equipmentType: 'machine-stack',
			userId
		})
		.returning();
	await addSessionExercise(db, userId, started.sessionId, {
		exerciseId: exercise.id,
		equipmentType: 'machine-stack',
		loadConvention: 'displayed',
		newMachineName: 'Chest press by the window',
		setCount: '3',
		repsMin: '8',
		repsMax: '12',
		rir: '1',
		tier: 'secondary',
		progressionPolicy: 'standard'
	});
	await logAndEnd(userId, started.sessionId, 2);
	return started.sessionId;
}

/** An ended program workout with one set, logged. */
async function programWorkout(
	userId: string,
	name = 'Upper/Lower'
): Promise<{ sessionId: string; programId: string; dayId: string }> {
	const [program] = await db.insert(s.programs).values({ userId, name }).returning();
	const [day] = await db
		.insert(s.days)
		.values({ programId: program.id, name: 'Upper', position: 1 })
		.returning();
	const [exercise] = await db
		.insert(s.exercises)
		.values({ userId, name: `Row ${crypto.randomUUID().slice(0, 6)}`, equipmentType: 'cable' })
		.returning();
	const [dx] = await db
		.insert(s.dayExercises)
		.values({ dayId: day.id, exerciseId: exercise.id, position: 1, tier: 'secondary' })
		.returning();
	await db.insert(s.prescribedSets).values({
		dayExerciseId: dx.id,
		position: 1,
		setRole: 'working',
		targetMetric: 'reps',
		targetRepsMin: 8,
		targetRepsMax: 12,
		targetRir: 1,
		initialLoad: 50
	});
	const started = await startSessionForDay(db, userId, day.id);
	if (!started.ok) throw new Error(started.message);
	await logAndEnd(userId, started.sessionId, 1);
	return { sessionId: started.sessionId, programId: program.id, dayId: day.id };
}

async function trash(userId: string, sessionId: string) {
	const result = await softDeleteEndedSession(db, userId, sessionId);
	if (!result.ok) throw new Error(result.message);
}

const sessionRow = async (id: string) =>
	(await db.select().from(s.sessions).where(eq(s.sessions.id, id)))[0];
const setRows = (sessionId: string) =>
	db.select().from(s.sets).where(eq(s.sets.sessionId, sessionId));
const occurrenceRows = (sessionId: string) =>
	db.select().from(s.sessionExercises).where(eq(s.sessionExercises.sessionId, sessionId));

describe('listDeletedSessionsForUser', () => {
	it('lists every trashed workout of the user, quick and program, with label and logged sets', async () => {
		const user = await createTestUser(db, 'trash-list');
		const quick = await quickWorkout(user);
		const program = await programWorkout(user, 'Upper/Lower');
		const kept = await programWorkout(user, 'Kept program');
		await trash(user, quick);
		await trash(user, program.sessionId);

		const { sessions, total } = await listDeletedSessionsForUser(db, user);
		expect(total).toBe(2);
		expect(sessions.map((t) => t.id).sort()).toEqual([quick, program.sessionId].sort());
		const byId = new Map(sessions.map((t) => [t.id, t]));
		expect(byId.get(quick)).toMatchObject({ systemKind: 'quick', loggedSets: 2 });
		expect(byId.get(program.sessionId)).toMatchObject({
			systemKind: null,
			programName: 'Upper/Lower',
			loggedSets: 1
		});
		// A workout not in Trash is not listed.
		expect(byId.has(kept.sessionId)).toBe(false);
	});

	it('reports the true total when the list is capped', async () => {
		const user = await createTestUser(db, 'trash-cap');
		await trash(user, await quickWorkout(user));
		await trash(user, (await programWorkout(user)).sessionId);
		const { sessions, total } = await listDeletedSessionsForUser(db, user, 1);
		expect(sessions).toHaveLength(1);
		expect(total).toBe(2);
	});
});

describe('restore by id from History', () => {
	for (const kind of ['quick', 'program'] as const) {
		it(`restores a trashed ${kind} workout and it leaves the list`, async () => {
			const user = await createTestUser(db, `restore-${kind}`);
			const id =
				kind === 'quick' ? await quickWorkout(user) : (await programWorkout(user)).sessionId;
			await trash(user, id);
			expect((await listDeletedSessionsForUser(db, user)).sessions.map((t) => t.id)).toEqual([id]);

			const result = await restoreSoftDeletedSession(db, user, id);
			expect(result).toEqual({ ok: true });
			expect((await sessionRow(id)).deletedAt).toBeNull();
			expect((await listDeletedSessionsForUser(db, user)).total).toBe(0);
			// Its sets came back with it, untouched.
			expect((await setRows(id)).length).toBeGreaterThan(0);
		});
	}

	it('restoring never creates a second open workout on the day: only ended workouts are trashed', async () => {
		// The program page's restore has no open-session check, because
		// softDeleteEndedSession refuses an open session: everything in Trash
		// is ended, so restoring it cannot hit sessions_one_open_per_day.
		// History calls the same function. Prove it with the case that
		// matters for quick workouts, which all share one day.
		const user = await createTestUser(db, 'restore-open');
		const trashed = await quickWorkout(user);
		await trash(user, trashed);
		const [gym] = await db.select().from(s.gyms).where(eq(s.gyms.userId, user));
		const open = await startQuickSession(db, user, gym.id);
		if (!open.ok) throw new Error(open.message);

		// The open workout itself can never reach Trash.
		expect(await softDeleteEndedSession(db, user, open.sessionId)).toMatchObject({
			ok: false,
			status: 404
		});

		expect(await restoreSoftDeletedSession(db, user, trashed)).toEqual({ ok: true });

		const live = await db
			.select({ id: s.sessions.id, endedAt: s.sessions.endedAt })
			.from(s.sessions)
			.where(and(eq(s.sessions.userId, user), isNull(s.sessions.deletedAt)));
		expect(live.map((r) => r.id).sort()).toEqual([trashed, open.sessionId].sort());
		expect(live.filter((r) => r.endedAt === null).map((r) => r.id)).toEqual([open.sessionId]);
	});

	it('refuses (404) a workout that is not in Trash, and writes nothing', async () => {
		const user = await createTestUser(db, 'restore-live');
		const id = await quickWorkout(user);
		const result = await restoreSoftDeletedSession(db, user, id);
		expect(result).toMatchObject({ ok: false, status: 404 });
		expect((await sessionRow(id)).deletedAt).toBeNull();
	});
});

describe('permanent delete by id from History', () => {
	for (const kind of ['quick', 'program'] as const) {
		it(`deletes a trashed ${kind} workout and its rows`, async () => {
			const user = await createTestUser(db, `delete-${kind}`);
			const id =
				kind === 'quick' ? await quickWorkout(user) : (await programWorkout(user)).sessionId;
			await trash(user, id);
			expect((await setRows(id)).length).toBeGreaterThan(0);
			expect((await occurrenceRows(id)).length).toBeGreaterThan(0);

			const result = await hardDeleteSession(db, user, id);
			expect(result).toEqual({ ok: true });
			expect(await sessionRow(id)).toBeUndefined();
			expect(await setRows(id)).toEqual([]);
			expect(await occurrenceRows(id)).toEqual([]);
			expect((await listDeletedSessionsForUser(db, user)).total).toBe(0);
		});
	}

	it('deletes only the one id: other trashed and live workouts stay', async () => {
		const user = await createTestUser(db, 'delete-one');
		const target = await quickWorkout(user);
		const otherTrashed = await programWorkout(user);
		const live = await programWorkout(user, 'Live');
		await trash(user, target);
		await trash(user, otherTrashed.sessionId);

		expect(await hardDeleteSession(db, user, target)).toEqual({ ok: true });
		expect(await sessionRow(target)).toBeUndefined();
		expect((await sessionRow(otherTrashed.sessionId)).deletedAt).not.toBeNull();
		expect((await sessionRow(live.sessionId)).deletedAt).toBeNull();
		// The program page still lists the program's own trashed workout.
		expect(
			(await listDeletedSessionsForProgram(db, user, otherTrashed.programId)).map((t) => t.id)
		).toEqual([otherTrashed.sessionId]);
	});

	it('refuses (404) a workout that is not in Trash, and deletes nothing', async () => {
		const user = await createTestUser(db, 'delete-live');
		const id = await quickWorkout(user);
		const result = await hardDeleteSession(db, user, id);
		expect(result).toMatchObject({ ok: false, status: 404 });
		expect(await sessionRow(id)).toBeDefined();
		expect((await setRows(id)).length).toBe(3);
	});
});

describe('cross-tenant: Trash on History', () => {
	it("lists the owner's trashed workouts, and none of them to another user", async () => {
		const { alice, bob } = await withTwoUsers(db);
		const quick = await quickWorkout(alice);
		const program = await programWorkout(alice);
		await trash(alice, quick);
		await trash(alice, program.sessionId);

		const mine = await listDeletedSessionsForUser(db, alice);
		expect(mine.sessions.map((t) => t.id).sort()).toEqual([quick, program.sessionId].sort());
		expect(mine.total).toBe(2);

		const theirs = await listDeletedSessionsForUser(db, bob);
		expect(theirs).toEqual({ sessions: [], total: 0 });
	});

	for (const kind of ['quick', 'program'] as const) {
		it(`another user cannot restore the owner's trashed ${kind} workout (404, nothing written)`, async () => {
			const { alice, bob } = await withTwoUsers(db);
			const id =
				kind === 'quick' ? await quickWorkout(alice) : (await programWorkout(alice)).sessionId;
			await trash(alice, id);
			// Positive first: the owner's Trash holds it.
			expect((await listDeletedSessionsForUser(db, alice)).sessions.map((t) => t.id)).toEqual([id]);
			const before = await sessionRow(id);

			expect(await restoreSoftDeletedSession(db, bob, id)).toMatchObject({
				ok: false,
				status: 404
			});
			expect(await sessionRow(id)).toEqual(before);

			// And the owner still can.
			expect(await restoreSoftDeletedSession(db, alice, id)).toEqual({ ok: true });
			expect((await sessionRow(id)).deletedAt).toBeNull();
		});

		it(`another user cannot permanently delete the owner's trashed ${kind} workout (404, nothing deleted)`, async () => {
			const { alice, bob } = await withTwoUsers(db);
			const id =
				kind === 'quick' ? await quickWorkout(alice) : (await programWorkout(alice)).sessionId;
			await trash(alice, id);
			// Positive first: the owner's Trash holds it, with its sets.
			expect((await listDeletedSessionsForUser(db, alice)).sessions.map((t) => t.id)).toEqual([id]);
			const setsBefore = (await setRows(id)).length;
			expect(setsBefore).toBeGreaterThan(0);

			expect(await hardDeleteSession(db, bob, id)).toMatchObject({ ok: false, status: 404 });
			expect((await sessionRow(id)).deletedAt).not.toBeNull();
			expect(await setRows(id)).toHaveLength(setsBefore);

			// And the owner still can.
			expect(await hardDeleteSession(db, alice, id)).toEqual({ ok: true });
			expect(await sessionRow(id)).toBeUndefined();
		});
	}
});
