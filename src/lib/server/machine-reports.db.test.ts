import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { setupTestDb, resetTestDbWithUsers, withTwoUsers, type TestDb } from './test-db';
import * as s from './db/schema';
import { topExerciseIdentities } from './machine-reports';
let h: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
	h = await setupTestDb();
});
afterAll(async () => {
	await h?.end();
});
beforeEach(async () => {
	await resetTestDbWithUsers(h.db, h.client, 1, 'reports');
});
it('reports physical identity and conventions separately using snapshot names', async () => {
	const db = h.db;
	const { alice: userId } = await withTwoUsers(db);
	const [p] = await db.insert(s.programs).values({ userId, name: 'Report' }).returning();
	const [d] = await db
		.insert(s.days)
		.values({ programId: p.id, name: 'D', position: 1 })
		.returning();
	const [e] = await db
		.insert(s.exercises)
		.values({ userId, name: 'Press', equipmentType: 'machine-plate' })
		.returning();
	const [g] = await db.insert(s.gyms).values({ userId, name: 'Gym' }).returning();
	const machines = await db
		.insert(s.gymEquipment)
		.values(
			['A', 'B'].map((localLabel) => ({ gymId: g.id, localLabel, equipmentType: 'machine-plate' }))
		)
		.returning();
	const [session] = await db
		.insert(s.sessions)
		.values({
			userId,
			programId: p.id,
			dayId: d.id,
			startedAt: new Date('2026-01-01'),
			endedAt: new Date('2026-01-02')
		})
		.returning();
	for (const [i, m] of machines.entries()) {
		const [o] = await db
			.insert(s.sessionExercises)
			.values({
				sessionId: session.id,
				exerciseId: e.id,
				position: i + 1,
				exerciseName: e.name,
				gymEquipmentId: m.id,
				machineLabel: m.localLabel,
				gymName: g.name,
				equipmentType: m.equipmentType,
				loadConvention: 'plates_per_side',
				tier: 'secondary',
				progressionPolicy: 'standard'
			})
			.returning();
		await db.insert(s.sets).values({
			userId,
			sessionId: session.id,
			sessionExerciseId: o.id,
			exerciseId: e.id,
			gymEquipmentId: m.id,
			loadConvention: 'plates_per_side',
			position: 1,
			setRole: 'working',
			executedLoad: 50,
			executedReps: 10
		});
	}
	await db.update(s.gymEquipment).set({ localLabel: 'Changed' });
	await db.update(s.exercises).set({ name: 'Renamed' }).where(eq(s.exercises.id, e.id));
	const report = await topExerciseIdentities(db, userId);
	expect(report).toHaveLength(2);
	expect(report.map((r) => r.machineLabel).sort()).toEqual(['A', 'B']);
	expect(report.every((r) => r.exerciseName === 'Press' && r.completedSetRows === 1)).toBe(true);
});

// Cross-tenant for the report. Positive case first: the report must return
// Alice's identities to Alice, and nothing of Alice's to Bob. A negative that
// only ever saw an empty result would pass for the wrong reason.
it("topExerciseIdentities returns a user their own machines and never another's", async () => {
	const db = h.db;
	const { alice, bob } = await withTwoUsers(db);

	async function seedIdentitiesFor(ownerId: string, label: string) {
		const [p] = await db.insert(s.programs).values({ userId: ownerId, name: label }).returning();
		const [d] = await db
			.insert(s.days)
			.values({ programId: p.id, name: 'D', position: 1 })
			.returning();
		const [e] = await db
			.insert(s.exercises)
			.values({ userId: ownerId, name: `${label}-Press`, equipmentType: 'machine-plate' })
			.returning();
		const [g] = await db
			.insert(s.gyms)
			.values({ userId: ownerId, name: `${label}-Gym` })
			.returning();
		const [m] = await db
			.insert(s.gymEquipment)
			.values({ gymId: g.id, localLabel: label, equipmentType: 'machine-plate' })
			.returning();
		const [session] = await db
			.insert(s.sessions)
			.values({
				userId: ownerId,
				programId: p.id,
				dayId: d.id,
				startedAt: new Date('2026-01-01'),
				endedAt: new Date('2026-01-02')
			})
			.returning();
		const [o] = await db
			.insert(s.sessionExercises)
			.values({
				sessionId: session.id,
				exerciseId: e.id,
				position: 1,
				exerciseName: e.name,
				gymEquipmentId: m.id,
				machineLabel: m.localLabel,
				gymName: g.name,
				equipmentType: m.equipmentType,
				loadConvention: 'plates_per_side',
				tier: 'secondary',
				progressionPolicy: 'standard'
			})
			.returning();
		await db.insert(s.sets).values({
			userId: ownerId,
			sessionId: session.id,
			sessionExerciseId: o.id,
			exerciseId: e.id,
			gymEquipmentId: m.id,
			loadConvention: 'plates_per_side',
			position: 1,
			setRole: 'working',
			executedLoad: 50,
			executedReps: 10
		});
	}

	await seedIdentitiesFor(alice, 'AliceMachine');
	await seedIdentitiesFor(bob, 'BobMachine');

	const alices = await topExerciseIdentities(db, alice);
	expect(alices.map((r) => r.machineLabel)).toEqual(['AliceMachine']);

	const bobs = await topExerciseIdentities(db, bob);
	expect(bobs.map((r) => r.machineLabel)).toEqual(['BobMachine']);
	expect(bobs.some((r) => r.machineLabel === 'AliceMachine')).toBe(false);
});
