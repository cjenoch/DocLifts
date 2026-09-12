import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { setupTestDb, resetTestDb, type TestDb } from './test-db';
import * as s from './db/schema';
import { createGym, createMachine, addSessionExercise, bindSessionMachine } from './machines';
import { startSessionForDay, endSession, updateSetInSession, nextSetIdInSession } from './sessions';
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
async function fixture() {
	const [program] = await db.insert(s.programs).values({ name: 'Pilot' }).returning();
	const [day] = await db
		.insert(s.days)
		.values({ programId: program.id, name: 'Day', position: 1 })
		.returning();
	const [exercise] = await db
		.insert(s.exercises)
		.values({ name: 'Press', canonicalMovement: 'chest_press', equipmentType: 'machine-plate' })
		.returning();
	const [dx] = await db
		.insert(s.dayExercises)
		.values({ dayId: day.id, exerciseId: exercise.id, position: 1, tier: 'secondary' })
		.returning();
	await db
		.insert(s.prescribedSets)
		.values(
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
	const gym = await createGym(db, { name: 'Gym A' });
	const gymB = await createGym(db, { name: 'Gym B' });
	const [model] = await db
		.insert(s.equipmentModels)
		.values({ manufacturer: 'User supplied', name: 'Combo', loadingType: 'machine-plate' })
		.returning();
	const machine = await createMachine(db, {
		gymId: gym.id,
		localLabel: 'Press A',
		equipmentType: 'machine-plate',
		equipmentModelId: model.id
	});
	const machineB = await createMachine(db, {
		gymId: gymB.id,
		localLabel: 'Press B',
		equipmentType: 'machine-plate',
		equipmentModelId: model.id
	});
	return { day, exercise, gym, gymB, machine, machineB, program };
}
async function start(dayId: string) {
	const result = await startSessionForDay(db, dayId);
	if (!result.ok) throw new Error(result.message);
	const [occurrence] = await db
		.select()
		.from(s.sessionExercises)
		.where(eq(s.sessionExercises.sessionId, result.sessionId));
	return { sessionId: result.sessionId, occurrence };
}
async function log(sessionId: string, load: number, reps = 10) {
	const rows = await db.select().from(s.sets).where(eq(s.sets.sessionId, sessionId));
	for (const row of rows)
		await updateSetInSession(db, sessionId, row.id, {
			executedLoad: load,
			executedReps: reps,
			executedRir: 1,
			notes: '',
			expectedIdentity: `${row.gymEquipmentId ?? 'legacy'}:${row.loadConvention}`
		});
	await endSession(db, sessionId);
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
		const run = await start(f.day.id);
		await bindSessionMachine(db, run.sessionId, run.occurrence.id, binding(f.gym.id, f.machine.id));
		const [source] = await db.select().from(s.sets).where(eq(s.sets.sessionId, run.sessionId));
		await db
			.insert(s.sets)
			.values(
				[1, 2, 3].map((i) => ({
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
		await endSession(db, run.sessionId);
		expect(
			await computeConsecutiveBackwards(db, f.exercise.id, source.setRole, source.position, 10, {
				gymEquipmentId: f.machine.id,
				loadConvention: 'plates_per_side'
			})
		).toBe(0);
	});
	it('uses machine-specific warmups and all working slots without leaking partial or deleted sessions', async () => {
		const f = await fixture();
		const [dx] = await db.select().from(s.dayExercises).where(eq(s.dayExercises.dayId, f.day.id));
		await db
			.insert(s.prescribedSets)
			.values({ dayExerciseId: dx.id, position: 3, setRole: 'warmup', initialLoad: 20 });
		let run = await start(f.day.id);
		await bindSessionMachine(db, run.sessionId, run.occurrence.id, binding(f.gym.id, f.machine.id));
		await log(run.sessionId, 60);
		run = await start(f.day.id);
		await bindSessionMachine(db, run.sessionId, run.occurrence.id, binding(f.gym.id, f.machine.id));
		let rows = await db.select().from(s.sets).where(eq(s.sets.sessionId, run.sessionId));
		expect(rows.find((r) => r.setRole === 'warmup')?.prescribedLoad).toBe(60);
		expect(rows.find((r) => r.setRole === 'warmup')?.suggestionReasoning).toBeNull();
		await log(run.sessionId, 65, 8);
		run = await start(f.day.id);
		await bindSessionMachine(db, run.sessionId, run.occurrence.id, binding(f.gym.id, f.machine.id));
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
			(await getLastCompletedSet(db, f.exercise.id, 'working', 1, undefined, identity))
				?.executedLoad
		).toBe(65);
		await endSession(db, run.sessionId);
		await db
			.update(s.sessions)
			.set({ deletedAt: new Date() })
			.where(eq(s.sessions.id, run.sessionId));
		expect(
			(await getLastCompletedSet(db, f.exercise.id, 'working', 1, undefined, identity))
				?.executedLoad
		).toBe(65);
	});
	it('keeps combo exercise histories independent and records lower-body increment metadata', async () => {
		const f = await fixture();
		let run = await start(f.day.id);
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
		const squat = await addSessionExercise(db, run.sessionId, input);
		const [exercise] = await db
			.select()
			.from(s.exercises)
			.where(eq(s.exercises.id, squat.exerciseId));
		expect(exercise.isLowerBody).toBe(true);
		await log(run.sessionId, 70);
		run = await start(f.day.id);
		const next = await addSessionExercise(db, run.sessionId, {
			...input,
			exerciseId: squat.exerciseId
		});
		const nextRows = await db.select().from(s.sets).where(eq(s.sets.sessionExerciseId, next.id));
		expect(nextRows.map((r) => r.prescribedLoad)).toEqual([80, 80]);
		const press = await addSessionExercise(db, run.sessionId, {
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
		let run = await start(f.day.id);
		await log(run.sessionId, 200);
		run = await start(f.day.id);
		await bindSessionMachine(db, run.sessionId, run.occurrence.id, binding(f.gym.id, f.machine.id));
		let rows = await db.select().from(s.sets).where(eq(s.sets.sessionId, run.sessionId));
		expect(rows.map((r) => r.prescribedLoad)).toEqual([null, null]);
		await log(run.sessionId, 60);
		run = await start(f.day.id);
		await bindSessionMachine(
			db,
			run.sessionId,
			run.occurrence.id,
			binding(f.gymB.id, f.machineB.id)
		);
		rows = await db.select().from(s.sets).where(eq(s.sets.sessionId, run.sessionId));
		expect(rows.map((r) => r.prescribedLoad)).toEqual([null, null]);
		await log(run.sessionId, 120);
		run = await start(f.day.id);
		await bindSessionMachine(
			db,
			run.sessionId,
			run.occurrence.id,
			binding(f.gym.id, f.machine.id, 'total_plates')
		);
		rows = await db.select().from(s.sets).where(eq(s.sets.sessionId, run.sessionId));
		expect(rows.map((r) => r.prescribedLoad)).toEqual([null, null]);
		await log(run.sessionId, 103);
		run = await start(f.day.id);
		await bindSessionMachine(db, run.sessionId, run.occurrence.id, binding(f.gym.id, f.machine.id));
		rows = await db.select().from(s.sets).where(eq(s.sets.sessionId, run.sessionId));
		expect(rows.map((r) => r.prescribedLoad)).toEqual([65, 65]);
		expect(rows.every((r) => r.suggestionReasoning?.includes('all working sets'))).toBe(true);
		expect((await getLastCompletedSet(db, f.exercise.id, 'working', 1))?.executedLoad).toBe(200);
	});
	it('snapshots labels and refuses machine changes after any logged value', async () => {
		const f = await fixture();
		const run = await start(f.day.id);
		await bindSessionMachine(db, run.sessionId, run.occurrence.id, binding(f.gym.id, f.machine.id));
		const [row] = await db.select().from(s.sets).where(eq(s.sets.sessionId, run.sessionId));
		await updateSetInSession(db, run.sessionId, row.id, {
			executedLoad: 60,
			executedReps: 10,
			executedRir: 1,
			notes: '',
			expectedIdentity: `${row.gymEquipmentId}:${row.loadConvention}`
		});
		await expect(
			bindSessionMachine(db, run.sessionId, run.occurrence.id, binding(f.gymB.id, f.machineB.id))
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
		const run = await start(f.day.id);
		const machine = await createMachine(db, {
			gymId: f.gym.id,
			localLabel: 'Unknown combo',
			equipmentType: 'machine-stack'
		});
		expect(machine.equipmentModelId).toBeNull();
		const occ = await addSessionExercise(db, run.sessionId, {
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
		expect(await nextSetIdInSession(db, run.sessionId, rows[0].id)).toBe(rows[1].id);
		expect(await db.select().from(s.dayExercises)).toHaveLength(1);
		expect(await db.select().from(s.prescribedSets)).toHaveLength(2);
		expect(await db.select().from(s.programs)).toHaveLength(1);
	});
	it('rejects invalid input, wrong gym, wrong occurrence, and ended-session mutation', async () => {
		const f = await fixture();
		const run = await start(f.day.id);
		await expect(createGym(db, { name: '  ' })).rejects.toThrow();
		await expect(
			createMachine(db, { gymId: f.gym.id, localLabel: 'X', equipmentType: 'bogus' })
		).rejects.toThrow();
		await expect(
			bindSessionMachine(db, run.sessionId, run.occurrence.id, binding(f.gymB.id, f.machine.id))
		).rejects.toThrow(/gym/i);
		await expect(
			bindSessionMachine(db, run.sessionId, crypto.randomUUID(), binding(f.gym.id, f.machine.id))
		).rejects.toThrow(/not found/i);
		await expect(
			bindSessionMachine(db, run.sessionId, run.occurrence.id, {
				...binding(f.gym.id, f.machine.id),
				confirm: ''
			})
		).rejects.toThrow();
		await bindSessionMachine(db, run.sessionId, run.occurrence.id, binding(f.gym.id, f.machine.id));
		const [row] = await db.select().from(s.sets).where(eq(s.sets.sessionId, run.sessionId));
		const stale = await updateSetInSession(db, run.sessionId, row.id, {
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
			addSessionExercise(db, run.sessionId, { exerciseName: 'Bad', setCount: -1 })
		).rejects.toThrow();
		await endSession(db, run.sessionId);
		await expect(
			bindSessionMachine(db, run.sessionId, run.occurrence.id, binding(f.gym.id, f.machine.id))
		).rejects.toThrow(/ended/i);
	});
});
