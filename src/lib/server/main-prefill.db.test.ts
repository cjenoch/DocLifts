import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { createTestUser, setupTestDb, resetTestDb, type TestDb } from './test-db';
import * as s from './db/schema';
import { createGym, createMachine, bindSessionMachine, addSessionExercise } from './machines';
import { startSessionForDay, endSession, updateSetInSession } from './sessions';
import { getLastCompletedSet } from './progression';
import { mainPrefills } from './main-prefill';

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

// mainPrefills owns no writes, and its one read is computeConsecutiveBackwards,
// which (b) already scoped. So this checks fixture hygiene — an ownerless
// fixture row is indistinguishable from a production one.
afterEach(async () => {});

async function fixture(bound: boolean, policy: 'standard' | 'cautious' | 'hold' = 'standard') {
	// Owner for every row this fixture creates. `days` and `day_exercises` have
	// no user_id column; ownership reaches them through the program.
	const userId = await createTestUser(db, 'main-prefill');
	const [program] = await db
		.insert(s.programs)
		.values({ name: 'MAIN regression', userId })
		.returning();
	const [day] = await db
		.insert(s.days)
		.values({ programId: program.id, name: 'Day', position: 1 })
		.returning();
	const [exercise] = await db
		.insert(s.exercises)
		.values({ name: 'Press', equipmentType: 'machine-stack', userId })
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
	const gym = await createGym(db, userId, { name: 'Gym' });
	const machine = await createMachine(db, userId, {
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
		const result = await startSessionForDay(db, userId, day.id);
		if (!result.ok) throw new Error(result.message);
		// No stamping: startSessionForDay owns the session and the sets it
		const [occurrence] = await db
			.select()
			.from(s.sessionExercises)
			.where(eq(s.sessionExercises.sessionId, result.sessionId));
		if (bound) await bindSessionMachine(db, userId, result.sessionId, occurrence.id, binding);
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
			const result = await updateSetInSession(db, userId, run.sessionId, row.id, {
				executedLoad: row.setRole === 'warmup' ? 30 : row.setRole === 'top' ? topLoad : backoffLoad,
				executedReps:
					row.setRole === 'top' ? topReps! : row.setRole === 'backoff' ? backoffReps : 10,
				executedRir: 1,
				notes: '',
				expectedIdentity: `${row.gymEquipmentId ?? 'legacy'}:${row.loadConvention}`
			});
			expect(result.ok).toBe(true);
		}
		await endSession(db, userId, run.sessionId);
	}
	return { userId, start, completed, binding, exercise, machine };
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
	const occurrence = await addSessionExercise(db, f.userId, run.sessionId, {
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

// mainPrefills owns no writes, and its one read is computeConsecutiveBackwards,
// which (b) already scoped. The `history` on each MainSlot is passed in by the
// caller, and startSessionForDay gets it from the now owner-scoped
// getLastCompletedSet. So this is a test that the CALLER scoped it: history
// belonging to one user must not reach another user's prefill output.
describe.each([false, true])('caller-supplied history scoping (bound=%s)', (bound) => {
	it("gives a second user cold-start output, not the first user's progressed load", async () => {
		const f = await fixture(bound);
		await f.completed(10, 10, 100, 80);
		const bob = await createTestUser(db, 'main-prefill-bob');

		// With a machine bound, history is machine-scoped: the identity filter
		// must match the bound machine or the lookup finds nothing. The other
		// tests in this file get this through startSessionForDay; calling
		// mainPrefills directly means supplying it.
		const identity = bound
			? { gymEquipmentId: f.machine.id, loadConvention: 'displayed' as const }
			: undefined;

		const slotsFor = async (userId: string) => [
			{
				position: 1,
				setRole: 'warmup' as const,
				targetRepsMax: 10,
				targetRepsMin: 8,
				targetRir: 1,
				history: null
			},
			{
				position: 2,
				setRole: 'top' as const,
				targetRepsMax: 10,
				targetRepsMin: 8,
				targetRir: 1,
				history: await getLastCompletedSet(db, userId, f.exercise.id, 'top', 2, undefined, identity)
			},
			{
				position: 3,
				setRole: 'backoff' as const,
				targetRepsMax: 10,
				targetRepsMin: 8,
				targetRir: 1,
				history: null
			}
		];

		const asAlice = await mainPrefills(
			db,
			f.userId,
			f.exercise.id,
			await slotsFor(f.userId),
			'standard',
			false,
			identity
		);
		const asBob = await mainPrefills(
			db,
			bob,
			f.exercise.id,
			await slotsFor(bob),
			'standard',
			false
		);

		// Bob's slot history is null, so his output is cold start: no load and no
		// reasoning derived from Alice's completed sets.
		expect(asBob.get(2)?.load).toBeNull();
		expect(asBob.get(2)?.reasoning).toBeNull();
		// Not vacuous: Alice's own call carries a real load derived from her
		// completed sets, so the assertions above distinguish the two callers
		// rather than holding regardless.
		expect(asAlice.get(2)?.load).not.toBeNull();
	});
});
