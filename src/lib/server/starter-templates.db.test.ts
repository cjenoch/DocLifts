import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { STARTER_TEMPLATES } from '../starter-templates';
import {
	listProgramExercises,
	loadProgramDraft,
	saveProgramDraft,
	ProgramNotFoundError
} from './program-builder';
import { startSessionForDay } from './sessions';
import { STARTER_EXERCISES } from './starter-exercises';
import { createTestUser, setupTestDb, resetTestDb, withTwoUsers } from './test-db';
import * as s from './db/schema';

// Editor spec Part D, "Checks before these ship": every template saves through
// saveProgramDraft on a brand-new account and on one that already has some of
// its exercise names, and a saved copy belongs to one user only.
describe('starter templates against the database', () => {
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

	/** A brand-new account: the starter list the sign-up hook copies in. */
	async function newAccount(label: string): Promise<string> {
		const userId = await createTestUser(h.db, label);
		await h.db.insert(s.exercises).values(
			STARTER_EXERCISES.map((e) => ({
				userId,
				name: e.name,
				equipmentType: e.equipmentType,
				isLowerBody: e.isLowerBody ?? false,
				bodyRegion: e.bodyRegion
			}))
		);
		return userId;
	}

	async function saveTemplate(userId: string, template: (typeof STARTER_TEMPLATES)[number]) {
		const draft = template.build(await listProgramExercises(h.db, userId));
		const saved = await saveProgramDraft(h.db, userId, {
			requestId: randomUUID(),
			sourceProgramId: null,
			draft
		});
		return { draft, saved };
	}

	const exerciseNames = async (userId: string) =>
		(await listProgramExercises(h.db, userId)).map((e) => e.name);

	it.each(STARTER_TEMPLATES.map((t) => [t.label, t] as const))(
		'%s saves on a brand-new account, reusing its starter exercises, and day one starts',
		async (_, template) => {
			const userId = await newAccount('template-new');
			const { draft, saved } = await saveTemplate(userId, template);
			const library = await listProgramExercises(h.db, userId);
			const names = library.map((e) => e.name);
			// One row per name: starters were reused, not duplicated.
			expect(new Set(names).size).toBe(names.length);
			const loaded = await loadProgramDraft(h.db, userId, saved.id);
			expect(loaded.name).toBe(template.label);
			expect(loaded.days.map((d) => d.name)).toEqual(draft.days.map((d) => d.name));
			for (const [dayIndex, day] of draft.days.entries())
				for (const [index, row] of day.exercises.entries()) {
					const got = loaded.days[dayIndex].exercises[index];
					const name = row.newExercise?.name ?? library.find((e) => e.id === row.exerciseId)?.name;
					expect(library.find((e) => e.id === got.exerciseId)?.name).toBe(name);
					expect(got.sets).toEqual(row.sets);
					expect(got.tier).toBe(row.tier);
				}
			const [firstDay] = await h.db
				.select()
				.from(s.days)
				.where(and(eq(s.days.programId, saved.id), eq(s.days.position, 1)));
			const started = await startSessionForDay(h.db, userId, firstDay.id);
			expect(started.ok).toBe(true);
			if (!started.ok) return;
			const sets = await h.db.select().from(s.sets).where(eq(s.sets.sessionId, started.sessionId));
			expect(sets).toHaveLength(draft.days[0].exercises.reduce((n, row) => n + row.sets.length, 0));
		}
	);

	it('all four save, one after another, on an account that already has their names', async () => {
		const userId = await newAccount('template-owner');
		for (const template of STARTER_TEMPLATES) await saveTemplate(userId, template);
		// And again: by now every name exists, so each draft is pure library references.
		for (const template of STARTER_TEMPLATES) {
			const draft = template.build(await listProgramExercises(h.db, userId));
			expect(draft.days.flatMap((d) => d.exercises).every((row) => row.newExercise === null)).toBe(
				true
			);
			await saveProgramDraft(h.db, userId, {
				requestId: randomUUID(),
				sourceProgramId: null,
				draft
			});
		}
		const names = await exerciseNames(userId);
		expect(new Set(names).size).toBe(names.length);
		const programs = await h.db.select().from(s.programs).where(eq(s.programs.userId, userId));
		expect(programs).toHaveLength(STARTER_TEMPLATES.length * 2);
	});

	it('a saved copy belongs to its owner only, and another user gets their own', async () => {
		const { alice, bob } = await withTwoUsers(h.db);
		const template = STARTER_TEMPLATES[2];
		const { saved } = await saveTemplate(alice, template);
		// Positive first: Alice reads her copy.
		expect((await loadProgramDraft(h.db, alice, saved.id)).name).toBe(template.label);
		await expect(loadProgramDraft(h.db, bob, saved.id)).rejects.toBeInstanceOf(
			ProgramNotFoundError
		);
		expect(await exerciseNames(bob)).toEqual([]);

		const before = await loadProgramDraft(h.db, alice, saved.id);
		const bobs = await saveTemplate(bob, template);
		expect(bobs.saved.id).not.toBe(saved.id);
		const aliceIds = new Set((await listProgramExercises(h.db, alice)).map((e) => e.id));
		const bobsDraft = await loadProgramDraft(h.db, bob, bobs.saved.id);
		for (const row of bobsDraft.days.flatMap((d) => d.exercises))
			expect(aliceIds.has(row.exerciseId!)).toBe(false);
		expect(await loadProgramDraft(h.db, alice, saved.id)).toEqual(before);
	});
});
