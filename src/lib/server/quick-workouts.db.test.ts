import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { setupTestDb, resetTestDb, withTwoUsers, createTestUser, type TestDb } from './test-db';
import * as s from './db/schema';
import {
	ensureQuickProgram,
	lastUsedGymId,
	openQuickSessionId,
	quickStartChoices,
	startQuickSession,
	startQuickSessionFromForm
} from './quick-workouts';
import { endSession, loadSession, loadSessionSets, startSessionForDay } from './sessions';
import { addSessionExercise, createGym, createMachine } from './machines';
import { updateSetInSession } from './sessions';
import { historyForMonth } from './history';
import { reportSnapshot } from './machine-reports';
import { loadProgramDraft, ProgramNotFoundError } from './program-builder';
import { duplicateProgramForEditInTransaction } from './programs';
import { workoutUi } from '../workout-ui';

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

const quickPrograms = (userId: string) =>
	db
		.select()
		.from(s.programs)
		.where(and(eq(s.programs.userId, userId), eq(s.programs.systemKind, 'quick')));
const sessionsOf = (userId: string) =>
	db.select().from(s.sessions).where(eq(s.sessions.userId, userId));

async function started(userId: string, gymId: string) {
	const result = await startQuickSession(db, userId, gymId);
	if (!result.ok) throw new Error(result.message);
	return result.sessionId;
}

// A quick-add in the shape the session page's form posts, minus the gym:
// the session's gym is the default under test.
const addForm = (exerciseId: string, extra: Record<string, unknown> = {}) => ({
	exerciseId,
	equipmentType: 'machine-stack',
	loadConvention: 'displayed',
	setCount: '1',
	repsMin: '8',
	repsMax: '12',
	rir: '1',
	tier: 'secondary',
	progressionPolicy: 'standard',
	...extra
});

async function stackExercise(userId: string, name = 'Chest press') {
	const [exercise] = await db
		.insert(s.exercises)
		.values({ name, equipmentType: 'machine-stack', userId })
		.returning();
	return exercise;
}

describe('ensureQuickProgram', () => {
	it('creates "Quick workouts" with one day "Workout", once', async () => {
		const user = await createTestUser(db, 'quick');
		const first = await ensureQuickProgram(db, user);
		const second = await ensureQuickProgram(db, user);
		expect(second).toEqual(first);

		const programs = await quickPrograms(user);
		expect(programs).toHaveLength(1);
		expect(programs[0]).toMatchObject({
			id: first.programId,
			name: workoutUi.quickProgramName,
			isActive: true
		});
		const days = await db.select().from(s.days).where(eq(s.days.programId, first.programId));
		expect(days).toEqual([
			expect.objectContaining({ id: first.dayId, name: workoutUi.quickDayName, position: 1 })
		]);
	});

	it('converges on one program and one day under concurrent first calls', async () => {
		const user = await createTestUser(db, 'quick-race');
		const results = await Promise.all(
			Array.from({ length: 6 }, () => ensureQuickProgram(db, user))
		);
		expect(new Set(results.map((r) => r.programId)).size).toBe(1);
		expect(new Set(results.map((r) => r.dayId)).size).toBe(1);
		expect(await quickPrograms(user)).toHaveLength(1);
		const days = await db.select().from(s.days).where(eq(s.days.programId, results[0].programId));
		expect(days).toHaveLength(1);
	});

	it('gives each user their own quick program', async () => {
		const { alice, bob } = await withTwoUsers(db);
		const a = await ensureQuickProgram(db, alice);
		const b = await ensureQuickProgram(db, bob);
		expect(a.programId).not.toBe(b.programId);
		expect(await quickPrograms(alice)).toHaveLength(1);
		expect(await quickPrograms(bob)).toHaveLength(1);
	});

	it('the database refuses a second quick program for a user, and any other kind', async () => {
		const user = await createTestUser(db, 'quick-db');
		await ensureQuickProgram(db, user);
		await expect(
			db.insert(s.programs).values({ userId: user, name: 'Dup', systemKind: 'quick' })
		).rejects.toMatchObject({ cause: { constraint_name: 'programs_one_quick_per_user' } });
		await expect(
			db.insert(s.programs).values({ userId: user, name: 'Other', systemKind: 'template' })
		).rejects.toMatchObject({ cause: { constraint_name: 'programs_system_kind_check' } });
		// Ordinary programs are unaffected.
		await db.insert(s.programs).values([
			{ userId: user, name: 'Mine 1' },
			{ userId: user, name: 'Mine 2' }
		]);
	});
});

describe('startSessionForDay on a day with no prescribed sets', () => {
	it('creates an empty session on the quick day', async () => {
		const user = await createTestUser(db, 'empty-day');
		const { programId, dayId } = await ensureQuickProgram(db, user);
		const result = await startSessionForDay(db, user, dayId);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const session = await loadSession(db, user, result.sessionId, 'active');
		expect(session).toMatchObject({ programId, dayId, endedAt: null });
		expect(await loadSessionSets(db, user, result.sessionId)).toEqual([]);
	});
});

describe('startQuickSession', () => {
	it('starts a session on the quick day in the chosen gym', async () => {
		const user = await createTestUser(db, 'start');
		const gym = await createGym(db, user, { name: 'Main gym' });
		const sessionId = await started(user, gym.id);
		const { programId, dayId } = await ensureQuickProgram(db, user);
		const session = await loadSession(db, user, sessionId, 'active');
		expect(session).toMatchObject({ programId, dayId, gymId: gym.id, endedAt: null });
	});

	it('a second tap returns the open workout, in its original gym', async () => {
		const user = await createTestUser(db, 'second-tap');
		const gym = await createGym(db, user, { name: 'Main gym' });
		const other = await createGym(db, user, { name: 'Travel gym' });
		const first = await started(user, gym.id);
		const second = await started(user, other.id);
		expect(second).toBe(first);
		expect(await sessionsOf(user)).toHaveLength(1);
		expect((await loadSession(db, user, first, 'active'))?.gymId).toBe(gym.id);
	});

	it('two concurrent taps open one workout', async () => {
		const user = await createTestUser(db, 'double-tap');
		const gym = await createGym(db, user, { name: 'Main gym' });
		const ids = await Promise.all([started(user, gym.id), started(user, gym.id)]);
		expect(ids[0]).toBe(ids[1]);
		expect(await sessionsOf(user)).toHaveLength(1);
	});

	it('starts a new workout once the previous one has ended', async () => {
		const user = await createTestUser(db, 'after-end');
		const gym = await createGym(db, user, { name: 'Main gym' });
		const first = await started(user, gym.id);
		await endSession(db, user, first);
		const second = await started(user, gym.id);
		expect(second).not.toBe(first);
		expect(await quickPrograms(user)).toHaveLength(1);
	});

	it('starts in the owner own gym, and refuses another user gym with 404, writing nothing', async () => {
		const { alice, bob } = await withTwoUsers(db);
		const bobsGym = await createGym(db, bob, { name: "Bob's gym" });
		// Positive first: the gym works for its owner.
		const bobs = await startQuickSession(db, bob, bobsGym.id);
		expect(bobs.ok).toBe(true);

		const refused = await startQuickSession(db, alice, bobsGym.id);
		expect(refused).toEqual({ ok: false, status: 404, message: 'Gym not found' });
		expect(await quickPrograms(alice)).toEqual([]);
		expect(await sessionsOf(alice)).toEqual([]);
		// Bob's workout is untouched by the attempt.
		expect(await sessionsOf(bob)).toHaveLength(1);
	});

	it('refuses an unknown or malformed gym id with 404, writing nothing', async () => {
		const user = await createTestUser(db, 'bad-gym');
		expect(await startQuickSession(db, user, crypto.randomUUID())).toMatchObject({ status: 404 });
		expect(await startQuickSession(db, user, 'not-a-uuid')).toMatchObject({ status: 404 });
		expect(await quickPrograms(user)).toEqual([]);
		expect(await sessionsOf(user)).toEqual([]);
	});
});

describe('startQuickSessionFromForm (the gym step)', () => {
	it('a new user types a gym name, which creates the gym and starts there', async () => {
		const user = await createTestUser(db, 'first-run');
		const result = await startQuickSessionFromForm(db, user, { newGymName: '  Home garage ' });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const gyms = await db.select().from(s.gyms).where(eq(s.gyms.userId, user));
		expect(gyms.map((g) => g.name)).toEqual(['Home garage']);
		expect((await loadSession(db, user, result.sessionId, 'active'))?.gymId).toBe(gyms[0].id);
	});

	it('reuses a gym the user already has by that name instead of making a second', async () => {
		const user = await createTestUser(db, 'same-name');
		const gym = await createGym(db, user, { name: 'Home garage' });
		const result = await startQuickSessionFromForm(db, user, { newGymName: 'Home garage' });
		expect(result.ok).toBe(true);
		expect(await db.select().from(s.gyms).where(eq(s.gyms.userId, user))).toHaveLength(1);
		if (result.ok)
			expect((await loadSession(db, user, result.sessionId, 'active'))?.gymId).toBe(gym.id);
	});

	it('refuses an empty submission with 400, writing nothing', async () => {
		const user = await createTestUser(db, 'empty-form');
		expect(await startQuickSessionFromForm(db, user, {})).toMatchObject({ status: 400 });
		expect(await startQuickSessionFromForm(db, user, { newGymName: '   ' })).toMatchObject({
			status: 400
		});
		expect(await quickPrograms(user)).toEqual([]);
	});

	it('the owner may pick their gym by id; another user picking it gets 404', async () => {
		const { alice, bob } = await withTwoUsers(db);
		const gym = await createGym(db, alice, { name: "Alice's gym" });
		expect((await startQuickSessionFromForm(db, alice, { gymId: gym.id })).ok).toBe(true);
		expect(await startQuickSessionFromForm(db, bob, { gymId: gym.id })).toMatchObject({
			ok: false,
			status: 404
		});
		expect(await sessionsOf(bob)).toEqual([]);
	});
});

describe('the gym step default', () => {
	it('defaults to the gym used last, scoped to the user', async () => {
		const { alice, bob } = await withTwoUsers(db);
		const older = await createGym(db, alice, { name: 'A older' });
		const newer = await createGym(db, alice, { name: 'B newer' });
		// Before any workout: the first gym by name.
		expect(await quickStartChoices(db, alice)).toMatchObject({ defaultGymId: older.id });
		const sid = await started(alice, newer.id);
		await endSession(db, alice, sid);
		expect(await lastUsedGymId(db, alice)).toBe(newer.id); // positive first
		expect(await quickStartChoices(db, alice)).toMatchObject({ defaultGymId: newer.id });

		expect(await lastUsedGymId(db, bob)).toBeNull();
		expect(await quickStartChoices(db, bob)).toEqual({ gyms: [], defaultGymId: null });
	});

	it('falls back to the gym of the last machine logged in a program workout', async () => {
		const user = await createTestUser(db, 'machine-gym');
		await createGym(db, user, { name: 'A first by name' });
		const gym = await createGym(db, user, { name: 'Z where I train' });
		const machine = await createMachine(db, user, {
			gymId: gym.id,
			localLabel: 'Stack',
			equipmentType: 'machine-stack'
		});
		const [program] = await db.insert(s.programs).values({ name: 'P', userId: user }).returning();
		const [day] = await db
			.insert(s.days)
			.values({ programId: program.id, name: 'D', position: 1 })
			.returning();
		const start = await startSessionForDay(db, user, day.id);
		if (!start.ok) throw new Error(start.message);
		const exercise = await stackExercise(user);
		await addSessionExercise(
			db,
			user,
			start.sessionId,
			addForm(exercise.id, { gymId: gym.id, gymEquipmentId: machine.id })
		);
		expect(await lastUsedGymId(db, user)).toBe(gym.id);
	});
});

describe('addSessionExercise in a quick workout', () => {
	it('defaults the gym to the session gym', async () => {
		const user = await createTestUser(db, 'default-gym');
		await createGym(db, user, { name: 'Another gym' });
		const gym = await createGym(db, user, { name: 'Session gym' });
		const sessionId = await started(user, gym.id);
		const exercise = await stackExercise(user);
		const occurrence = await addSessionExercise(
			db,
			user,
			sessionId,
			addForm(exercise.id, { newMachineName: 'Chest press by the window' })
		);
		expect(occurrence.gymName).toBe('Session gym');
		const [machine] = await db
			.select()
			.from(s.gymEquipment)
			.where(eq(s.gymEquipment.id, occurrence.gymEquipmentId!));
		expect(machine).toMatchObject({ gymId: gym.id, localLabel: 'Chest press by the window' });
	});

	it('a second quick workout prefills last time numbers for the same exercise and machine', async () => {
		const user = await createTestUser(db, 'prefill');
		const gym = await createGym(db, user, { name: 'Main gym' });
		const exercise = await stackExercise(user);

		const first = await started(user, gym.id);
		const occurrence = await addSessionExercise(
			db,
			user,
			first,
			addForm(exercise.id, { newMachineName: 'Chest press' })
		);
		const [set] = await loadSessionSets(db, user, first);
		expect(set.prescribedLoad).toBeNull(); // no prescription, no history yet
		const saved = await updateSetInSession(db, user, first, set.id, {
			expectedIdentity: `${occurrence.gymEquipmentId}:displayed`,
			executedLoad: '110',
			executedReps: '10',
			executedRir: '2',
			notes: ''
		});
		expect(saved.ok).toBe(true);
		await endSession(db, user, first);

		const second = await started(user, gym.id);
		expect(second).not.toBe(first);
		await addSessionExercise(
			db,
			user,
			second,
			addForm(exercise.id, { gymEquipmentId: occurrence.gymEquipmentId })
		);
		const [next] = await loadSessionSets(db, user, second);
		expect(next.prescribedLoad).toBe(110);
	});
});

describe('cross-tenant: user B never sees user A quick program, sessions or gym', () => {
	it('open workout, session, sets, history and reports are the owner only', async () => {
		const { alice, bob } = await withTwoUsers(db);
		const gym = await createGym(db, alice, { name: "Alice's gym" });
		const sessionId = await started(alice, gym.id);
		const exercise = await stackExercise(alice);
		await addSessionExercise(db, alice, sessionId, addForm(exercise.id, { newMachineName: 'M' }));

		// Positive first.
		expect(await openQuickSessionId(db, alice)).toBe(sessionId);
		expect(await loadSession(db, alice, sessionId, 'active')).not.toBeNull();
		expect(await loadSessionSets(db, alice, sessionId)).toHaveLength(1);
		expect((await quickStartChoices(db, alice)).gyms.map((g) => g.id)).toEqual([gym.id]);
		const now = new Date();
		const month = [
			new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
			new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
		] as const;
		expect(await historyForMonth(db, alice, ...month)).toHaveLength(1);

		expect(await openQuickSessionId(db, bob)).toBeNull();
		expect(await loadSession(db, bob, sessionId, 'active')).toBeNull();
		expect(await loadSessionSets(db, bob, sessionId)).toEqual([]);
		expect(await quickStartChoices(db, bob)).toEqual({ gyms: [], defaultGymId: null });
		expect(await historyForMonth(db, bob, ...month)).toEqual([]);
		expect((await reportSnapshot(db, bob)).overview.totalSessions).toBe(0);

		// Bob's own first tap makes his own program, never reusing Alice's.
		const bobs = await ensureQuickProgram(db, bob);
		expect(bobs.programId).not.toBe((await ensureQuickProgram(db, alice)).programId);
	});

	it('another user cannot add an exercise to the workout, even through its gym default', async () => {
		const { alice, bob } = await withTwoUsers(db);
		const gym = await createGym(db, alice, { name: "Alice's gym" });
		const sessionId = await started(alice, gym.id);
		const aliceExercise = await stackExercise(alice);
		const bobExercise = await stackExercise(bob);
		// Positive first.
		await addSessionExercise(
			db,
			alice,
			sessionId,
			addForm(aliceExercise.id, { newMachineName: 'M' })
		);
		await expect(
			addSessionExercise(db, bob, sessionId, addForm(bobExercise.id, { newMachineName: 'X' }))
		).rejects.toThrow('Session not found');
		expect(await db.select().from(s.gyms).where(eq(s.gyms.userId, bob))).toEqual([]);
		expect(await loadSessionSets(db, alice, sessionId)).toHaveLength(1);
	});
});

describe('system programs are hidden from every program list and editor', () => {
	it('loadProgramDraft and the edit duplicate treat a quick program as not found', async () => {
		const user = await createTestUser(db, 'hidden');
		const [ordinary] = await db
			.insert(s.programs)
			.values({ name: 'Mine', userId: user })
			.returning();
		const { programId } = await ensureQuickProgram(db, user);
		// Positive first: an ordinary program loads and duplicates.
		expect((await loadProgramDraft(db, user, ordinary.id)).name).toBe('Mine');
		await expect(loadProgramDraft(db, user, programId)).rejects.toBeInstanceOf(
			ProgramNotFoundError
		);
		await expect(
			db.transaction((tx) => duplicateProgramForEditInTransaction(tx, user, programId))
		).rejects.toThrow('Program not found');
		const [quick] = await quickPrograms(user);
		expect(quick.isActive).toBe(true);
	});

	it('History and Reports include quick workouts, labelled as such', async () => {
		const user = await createTestUser(db, 'labelled');
		const gym = await createGym(db, user, { name: 'Gym' });
		const sessionId = await started(user, gym.id);
		await endSession(db, user, sessionId);
		const now = new Date();
		const rows = await historyForMonth(
			db,
			user,
			new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
			new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
		);
		expect(rows).toEqual([expect.objectContaining({ id: sessionId, systemKind: 'quick' })]);
		const report = await reportSnapshot(db, user);
		expect(report.overview.endedSessions).toBe(1);
		expect(report.recentTrend).toEqual([expect.objectContaining({ sessionId, quick: true })]);
	});
});

it('the migration created the named constraints and index', async () => {
	const names = await db.execute<{ name: string }>(sql`
		select conname as name from pg_constraint
		 where conname in ('programs_system_kind_check', 'sessions_gym_id_fk')
		union all
		select indexname from pg_indexes
		 where indexname in ('programs_one_quick_per_user', 'sessions_gym_id_idx')
		order by 1`);
	expect([...names].map((r) => r.name)).toEqual([
		'programs_one_quick_per_user',
		'programs_system_kind_check',
		'sessions_gym_id_fk',
		'sessions_gym_id_idx'
	]);
});
