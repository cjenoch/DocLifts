import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { setupTestDb, resetTestDb } from './test-db';
import { duplicateProgramForEdit } from './programs';
import * as s from './db/schema';
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
it('deep-copies every template child and keeps historical prescription references unchanged', async () => {
	const db = h.db;
	const [p] = await db.insert(s.programs).values({ name: 'Original' }).returning();
	const [d] = await db
		.insert(s.days)
		.values({ programId: p.id, name: 'Day', position: 1 })
		.returning();
	const [e] = await db
		.insert(s.exercises)
		.values({ name: 'Press', equipmentType: 'machine-plate' })
		.returning();
	const [dx] = await db
		.insert(s.dayExercises)
		.values({
			dayId: d.id,
			exerciseId: e.id,
			position: 1,
			tier: 'secondary',
			progressionPolicy: 'cautious'
		})
		.returning();
	const [ps] = await db
		.insert(s.prescribedSets)
		.values({
			dayExerciseId: dx.id,
			position: 1,
			setRole: 'working',
			initialLoad: 50,
			targetRepsMin: 8,
			targetRepsMax: 12
		})
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
	const [set] = await db
		.insert(s.sets)
		.values({
			sessionId: session.id,
			exerciseId: e.id,
			prescribedSetId: ps.id,
			position: 1,
			setRole: 'working',
			prescribedLoad: 50,
			executedLoad: 55,
			executedReps: 12
		})
		.returning();
	const copy = await duplicateProgramForEdit(db, p.id);
	const [newDay] = await db.select().from(s.days).where(eq(s.days.programId, copy.id));
	const [newDx] = await db.select().from(s.dayExercises).where(eq(s.dayExercises.dayId, newDay.id));
	const [newPs] = await db
		.select()
		.from(s.prescribedSets)
		.where(eq(s.prescribedSets.dayExerciseId, newDx.id));
	expect(copy.sourceProgramId).toBe(p.id);
	expect(newDay.id).not.toBe(d.id);
	expect(newDx.id).not.toBe(dx.id);
	expect(newPs.id).not.toBe(ps.id);
	expect(newDx.progressionPolicy).toBe('cautious');
	expect(newPs.initialLoad).toBe(50);
	await db
		.update(s.prescribedSets)
		.set({ targetRepsMax: 20 })
		.where(eq(s.prescribedSets.id, newPs.id));
	const [original] = await db.select().from(s.programs).where(eq(s.programs.id, p.id));
	expect(original.isActive).toBe(false);
	const [unchanged] = await db.select().from(s.sets).where(eq(s.sets.id, set.id));
	expect(unchanged).toEqual(set);
	const [oldPs] = await db.select().from(s.prescribedSets).where(eq(s.prescribedSets.id, ps.id));
	expect(oldPs.targetRepsMax).toBe(12);
	await expect(duplicateProgramForEdit(db, p.id)).rejects.toThrow(/inactive/i);
});
