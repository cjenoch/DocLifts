import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, test } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { createTestUser, resetTestDb, setupTestDb, withTwoUsers, type TestDb } from './test-db';
import * as s from './db/schema';
import {
	createGym,
	createMachine,
	addSessionExercise,
	bindSessionMachine,
	machineChoices,
	LABEL_REQUIRED_MESSAGE
} from './machines';
import { startSessionForDay, endSession, updateSetInSession } from './sessions';
import { modelChoices } from './catalog';
import { getLastCompletedSet, computeConsecutiveBackwards } from './progression';
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
// Every insert in this module must supply an owner. Between 0009 and 0010 the
// columns are nullable, so the compiler cannot catch an omission — this can.
afterEach(async () => {});
async function fixture() {
	// One owner for the whole fixture. programs/sessions/sets are inserted
	// directly here rather than through sessions.ts because those modules do
	// not take a userId until T4 — but the rows still carry the owner, so
	const userId = await createTestUser(db, 'fixture');
	const [program] = await db.insert(s.programs).values({ name: 'Pilot', userId }).returning();
	const [day] = await db
		.insert(s.days)
		.values({ programId: program.id, name: 'Day', position: 1 })
		.returning();
	const [exercise] = await db
		.insert(s.exercises)
		.values({
			name: 'Press',
			canonicalMovement: 'chest_press',
			equipmentType: 'machine-plate',
			userId
		})
		.returning();
	const [dx] = await db
		.insert(s.dayExercises)
		.values({ dayId: day.id, exerciseId: exercise.id, position: 1, tier: 'secondary' })
		.returning();
	await db.insert(s.prescribedSets).values(
		[1, 2].map((position) => ({
			dayExerciseId: dx.id,
			position,
			setRole: 'working' as const,
			targetRepsMin: 8,
			targetRepsMax: 10,
			targetRir: 1,
			initialLoad: 50
		}))
	);
	const gym = await createGym(db, userId, { name: 'Gym A' });
	const gymB = await createGym(db, userId, { name: 'Gym B' });
	// owner_user_id NULL = a global model, usable by anyone. Kept that way
	// deliberately: the cross-tenant "global model still works" test needs one.
	const [model] = await db
		.insert(s.equipmentModels)
		.values({ manufacturer: 'User supplied', name: 'Combo', loadingType: 'machine-plate' })
		.returning();
	const machine = await createMachine(db, userId, {
		gymId: gym.id,
		localLabel: 'Press A',
		equipmentType: 'machine-plate',
		equipmentModelId: model.id
	});
	const machineB = await createMachine(db, userId, {
		gymId: gymB.id,
		localLabel: 'Press B',
		equipmentType: 'machine-plate',
		equipmentModelId: model.id
	});
	return { userId, day, exercise, gym, gymB, machine, machineB, program };
}
// A minimal program/day for an arbitrary owner, for tests that need a second
// user to start a session of their own. Starting a session on another user's
// day is not a legal setup: once (f) lands, startSessionForDay refuses it, so
// a test that relies on it breaks in the end state as well as the interim one.
async function dayFor(ownerId: string) {
	const [program] = await db
		.insert(s.programs)
		.values({ name: 'Bob Program', userId: ownerId })
		.returning();
	const [day] = await db
		.insert(s.days)
		.values({ programId: program.id, name: 'Bob Day', position: 1 })
		.returning();
	const [exercise] = await db
		.insert(s.exercises)
		.values({
			name: 'Bob Press',
			canonicalMovement: 'chest_press',
			equipmentType: 'machine-plate',
			userId: ownerId
		})
		.returning();
	const [dx] = await db
		.insert(s.dayExercises)
		.values({ dayId: day.id, exerciseId: exercise.id, position: 1, tier: 'secondary' })
		.returning();
	await db.insert(s.prescribedSets).values({
		dayExerciseId: dx.id,
		position: 1,
		setRole: 'working' as const,
		targetRepsMin: 8,
		targetRepsMax: 10,
		targetRir: 1,
		initialLoad: 50
	});
	return day;
}
async function start(userId: string, dayId: string) {
	const result = await startSessionForDay(db, userId, dayId);
	if (!result.ok) throw new Error(result.message);
	// No stamping here. startSessionForDay owns both the session row and the
	// afterEach now checks production code rather than this fixture.
	const [occurrence] = await db
		.select()
		.from(s.sessionExercises)
		.where(eq(s.sessionExercises.sessionId, result.sessionId));
	return { sessionId: result.sessionId, occurrence };
}
async function log(userId: string, sessionId: string, load: number, reps = 10) {
	const rows = await db.select().from(s.sets).where(eq(s.sets.sessionId, sessionId));
	for (const row of rows)
		await updateSetInSession(db, userId, sessionId, row.id, {
			executedLoad: load,
			executedReps: reps,
			executedRir: 1,
			notes: '',
			expectedIdentity: `${row.gymEquipmentId ?? 'legacy'}:${row.loadConvention}`
		});
	await endSession(db, userId, sessionId);
}
const binding = (gymId: string, gymEquipmentId: string, loadConvention = 'plates_per_side') => ({
	gymId,
	gymEquipmentId,
	loadConvention,
	confirm: 'CHANGE'
});
describe('physical machine identity', () => {
	it('counts completed sessions rather than repeated occurrences for backwards streaks', async () => {
		const f = await fixture();
		const run = await start(f.userId, f.day.id);
		await bindSessionMachine(
			db,
			f.userId,
			run.sessionId,
			run.occurrence.id,
			binding(f.gym.id, f.machine.id)
		);
		const [source] = await db.select().from(s.sets).where(eq(s.sets.sessionId, run.sessionId));
		await db.insert(s.sets).values(
			[1, 2, 3].map((i) => ({
				userId: f.userId,
				sessionId: run.sessionId,
				exerciseId: f.exercise.id,
				gymEquipmentId: f.machine.id,
				loadConvention: 'plates_per_side' as const,
				position: source.position,
				setRole: source.setRole,
				executedLoad: 60,
				executedReps: 10,
				loggedAt: new Date(1780000000000 + i * 1000)
			}))
		);
		await endSession(db, f.userId, run.sessionId);
		expect(
			await computeConsecutiveBackwards(
				db,
				f.userId,
				f.exercise.id,
				source.setRole,
				source.position,
				10,
				{
					gymEquipmentId: f.machine.id,
					loadConvention: 'plates_per_side'
				}
			)
		).toBe(0);
	});
	it('uses machine-specific warmups and all working slots without leaking partial or deleted sessions', async () => {
		const f = await fixture();
		const [dx] = await db.select().from(s.dayExercises).where(eq(s.dayExercises.dayId, f.day.id));
		await db
			.insert(s.prescribedSets)
			.values({ dayExerciseId: dx.id, position: 3, setRole: 'warmup', initialLoad: 20 });
		let run = await start(f.userId, f.day.id);
		await bindSessionMachine(
			db,
			f.userId,
			run.sessionId,
			run.occurrence.id,
			binding(f.gym.id, f.machine.id)
		);
		await log(f.userId, run.sessionId, 60);
		run = await start(f.userId, f.day.id);
		await bindSessionMachine(
			db,
			f.userId,
			run.sessionId,
			run.occurrence.id,
			binding(f.gym.id, f.machine.id)
		);
		let rows = await db.select().from(s.sets).where(eq(s.sets.sessionId, run.sessionId));
		expect(rows.find((r) => r.setRole === 'warmup')?.prescribedLoad).toBe(60);
		expect(rows.find((r) => r.setRole === 'warmup')?.suggestionReasoning).toBeNull();
		await log(f.userId, run.sessionId, 65, 8);
		run = await start(f.userId, f.day.id);
		await bindSessionMachine(
			db,
			f.userId,
			run.sessionId,
			run.occurrence.id,
			binding(f.gym.id, f.machine.id)
		);
		rows = await db.select().from(s.sets).where(eq(s.sets.sessionId, run.sessionId));
		expect(rows.filter((r) => r.setRole === 'working').map((r) => r.prescribedLoad)).toEqual([
			65, 65
		]);
		// Open fully populated rows are not history.
		await db
			.update(s.sets)
			.set({ executedLoad: 500, executedReps: 10 })
			.where(eq(s.sets.sessionId, run.sessionId));
		const identity = { gymEquipmentId: f.machine.id, loadConvention: 'plates_per_side' as const };
		expect(
			(await getLastCompletedSet(db, f.userId, f.exercise.id, 'working', 1, undefined, identity))
				?.executedLoad
		).toBe(65);
		await endSession(db, f.userId, run.sessionId);
		await db
			.update(s.sessions)
			.set({ deletedAt: new Date() })
			.where(eq(s.sessions.id, run.sessionId));
		expect(
			(await getLastCompletedSet(db, f.userId, f.exercise.id, 'working', 1, undefined, identity))
				?.executedLoad
		).toBe(65);
	});
	it('keeps combo exercise histories independent and records lower-body increment metadata', async () => {
		const f = await fixture();
		let run = await start(f.userId, f.day.id);
		const input = {
			exerciseName: 'Combo squat',
			equipmentType: 'machine-plate',
			gymId: f.gym.id,
			gymEquipmentId: f.machine.id,
			loadConvention: 'per_arm',
			setCount: 2,
			repsMin: 8,
			repsMax: 10,
			rir: 1,
			tier: 'secondary',
			progressionPolicy: 'standard',
			isLowerBody: '1'
		};
		const squat = await addSessionExercise(db, f.userId, run.sessionId, input);
		const [exercise] = await db
			.select()
			.from(s.exercises)
			.where(eq(s.exercises.id, squat.exerciseId));
		expect(exercise.isLowerBody).toBe(true);
		await log(f.userId, run.sessionId, 70);
		run = await start(f.userId, f.day.id);
		const next = await addSessionExercise(db, f.userId, run.sessionId, {
			...input,
			exerciseId: squat.exerciseId
		});
		const nextRows = await db.select().from(s.sets).where(eq(s.sets.sessionExerciseId, next.id));
		expect(nextRows.map((r) => r.prescribedLoad)).toEqual([80, 80]);
		const press = await addSessionExercise(db, f.userId, run.sessionId, {
			...input,
			exerciseId: f.exercise.id
		});
		const pressRows = await db.select().from(s.sets).where(eq(s.sets.sessionExerciseId, press.id));
		expect(pressRows.every((r) => r.prescribedLoad === null)).toBe(true);
		const mappings = await db.select().from(s.exerciseEquipmentMap);
		expect(mappings).toHaveLength(2);
	});
	it('separates same-model machines at different gyms, conventions, and legacy history', async () => {
		const f = await fixture();
		let run = await start(f.userId, f.day.id);
		await log(f.userId, run.sessionId, 200);
		run = await start(f.userId, f.day.id);
		await bindSessionMachine(
			db,
			f.userId,
			run.sessionId,
			run.occurrence.id,
			binding(f.gym.id, f.machine.id)
		);
		let rows = await db.select().from(s.sets).where(eq(s.sets.sessionId, run.sessionId));
		expect(rows.map((r) => r.prescribedLoad)).toEqual([null, null]);
		await log(f.userId, run.sessionId, 60);
		run = await start(f.userId, f.day.id);
		await bindSessionMachine(
			db,
			f.userId,
			run.sessionId,
			run.occurrence.id,
			binding(f.gymB.id, f.machineB.id)
		);
		rows = await db.select().from(s.sets).where(eq(s.sets.sessionId, run.sessionId));
		expect(rows.map((r) => r.prescribedLoad)).toEqual([null, null]);
		await log(f.userId, run.sessionId, 120);
		run = await start(f.userId, f.day.id);
		await bindSessionMachine(
			db,
			f.userId,
			run.sessionId,
			run.occurrence.id,
			binding(f.gym.id, f.machine.id, 'total_plates')
		);
		rows = await db.select().from(s.sets).where(eq(s.sets.sessionId, run.sessionId));
		expect(rows.map((r) => r.prescribedLoad)).toEqual([null, null]);
		await log(f.userId, run.sessionId, 103);
		run = await start(f.userId, f.day.id);
		await bindSessionMachine(
			db,
			f.userId,
			run.sessionId,
			run.occurrence.id,
			binding(f.gym.id, f.machine.id)
		);
		rows = await db.select().from(s.sets).where(eq(s.sets.sessionId, run.sessionId));
		expect(rows.map((r) => r.prescribedLoad)).toEqual([65, 65]);
		expect(rows.every((r) => r.suggestionReasoning?.includes('all working sets'))).toBe(true);
		expect(
			(await getLastCompletedSet(db, f.userId, f.exercise.id, 'working', 1))?.executedLoad
		).toBe(200);
	});
	it('snapshots labels and refuses machine changes after any logged value', async () => {
		const f = await fixture();
		const run = await start(f.userId, f.day.id);
		await bindSessionMachine(
			db,
			f.userId,
			run.sessionId,
			run.occurrence.id,
			binding(f.gym.id, f.machine.id)
		);
		const [row] = await db.select().from(s.sets).where(eq(s.sets.sessionId, run.sessionId));
		await updateSetInSession(db, f.userId, run.sessionId, row.id, {
			executedLoad: 60,
			executedReps: 10,
			executedRir: 1,
			notes: '',
			expectedIdentity: `${row.gymEquipmentId}:${row.loadConvention}`
		});
		await expect(
			bindSessionMachine(
				db,
				f.userId,
				run.sessionId,
				run.occurrence.id,
				binding(f.gymB.id, f.machineB.id)
			)
		).rejects.toThrow(/logged/i);
		await db
			.update(s.gymEquipment)
			.set({ localLabel: 'Renamed', equipmentModelId: null })
			.where(eq(s.gymEquipment.id, f.machine.id));
		const [occ] = await db
			.select()
			.from(s.sessionExercises)
			.where(eq(s.sessionExercises.id, run.occurrence.id));
		expect(occ.machineLabel).toBe('Press A');
		expect(occ.modelName).toContain('Combo');
		expect(row.gymEquipmentId).toBe(f.machine.id);
	});
	it('quick-adds an unknown model without changing the program and separates combo exercises', async () => {
		const f = await fixture();
		const run = await start(f.userId, f.day.id);
		const machine = await createMachine(db, f.userId, {
			gymId: f.gym.id,
			localLabel: 'Unknown combo',
			equipmentType: 'machine-stack'
		});
		expect(machine.equipmentModelId).toBeNull();
		const occ = await addSessionExercise(db, f.userId, run.sessionId, {
			exerciseName: 'Row',
			canonicalMovement: 'row',
			equipmentType: 'machine-stack',
			gymId: f.gym.id,
			gymEquipmentId: machine.id,
			loadConvention: 'displayed',
			setCount: 2,
			repsMin: 8,
			repsMax: 12,
			rir: 1,
			tier: 'secondary',
			progressionPolicy: 'standard'
		});
		expect(occ.exerciseName).toBe('Row');
		const rows = await db.select().from(s.sets).where(eq(s.sets.sessionExerciseId, occ.id));
		expect(rows).toHaveLength(2);
		expect(rows.every((r) => r.prescribedLoad === null)).toBe(true);
		expect(await db.select().from(s.dayExercises)).toHaveLength(1);
		expect(await db.select().from(s.prescribedSets)).toHaveLength(2);
		expect(await db.select().from(s.programs)).toHaveLength(1);
	});
	it('rejects invalid input, wrong gym, wrong occurrence, and ended-session mutation', async () => {
		const f = await fixture();
		const run = await start(f.userId, f.day.id);
		await expect(createGym(db, f.userId, { name: '  ' })).rejects.toThrow();
		await expect(
			createMachine(db, f.userId, { gymId: f.gym.id, localLabel: 'X', equipmentType: 'bogus' })
		).rejects.toThrow();
		await expect(
			bindSessionMachine(
				db,
				f.userId,
				run.sessionId,
				run.occurrence.id,
				binding(f.gymB.id, f.machine.id)
			)
		).rejects.toThrow(/gym/i);
		await expect(
			bindSessionMachine(
				db,
				f.userId,
				run.sessionId,
				crypto.randomUUID(),
				binding(f.gym.id, f.machine.id)
			)
		).rejects.toThrow(/not found/i);
		await expect(
			bindSessionMachine(db, f.userId, run.sessionId, run.occurrence.id, {
				...binding(f.gym.id, f.machine.id),
				confirm: ''
			})
		).rejects.toThrow();
		await bindSessionMachine(
			db,
			f.userId,
			run.sessionId,
			run.occurrence.id,
			binding(f.gym.id, f.machine.id)
		);
		const [row] = await db.select().from(s.sets).where(eq(s.sets.sessionId, run.sessionId));
		const stale = await updateSetInSession(db, f.userId, run.sessionId, row.id, {
			executedLoad: 90,
			executedReps: 10,
			executedRir: 1,
			notes: '',
			expectedIdentity: 'legacy:legacy'
		});
		expect(stale.ok).toBe(false);
		const [unchanged] = await db.select().from(s.sets).where(eq(s.sets.id, row.id));
		expect(unchanged.executedLoad).toBeNull();
		await expect(
			addSessionExercise(db, f.userId, run.sessionId, { exerciseName: 'Bad', setCount: -1 })
		).rejects.toThrow();
		await endSession(db, f.userId, run.sessionId);
		await expect(
			bindSessionMachine(
				db,
				f.userId,
				run.sessionId,
				run.occurrence.id,
				binding(f.gym.id, f.machine.id)
			)
		).rejects.toThrow(/ended/i);
	});
	it('holds legacy backoff rows on non-main tiers instead of advancing them per-row (M1)', async () => {
		const f = await fixture();
		const ident = `${f.machine.id}:plates_per_side`;
		const backoffValues = {
			exerciseId: f.exercise.id,
			gymEquipmentId: f.machine.id,
			loadConvention: 'plates_per_side' as const,
			position: 3,
			setRole: 'backoff' as const,
			prescribedRepsMin: 8,
			prescribedRepsMax: 10,
			prescribedRir: 1
		};

		// Session 1: bind the machine, add a legacy backoff row, then log a
		// mixed session — working position 2 fails (so the group holds at 135)
		// while the backoff row clears its own 8–10 range at 95.
		let run = await start(f.userId, f.day.id);
		const [backoff1] = await db
			.insert(s.sets)
			.values({
				userId: f.userId,
				sessionId: run.sessionId,
				sessionExerciseId: run.occurrence.id,
				...backoffValues
			})
			.returning();
		await bindSessionMachine(
			db,
			f.userId,
			run.sessionId,
			run.occurrence.id,
			binding(f.gym.id, f.machine.id)
		);
		const working1 = await db
			.select()
			.from(s.sets)
			.where(and(eq(s.sets.sessionId, run.sessionId), eq(s.sets.setRole, 'working')))
			.orderBy(asc(s.sets.position));
		const logRow = (id: string, load: number, reps: number, rir: number) =>
			updateSetInSession(db, f.userId, run.sessionId, id, {
				executedLoad: load,
				executedReps: reps,
				executedRir: rir,
				notes: '',
				expectedIdentity: ident
			});
		await logRow(working1[0].id, 135, 8, 1);
		await logRow(working1[1].id, 135, 6, 3);
		await logRow(backoff1.id, 95, 10, 1);
		await endSession(db, f.userId, run.sessionId);

		// Session 2: re-binding re-runs prefillOccurrence against that history.
		run = await start(f.userId, f.day.id);
		await db.insert(s.sets).values({
			userId: f.userId,
			sessionId: run.sessionId,
			sessionExerciseId: run.occurrence.id,
			...backoffValues
		});
		await bindSessionMachine(
			db,
			f.userId,
			run.sessionId,
			run.occurrence.id,
			binding(f.gym.id, f.machine.id)
		);
		const rows = await db
			.select({
				position: s.sets.position,
				setRole: s.sets.setRole,
				prescribedLoad: s.sets.prescribedLoad,
				suggestionReasoning: s.sets.suggestionReasoning
			})
			.from(s.sets)
			.where(eq(s.sets.sessionId, run.sessionId))
			.orderBy(asc(s.sets.position));

		// Pre-fix the clearing backoff row advanced 95 → 100 on its own.
		expect(rows).toEqual([
			{
				position: 1,
				setRole: 'working',
				prescribedLoad: 135,
				suggestionReasoning: 'held: not all working sets cleared top of range'
			},
			{
				position: 2,
				setRole: 'working',
				prescribedLoad: 135,
				suggestionReasoning: 'held: not all working sets cleared top of range'
			},
			{
				position: 3,
				setRole: 'backoff',
				prescribedLoad: 95,
				suggestionReasoning: 'held: no progression rule applies to this set'
			}
		]);
	});
	it('gives MAIN quick-add cold starts null reasoning, not missing-history text (L7)', async () => {
		const f = await fixture();
		const run = await start(f.userId, f.day.id);
		const machine = await createMachine(db, f.userId, {
			gymId: f.gym.id,
			localLabel: 'Cold bench',
			equipmentType: 'barbell'
		});
		const occ = await addSessionExercise(db, f.userId, run.sessionId, {
			exerciseName: 'Bench Press',
			equipmentType: 'barbell',
			gymId: f.gym.id,
			gymEquipmentId: machine.id,
			loadConvention: 'unknown',
			setCount: 2,
			repsMin: 5,
			repsMax: 5,
			rir: 2,
			tier: 'main',
			progressionPolicy: 'standard',
			isLowerBody: false
		});
		const rows = await db
			.select({
				position: s.sets.position,
				setRole: s.sets.setRole,
				prescribedLoad: s.sets.prescribedLoad,
				suggestionReasoning: s.sets.suggestionReasoning
			})
			.from(s.sets)
			.where(eq(s.sets.sessionExerciseId, occ.id))
			.orderBy(asc(s.sets.position));
		// Cold start: no history anywhere, so there is no provenance to
		// report — null load pairs with null reasoning, matching the
		// sessions.ts cold-start path.
		expect(rows).toEqual([
			{ position: 1, setRole: 'top', prescribedLoad: null, suggestionReasoning: null },
			{ position: 2, setRole: 'backoff', prescribedLoad: null, suggestionReasoning: null }
		]);
	});
	it('reserves the missing-history text for genuinely ambiguous MAIN history (L7)', async () => {
		const f = await fixture();
		const machine = await createMachine(db, f.userId, {
			gymId: f.gym.id,
			localLabel: 'Ambiguous bench',
			equipmentType: 'barbell'
		});
		const input = {
			exerciseName: 'Incline Press',
			equipmentType: 'barbell',
			gymId: f.gym.id,
			gymEquipmentId: machine.id,
			loadConvention: 'unknown' as const,
			setCount: 2,
			repsMin: 5,
			repsMax: 5,
			rir: 2,
			tier: 'main' as const,
			progressionPolicy: 'standard' as const,
			isLowerBody: false
		};
		// Session 1: log ONLY the backoff row — the top set has no history.
		let run = await start(f.userId, f.day.id);
		const first = await addSessionExercise(db, f.userId, run.sessionId, input);
		const firstRows = await db
			.select()
			.from(s.sets)
			.where(eq(s.sets.sessionExerciseId, first.id))
			.orderBy(asc(s.sets.position));
		const backoff = firstRows.find((r) => r.setRole === 'backoff')!;
		await updateSetInSession(db, f.userId, run.sessionId, backoff.id, {
			executedLoad: 95,
			executedReps: 10,
			executedRir: 1,
			notes: '',
			expectedIdentity: `${machine.id}:unknown`
		});
		await endSession(db, f.userId, run.sessionId);

		// Session 2: the backoff has a real load but no usable top-set
		// decision — that is the genuinely ambiguous case.
		run = await start(f.userId, f.day.id);
		const second = await addSessionExercise(db, f.userId, run.sessionId, {
			...input,
			exerciseId: first.exerciseId
		});
		const rows = await db
			.select({
				position: s.sets.position,
				setRole: s.sets.setRole,
				prescribedLoad: s.sets.prescribedLoad,
				suggestionReasoning: s.sets.suggestionReasoning
			})
			.from(s.sets)
			.where(eq(s.sets.sessionExerciseId, second.id))
			.orderBy(asc(s.sets.position));
		expect(rows).toEqual([
			{ position: 1, setRole: 'top', prescribedLoad: null, suggestionReasoning: null },
			{
				position: 2,
				setRole: 'backoff',
				prescribedLoad: 95,
				suggestionReasoning: 'held: missing or ambiguous MAIN top-set history'
			}
		]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Cross-tenant isolation.
//
// Each case asserts that another user's id behaves EXACTLY like a nonexistent
// one — the same error, from the same query, with the owner in the WHERE rather
// than in a check that could pass a moment before the row changed. Nothing here
// looks at HTTP status codes; D6 is about the module's own result.
// ─────────────────────────────────────────────────────────────────────────────
// 0.3.2: the label is optional when the machine has a model to be named after.
describe('optional machine label', () => {
	async function setup() {
		const userId = await createTestUser(db, 'label');
		const gym = await createGym(db, userId, { name: 'Label Gym' });
		const [coded] = await db
			.insert(s.equipmentModels)
			.values({
				manufacturer: 'Hammer Strength',
				code: 'IL-ROW',
				name: 'Iso-Lateral Row',
				loadingType: 'machine-plate'
			})
			.returning();
		const [codeless] = await db
			.insert(s.equipmentModels)
			.values({ manufacturer: 'Nautilus', name: 'Leverage Row', loadingType: 'machine-plate' })
			.returning();
		const labels = async () =>
			(await db.select().from(s.gymEquipment).where(eq(s.gymEquipment.gymId, gym.id))).map(
				(m) => m.localLabel
			);
		return { userId, gym, coded, codeless, labels };
	}

	it('blank label with a chosen model stores "<manufacturer> <name> (<code>)"', async () => {
		const f = await setup();
		const a = await createMachine(db, f.userId, {
			gymId: f.gym.id,
			localLabel: '',
			equipmentType: 'machine-plate',
			equipmentModelId: f.coded.id
		});
		const b = await createMachine(db, f.userId, {
			gymId: f.gym.id,
			localLabel: '   ',
			equipmentType: 'machine-plate',
			equipmentModelId: f.codeless.id
		});
		const [ra] = await db.select().from(s.gymEquipment).where(eq(s.gymEquipment.id, a.id));
		const [rb] = await db.select().from(s.gymEquipment).where(eq(s.gymEquipment.id, b.id));
		expect(ra).toMatchObject({
			localLabel: 'Hammer Strength Iso-Lateral Row (IL-ROW)',
			equipmentModelId: f.coded.id
		});
		expect(rb.localLabel).toBe('Nautilus Leverage Row');
	});

	it('blank label with a typed-in model is named after that model', async () => {
		const f = await setup();
		const made = await createMachine(db, f.userId, {
			gymId: f.gym.id,
			equipmentType: 'machine-stack',
			manufacturer: 'Cybex',
			modelName: 'Arm Curl'
		});
		expect(made.localLabel).toBe('Cybex Arm Curl');
		expect(made.equipmentModelId).not.toBeNull();
	});

	it('blank label and no model is refused with the message, and nothing is written', async () => {
		const f = await setup();
		await expect(
			createMachine(db, f.userId, {
				gymId: f.gym.id,
				localLabel: '',
				equipmentType: 'machine-plate'
			})
		).rejects.toThrow(LABEL_REQUIRED_MESSAGE);
		await expect(
			createMachine(db, f.userId, { gymId: f.gym.id, equipmentType: 'cable' })
		).rejects.toThrow(LABEL_REQUIRED_MESSAGE);
		expect(await f.labels()).toEqual([]);
	});

	it('an explicit label wins over the model', async () => {
		const f = await setup();
		await createMachine(db, f.userId, {
			gymId: f.gym.id,
			localLabel: 'Row by the window',
			equipmentType: 'machine-plate',
			equipmentModelId: f.coded.id
		});
		expect(await f.labels()).toEqual(['Row by the window']);
	});

	it("another user's model gives no label and no machine", async () => {
		const f = await setup();
		const bob = await createTestUser(db, 'label-bob');
		const [bobs] = await db
			.insert(s.equipmentModels)
			.values({
				manufacturer: 'Secret',
				name: 'Bob only',
				loadingType: 'machine-plate',
				ownerUserId: bob
			})
			.returning();
		await expect(
			createMachine(db, f.userId, {
				gymId: f.gym.id,
				localLabel: '',
				equipmentType: 'machine-plate',
				equipmentModelId: bobs.id
			})
		).rejects.toThrow('Model loading type does not match machine');
		expect(await f.labels()).toEqual([]);
	});
});

describe('cross-tenant isolation', () => {
	it('machineChoices shows each user only their own gyms, machines, and exercises', async () => {
		const f = await fixture();
		const { bob } = await withTwoUsers(db);

		const alice = await machineChoices(db, f.userId);
		expect(alice.gyms.map((g) => g.name).sort()).toEqual(['Gym A', 'Gym B']);
		expect(alice.machines.map((m) => m.localLabel).sort()).toEqual(['Press A', 'Press B']);
		expect(alice.exercises.map((e) => e.name)).toEqual(['Press']);
		// The global model (owner_user_id NULL) is shared.
		expect((await modelChoices(db, f.userId, { all: true })).models.map((m) => m.name)).toEqual([
			'Combo'
		]);

		const bobsView = await machineChoices(db, bob);
		expect(bobsView.gyms).toHaveLength(0);
		expect(bobsView.machines).toHaveLength(0);
		expect(bobsView.exercises).toHaveLength(0);
		// …but a global model is still visible to them.
		expect((await modelChoices(db, bob, { all: true })).models.map((m) => m.name)).toEqual([
			'Combo'
		]);
	});

	it("another user's gym is invisible to machineChoices", async () => {
		const f = await fixture();
		const { bob } = await withTwoUsers(db);
		const bobs = await machineChoices(db, bob);
		expect(bobs.gyms.some((g) => g.id === f.gym.id)).toBe(false);
	});

	it("another user's exerciseId is not found", async () => {
		const f = await fixture();
		const { bob } = await withTwoUsers(db);
		const run = await start(f.userId, f.day.id);
		await expect(
			addSessionExercise(db, bob, run.sessionId, {
				exerciseId: f.exercise.id,
				equipmentType: 'machine-plate',
				gymId: f.gym.id,
				gymEquipmentId: f.machine.id,
				loadConvention: 'plates_per_side',
				setCount: 2,
				repsMin: 8,
				repsMax: 10,
				rir: 1,
				tier: 'secondary',
				progressionPolicy: 'standard'
			})
		).rejects.toThrow('Session not found');
	});

	it("another user's gymEquipmentId is not found", async () => {
		const f = await fixture();
		const { bob } = await withTwoUsers(db);
		// Bob starts a session on Bob's own day, so the failure under test is
		// about the MACHINE and not the session — otherwise this would pass for
		// the wrong reason.
		const bobsDay = await dayFor(bob);
		const bobsRun = await start(bob, bobsDay.id);
		await expect(
			bindSessionMachine(
				db,
				bob,
				bobsRun.sessionId,
				bobsRun.occurrence.id,
				binding(f.gym.id, f.machine.id)
			)
		).rejects.toThrow('Machine not found in selected gym');
		// And the same call with a genuinely absent id gives the same error.
		await expect(
			bindSessionMachine(
				db,
				bob,
				bobsRun.sessionId,
				bobsRun.occurrence.id,
				binding(f.gym.id, crypto.randomUUID())
			)
		).rejects.toThrow('Machine not found in selected gym');
	});

	it("another user's gymId is not found by createMachine", async () => {
		const f = await fixture();
		const { bob } = await withTwoUsers(db);
		await expect(
			createMachine(db, bob, {
				gymId: f.gym.id,
				localLabel: 'Trespass',
				equipmentType: 'machine-plate'
			})
		).rejects.toThrow('Gym not found');
	});

	it("another user's equipmentModelId is refused, a global one is accepted", async () => {
		const f = await fixture();
		const { bob } = await withTwoUsers(db);
		// A model owned by Alice (f.machine was built with f's userId).
		const [alicesModel] = await db
			.insert(s.equipmentModels)
			.values({
				manufacturer: 'Alice',
				name: 'Alice model',
				loadingType: 'machine-plate',
				ownerUserId: f.userId
			})
			.returning();
		const bobsGym = await createGym(db, bob, { name: 'Bob Gym' });

		await expect(
			createMachine(db, bob, {
				gymId: bobsGym.id,
				localLabel: 'X',
				equipmentType: 'machine-plate',
				equipmentModelId: alicesModel.id
			})
		).rejects.toThrow('Model loading type does not match machine');

		// A global model (owner_user_id NULL) still works for Bob.
		const [global] = await db
			.insert(s.equipmentModels)
			.values({ manufacturer: 'Global', name: 'Global model', loadingType: 'machine-plate' })
			.returning();
		const made = await createMachine(db, bob, {
			gymId: bobsGym.id,
			localLabel: 'Fine',
			equipmentType: 'machine-plate',
			equipmentModelId: global.id
		});
		expect(made.equipmentModelId).toBe(global.id);
	});

	it('a new model from createMachine is owned by its creator', async () => {
		const f = await fixture();
		const { bob } = await withTwoUsers(db);
		await createMachine(db, bob, {
			gymId: f.gym.id,
			localLabel: 'Nope',
			equipmentType: 'machine-plate'
		}).catch(() => undefined);
		const bobsGym = await createGym(db, bob, { name: 'Bob Gym 2' });
		await createMachine(db, bob, {
			gymId: bobsGym.id,
			localLabel: 'New model',
			equipmentType: 'machine-plate',
			manufacturer: 'Bob',
			modelName: 'B-1'
		});
		const [model] = await db
			.select()
			.from(s.equipmentModels)
			.where(eq(s.equipmentModels.name, 'B-1'));
		expect(model.ownerUserId).toBe(bob);
	});

	// Was SKIPPED until 0010_drop_exercise_name_unique landed with the
	// program-builder.ts commit. It used to be unreachable: `exercises` carried
	// the global UNIQUE(name) from 0001, which 0009 kept because
	// program-builder.ts quick-add did onConflictDoNothing({ target:
	// exercises.name }). program-builder.ts was the last caller needing it, and
	// this test goes live in the commit that removes that call.
	it('a second user may reuse an exercise name and gets their own row', async () => {
		const f = await fixture();
		const { bob } = await withTwoUsers(db);
		const bobsGym = await createGym(db, bob, { name: 'Bob Gym 3' });
		const bobsMachine = await createMachine(db, bob, {
			gymId: bobsGym.id,
			localLabel: 'Bob press',
			equipmentType: 'machine-plate'
		});
		const bobsDay = await dayFor(bob);
		const run = await start(bob, bobsDay.id);

		// "Press" already exists, owned by Alice. Bob naming his exercise the
		// same must succeed with Bob's own row — not hit a global duplicate
		// guard, and not be refused by the module's own per-user one.
		const occ = await addSessionExercise(db, bob, run.sessionId, {
			exerciseName: 'Press',
			equipmentType: 'machine-plate',
			gymId: bobsGym.id,
			gymEquipmentId: bobsMachine.id,
			loadConvention: 'plates_per_side',
			setCount: 2,
			repsMin: 8,
			repsMax: 10,
			rir: 1,
			tier: 'secondary',
			progressionPolicy: 'standard'
		});
		const [exercise] = await db
			.select()
			.from(s.exercises)
			.where(eq(s.exercises.id, occ.exerciseId));
		expect(exercise.userId).toBe(bob);
		expect(exercise.name).toBe('Press');
		// Both rows survive, one per user.
		expect(await db.select().from(s.exercises).where(eq(s.exercises.name, 'Press'))).toHaveLength(
			2
		);
	});

	// The module's own duplicate-name guard is scoped to the caller, so Bob
	// reusing HIS OWN name is refused by machines.ts, with the module's message
	// rather than a database error.
	it("refuses a duplicate name only against the same user's own rows", async () => {
		const f = await fixture();
		const { bob } = await withTwoUsers(db);
		const bobsGym = await createGym(db, bob, { name: 'Bob Gym 4' });
		const bobsMachine = await createMachine(db, bob, {
			gymId: bobsGym.id,
			localLabel: 'Bob press',
			equipmentType: 'machine-plate'
		});
		const bobsDay = await dayFor(bob);
		const run = await start(bob, bobsDay.id);
		const input = {
			exerciseName: 'Bob own lift',
			equipmentType: 'machine-plate',
			gymId: bobsGym.id,
			gymEquipmentId: bobsMachine.id,
			loadConvention: 'plates_per_side' as const,
			setCount: 2,
			repsMin: 8,
			repsMax: 10,
			rir: 1,
			tier: 'secondary' as const,
			progressionPolicy: 'standard' as const
		};
		await addSessionExercise(db, bob, run.sessionId, input);
		await expect(addSessionExercise(db, bob, run.sessionId, input)).rejects.toThrow(
			'Exercise name already exists; select it from the list'
		);
	});

	it("another user's sessionId is not found by addSessionExercise", async () => {
		const f = await fixture();
		const { bob } = await withTwoUsers(db);
		const run = await start(f.userId, f.day.id);
		await expect(
			addSessionExercise(db, bob, run.sessionId, {
				exerciseName: 'Bob lift',
				equipmentType: 'machine-plate',
				gymId: f.gym.id,
				gymEquipmentId: f.machine.id,
				loadConvention: 'plates_per_side',
				setCount: 2,
				repsMin: 8,
				repsMax: 10,
				rir: 1,
				tier: 'secondary',
				progressionPolicy: 'standard'
			})
		).rejects.toThrow('Session not found');
	});

	it("another user's sessionId is not found by bindSessionMachine", async () => {
		const f = await fixture();
		const { bob } = await withTwoUsers(db);
		const run = await start(f.userId, f.day.id);
		await expect(
			bindSessionMachine(db, bob, run.sessionId, run.occurrence.id, binding(f.gym.id, f.machine.id))
		).rejects.toThrow('Session not found');
	});

	it('createGym writes the caller as owner', async () => {
		const { alice } = await withTwoUsers(db);
		const gym = await createGym(db, alice, { name: 'Owned' });
		expect(gym.userId).toBe(alice);
	});
});
