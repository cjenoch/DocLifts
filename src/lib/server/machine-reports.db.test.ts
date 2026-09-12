import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { setupTestDb, resetTestDb } from './test-db';
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
	await resetTestDb(h.client);
});
it('reports physical identity and conventions separately using snapshot names', async () => {
	const db = h.db;
	const [p] = await db.insert(s.programs).values({ name: 'Report' }).returning();
	const [d] = await db
		.insert(s.days)
		.values({ programId: p.id, name: 'D', position: 1 })
		.returning();
	const [e] = await db
		.insert(s.exercises)
		.values({ name: 'Press', equipmentType: 'machine-plate' })
		.returning();
	const [g] = await db.insert(s.gyms).values({ name: 'Gym' }).returning();
	const machines = await db
		.insert(s.gymEquipment)
		.values(
			['A', 'B'].map((localLabel) => ({ gymId: g.id, localLabel, equipmentType: 'machine-plate' }))
		)
		.returning();
	const [session] = await db
		.insert(s.sessions)
		.values({
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
		await db
			.insert(s.sets)
			.values({
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
	const report = await topExerciseIdentities(db);
	expect(report).toHaveLength(2);
	expect(report.map((r) => r.machineLabel).sort()).toEqual(['A', 'B']);
	expect(report.every((r) => r.exerciseName === 'Press' && r.completedSetRows === 1)).toBe(true);
});
