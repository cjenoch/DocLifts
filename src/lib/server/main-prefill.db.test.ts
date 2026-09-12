import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { setupTestDb, resetTestDb, type TestDb } from './test-db';
import * as s from './db/schema';
import { createGym, createMachine, bindSessionMachine, addSessionExercise } from './machines';
import { startSessionForDay, endSession, updateSetInSession } from './sessions';

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

async function fixture(bound: boolean, policy: 'standard' | 'cautious' | 'hold' = 'standard') {
	const [program] = await db.insert(s.programs).values({ name: 'MAIN regression' }).returning();
	const [day] = await db
		.insert(s.days)
		.values({ programId: program.id, name: 'Day', position: 1 })
		.returning();
	const [exercise] = await db
		.insert(s.exercises)
		.values({ name: 'Press', equipmentType: 'machine-stack' })
		.returning();
	const [dx] = await db
		.insert(s.dayExercises)
		.values({
			dayId: day.id,
			exerciseId: exercise.id,
			position: 1,
			tier: 'main',
			progressionPolicy: policy
		})
		.returning();
	await db.insert(s.prescribedSets).values(
		(['warmup', 'top', 'backoff'] as const).map((setRole, i) => ({
			dayExerciseId: dx.id,
			position: i + 1,
			setRole,
			targetRepsMin: 8,
			targetRepsMax: 10,
			targetRir: 1,
			initialLoad: [30, 50, 40][i]
		}))
	);
	const gym = await createGym(db, { name: 'Gym' });
	const machine = await createMachine(db, {
		gymId: gym.id,
		localLabel: 'Unknown press',
		equipmentType: 'machine-stack'
	});
	const binding = {
		gymId: gym.id,
		gymEquipmentId: machine.id,
		loadConvention: 'displayed',
		confirm: 'CHANGE'
	};
	async function start() {
		const result = await startSessionForDay(db, day.id);
		if (!result.ok) throw new Error(result.message);
		const [occurrence] = await db
			.select()
			.from(s.sessionExercises)
			.where(eq(s.sessionExercises.sessionId, result.sessionId));
		if (bound) await bindSessionMachine(db, result.sessionId, occurrence.id, binding);
		const rows = await db
			.select()
			.from(s.sets)
			.where(eq(s.sets.sessionId, result.sessionId))
			.orderBy(asc(s.sets.position));
		return { sessionId: result.sessionId, rows };
	}
	async function completed(
		topReps: number | null,
		backoffReps: number,
		topLoad = 100,
		backoffLoad = 80
	) {
		const run = await start();
		for (const row of run.rows) {
			if (row.setRole === 'top' && topReps === null) continue;
			const result = await updateSetInSession(db, run.sessionId, row.id, {
				executedLoad: row.setRole === 'warmup' ? 30 : row.setRole === 'top' ? topLoad : backoffLoad,
				executedReps:
					row.setRole === 'top' ? topReps! : row.setRole === 'backoff' ? backoffReps : 10,
				executedRir: 1,
				notes: '',
				expectedIdentity: `${row.gymEquipmentId ?? 'legacy'}:${row.loadConvention}`
			});
			expect(result.ok).toBe(true);
		}
		await endSession(db, run.sessionId);
	}
	return { start, completed, binding, exercise };
}

describe.each([false, true])('MAIN caller contract (machine bound=%s)', (bound) => {
	it.each([
		{ top: 5, backoff: 10, loads: [30, 100, 80], reason: 'below target' },
		{ top: 10, backoff: 5, loads: [30, 105, 84], reason: 'top set hit' }
	])(
		'uses actual top outcome: $top top reps, $backoff backoff reps',
		async ({ top, backoff, loads, reason }) => {
			const f = await fixture(bound);
			await f.completed(top, backoff);
			const run = await f.start();
			expect(run.rows.map((r) => r.prescribedLoad)).toEqual(loads);
			expect(run.rows[0].suggestionReasoning).toBeNull();
			expect(run.rows[1].suggestionReasoning).toContain(reason);
			expect(run.rows[2].suggestionReasoning).toContain(reason);
			expect(run.rows[2].suggestionReasoning).toContain('ratio');
		}
	);
	it('holds backoff with incomplete top history instead of substituting backoff', async () => {
		const f = await fixture(bound);
		await f.completed(null, 10);
		const run = await f.start();
		expect(run.rows[1].prescribedLoad).toBe(bound ? null : 50);
		expect(run.rows[2].prescribedLoad).toBe(80);
		expect(run.rows[2].suggestionReasoning).toContain('top');
	});
	it('deloads from top streak only and preserves backoff ratio; warmup bypasses', async () => {
		const f = await fixture(bound);
		await f.completed(10, 5, 100, 70);
		await f.completed(10, 5, 100, 75);
		await f.completed(10, 5, 100, 80);
		const run = await f.start();
		expect(run.rows.map((r) => r.prescribedLoad)).toEqual([30, 90, 72]);
		expect(run.rows[0].suggestionReasoning).toBeNull();
		expect(run.rows[2].suggestionReasoning).toContain('deload');
	});
	it.each(['cautious', 'hold'] as const)('retains %s policy', async (policy) => {
		const f = await fixture(bound, policy);
		await f.completed(10, 10);
		const run = await f.start();
		expect(run.rows.map((r) => r.prescribedLoad)).toEqual([30, 100, 80]);
		expect(run.rows[2].suggestionReasoning).toContain(policy);
	});
	it('holds a backoff when the executed top baseline is zero', async () => {
		const f = await fixture(bound);
		await f.completed(10, 10, 0, 80);
		const run = await f.start();
		expect(run.rows.map((r) => r.prescribedLoad)).toEqual([30, 5, 80]);
		expect(run.rows[2].suggestionReasoning).toContain('no valid MAIN backoff ratio');
	});
	it('holds an ambiguous multiple-top occurrence without guessing a driver', async () => {
		const f = await fixture(bound);
		await db
			.update(s.prescribedSets)
			.set({ setRole: 'top' })
			.where(eq(s.prescribedSets.position, 3));
		await f.completed(10, 10);
		const run = await f.start();
		expect(run.rows.map((r) => r.prescribedLoad)).toEqual([30, 100, 100]);
		expect(run.rows[1].suggestionReasoning).toContain('ambiguous');
		expect(run.rows[2].suggestionReasoning).toContain('ambiguous');
	});
	it('does not let a backoff-only backwards streak deload MAIN', async () => {
		const f = await fixture(bound);
		await f.completed(10, 10, 90, 80);
		await f.completed(10, 10, 95, 80);
		await f.completed(10, 10, 100, 80);
		const run = await f.start();
		expect(run.rows.map((r) => r.prescribedLoad)).toEqual([30, 105, 84]);
	});
});

it('quick-added MAIN has one top followed by backoffs', async () => {
	const f = await fixture(true);
	const run = await f.start();
	const occurrence = await addSessionExercise(db, run.sessionId, {
		...f.binding,
		exerciseId: f.exercise.id,
		equipmentType: 'machine-stack',
		setCount: 3,
		repsMin: 8,
		repsMax: 10,
		rir: 1,
		tier: 'main',
		progressionPolicy: 'standard'
	});
	const rows = await db
		.select()
		.from(s.sets)
		.where(eq(s.sets.sessionExerciseId, occurrence.id))
		.orderBy(asc(s.sets.position));
	expect(rows.map((r) => r.setRole)).toEqual(['top', 'backoff', 'backoff']);
});
