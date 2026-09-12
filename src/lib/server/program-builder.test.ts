import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
	blankProgramDraft,
	blankExerciseDraft,
	blankSetDraft,
	programDraftSchema,
	type ProgramDraft
} from '../program-draft';
import {
	loadProgramDraft,
	saveProgramDraft,
	listProgramExercises,
	ProgramNotFoundError
} from './program-builder';
import { setupTestDb, resetTestDb } from './test-db';
import * as s from './db/schema';

function draft(): ProgramDraft {
	return {
		name: 'Synthetic program',
		description: 'Description',
		days: [
			{
				name: 'Push',
				notes: 'Day notes',
				alternateGroupId: null,
				exercises: [
					{
						...blankExerciseDraft(),
						newExercise: { name: 'Synthetic press', equipmentType: 'dumbbell', isLowerBody: false },
						notes: 'Exercise notes',
						sets: [{ ...blankSetDraft(), initialLoad: 25, notes: 'Set notes' }]
					}
				]
			}
		]
	};
}
const request = (value: unknown = draft(), sourceProgramId: string | null = null) => ({
	requestId: randomUUID(),
	sourceProgramId,
	draft: value
});

describe('bounded strict draft validation', () => {
	it('exports independent editable blanks and accepts a complete draft', () => {
		const a = blankProgramDraft();
		const b = blankProgramDraft();
		expect(a.days).toHaveLength(1);
		a.days[0].name = 'Changed';
		expect(b.days[0].name).not.toBe('Changed');
		expect(programDraftSchema.parse(draft())).toEqual(draft());
	});
	it.each([
		[
			'program extra',
			(d: any) => {
				d.isActive = true;
			}
		],
		[
			'day extra',
			(d: any) => {
				d.days[0].position = 1;
			}
		],
		[
			'exercise extra',
			(d: any) => {
				d.days[0].exercises[0].gymEquipmentId = randomUUID();
			}
		],
		[
			'quick-add extra',
			(d: any) => {
				d.days[0].exercises[0].newExercise.id = randomUUID();
			}
		],
		[
			'set extra',
			(d: any) => {
				d.days[0].exercises[0].sets[0].currentLoad = 10;
			}
		],
		[
			'empty name',
			(d: any) => {
				d.name = '   ';
			}
		],
		[
			'long name',
			(d: any) => {
				d.name = 'x'.repeat(201);
			}
		],
		[
			'long notes',
			(d: any) => {
				d.days[0].notes = 'x'.repeat(5001);
			}
		],
		[
			'long description',
			(d: any) => {
				d.description = 'x'.repeat(5001);
			}
		],
		[
			'long group',
			(d: any) => {
				d.days[0].alternateGroupId = 'x'.repeat(101);
			}
		],
		[
			'empty days',
			(d: any) => {
				d.days = [];
			}
		],
		[
			'too many days',
			(d: any) => {
				d.days = Array(32).fill(d.days[0]);
			}
		],
		[
			'empty exercises',
			(d: any) => {
				d.days[0].exercises = [];
			}
		],
		[
			'too many exercises',
			(d: any) => {
				d.days[0].exercises = Array(51).fill(d.days[0].exercises[0]);
			}
		],
		[
			'empty sets',
			(d: any) => {
				d.days[0].exercises[0].sets = [];
			}
		],
		[
			'too many sets',
			(d: any) => {
				d.days[0].exercises[0].sets = Array(31).fill(blankSetDraft());
			}
		],
		[
			'missing exercise',
			(d: any) => {
				d.days[0].exercises[0].newExercise = null;
			}
		],
		[
			'both exercise choices',
			(d: any) => {
				d.days[0].exercises[0].exerciseId = randomUUID();
			}
		],
		[
			'invalid UUID',
			(d: any) => {
				d.days[0].exercises[0].exerciseId = 'bad';
				d.days[0].exercises[0].newExercise = null;
			}
		],
		[
			'equipment',
			(d: any) => {
				d.days[0].exercises[0].newExercise.equipmentType = 'magic';
			}
		],
		[
			'lower-body required',
			(d: any) => {
				delete d.days[0].exercises[0].newExercise.isLowerBody;
			}
		],
		[
			'tier',
			(d: any) => {
				d.days[0].exercises[0].tier = 'priority';
			}
		],
		[
			'policy',
			(d: any) => {
				d.days[0].exercises[0].progressionPolicy = 'auto';
			}
		]
	])('rejects %s', (_, change) => {
		const d = draft();
		change(d);
		expect(programDraftSchema.safeParse(d).success).toBe(false);
	});
	it.each([
		['targetRepsMin', 0],
		['targetRepsMax', 3601],
		['targetRepsMin', 1.5],
		['targetRepsMin', '8'],
		['targetRepsMax', NaN],
		['targetRepsMax', Infinity],
		['targetRir', -1],
		['targetRir', 11],
		['targetRir', 1.5],
		['restSecondsMin', -1],
		['restSecondsMax', 3601],
		['restSecondsMax', 1.5],
		['initialLoad', -1],
		['initialLoad', 1000],
		['initialLoad', Infinity],
		['initialLoad', 0.001],
		['targetMetric', 'minutes'],
		['setRole', 'other']
	])('rejects invalid %s=%s', (key, value) => {
		const d = draft();
		Object.assign(d.days[0].exercises[0].sets[0], { [key]: value });
		expect(programDraftSchema.safeParse(d).success).toBe(false);
	});
	it('rejects reversed target/rest ranges and allows seconds, zero load and null optional values', () => {
		const d = draft();
		const set = d.days[0].exercises[0].sets[0];
		set.targetRepsMin = 20;
		expect(programDraftSchema.safeParse(d).success).toBe(false);
		set.targetRepsMax = 30;
		set.restSecondsMin = 200;
		set.restSecondsMax = 100;
		expect(programDraftSchema.safeParse(d).success).toBe(false);
		Object.assign(set, {
			targetMetric: 'seconds',
			initialLoad: 0,
			targetRir: null,
			restSecondsMin: null,
			restSecondsMax: null
		});
		expect(programDraftSchema.safeParse(d).success).toBe(true);
	});
	it.each([
		['main', ['top'], true],
		['main', ['warmup', 'top', 'backoff', 'backoff'], true],
		['main', ['working'], false],
		['main', ['top', 'top'], false],
		['main', ['backoff', 'top'], false],
		['main', ['top', 'warmup'], false],
		['main', ['warmup'], false],
		['secondary', ['warmup', 'working', 'working'], true],
		['isolation', ['working'], true],
		['secondary', ['top'], false],
		['isolation', ['backoff'], false],
		['secondary', ['working', 'warmup'], false]
	])('validates %s role order %j', (tier, roles, valid) => {
		const d = draft();
		Object.assign(d.days[0].exercises[0], {
			tier,
			sets: (roles as string[]).map((setRole) => ({ ...blankSetDraft(), setRole }))
		});
		expect(programDraftSchema.safeParse(d).success).toBe(valid);
	});
});

describe('transactional program builder', () => {
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
	async function state() {
		return {
			programs: await h.db.select().from(s.programs).orderBy(s.programs.id),
			days: await h.db.select().from(s.days).orderBy(s.days.id),
			exercises: await h.db.select().from(s.exercises).orderBy(s.exercises.id),
			dx: await h.db.select().from(s.dayExercises).orderBy(s.dayExercises.id),
			ps: await h.db.select().from(s.prescribedSets).orderBy(s.prescribedSets.id),
			requests: await h.db
				.select()
				.from(s.programDraftRequests)
				.orderBy(s.programDraftRequests.requestId)
		};
	}
	it('identifies a missing program with a typed not-found error', async () => {
		await expect(loadProgramDraft(h.db, randomUUID())).rejects.toBeInstanceOf(ProgramNotFoundError);
		await expect(loadProgramDraft(h.db, randomUUID())).rejects.toMatchObject({
			name: 'ProgramNotFoundError',
			message: 'Program not found'
		});
	});
	it('creates ordered complete trees, resolves compatible library names, lists and loads drafts', async () => {
		const [existing] = await h.db.insert(s.programs).values({ name: 'Other active' }).returning();
		const d = draft();
		d.days.push({ ...structuredClone(d.days[0]), name: 'Pull', alternateGroupId: 'legs' });
		d.days[0].exercises.push({
			...structuredClone(d.days[0].exercises[0]),
			notes: 'Second occurrence'
		});
		d.days[0].exercises[0].sets.push({
			...blankSetDraft(),
			targetMetric: 'seconds',
			targetRepsMin: 30,
			targetRepsMax: 45,
			initialLoad: 0
		});
		const saved = await saveProgramDraft(h.db, request(d));
		const library = await listProgramExercises(h.db);
		expect(library).toHaveLength(1);
		expect(library[0]).toMatchObject({
			name: 'Synthetic press',
			equipmentType: 'dumbbell',
			isLowerBody: false
		});
		const expected = structuredClone(d);
		for (const day of expected.days)
			for (const ex of day.exercises) {
				ex.exerciseId = library[0].id;
				ex.newExercise = null;
			}
		expect(await loadProgramDraft(h.db, saved.id)).toEqual(expected);
		expect(
			(
				await h.db
					.select()
					.from(s.days)
					.where(eq(s.days.programId, saved.id))
					.orderBy(s.days.position)
			).map((d) => d.position)
		).toEqual([1, 2]);
		expect(
			(await h.db.select().from(s.programs).where(eq(s.programs.id, existing.id)))[0].isActive
		).toBe(true);
	});
	it('persists idempotency across concurrent create and replay and rejects fingerprint/source conflicts', async () => {
		const input = request();
		const results = await Promise.all(
			Array.from({ length: 4 }, () => saveProgramDraft(h.db, input))
		);
		expect(new Set(results.map((r) => r.id)).size).toBe(1);
		expect((await state()).programs).toHaveLength(1);
		expect((await state()).requests).toHaveLength(1);
		expect(await saveProgramDraft(h.db, input)).toEqual(results[0]);
		await expect(
			saveProgramDraft(h.db, { ...input, draft: { ...draft(), name: 'Different' } })
		).rejects.toThrow(/request|different|conflict/i);
		await expect(
			saveProgramDraft(h.db, { ...input, sourceProgramId: results[0].id })
		).rejects.toThrow(/request|different|conflict/i);
		expect((await state()).programs).toHaveLength(1);
	});
	it('treats equivalent UUID spellings as the same concurrent request', async () => {
		const input = request();
		const results = await Promise.all([
			saveProgramDraft(h.db, input),
			saveProgramDraft(h.db, { ...input, requestId: input.requestId.toUpperCase() })
		]);
		expect(results[0]).toEqual(results[1]);
		expect((await state()).programs).toHaveLength(1);
	});
	it('rolls back late nested FK failure including quick-add rows and permits corrected retry', async () => {
		const input = request();
		const d = input.draft as ProgramDraft;
		d.days[0].exercises.push({ ...blankExerciseDraft(), exerciseId: randomUUID() });
		const before = await state();
		await expect(saveProgramDraft(h.db, input)).rejects.toThrow();
		expect(await state()).toEqual(before);
		d.days[0].exercises.pop();
		expect(await saveProgramDraft(h.db, input)).toHaveProperty('id');
	});
	it('rejects incompatible quick-add collisions without changing library or tree', async () => {
		await saveProgramDraft(h.db, request());
		const before = await state();
		const d = draft();
		d.days[0].exercises[0].newExercise!.isLowerBody = true;
		await expect(saveProgramDraft(h.db, request(d))).rejects.toThrow(
			/incompatible|metadata|existing/i
		);
		expect(await state()).toEqual(before);
	});
	it('rejects malformed outer identifiers, unknown fields and nonexistent source before committing', async () => {
		await expect(saveProgramDraft(h.db, { ...request(), requestId: 'bad' })).rejects.toThrow();
		await expect(
			saveProgramDraft(h.db, { ...request(), sourceProgramId: 'bad' })
		).rejects.toThrow();
		await expect(saveProgramDraft(h.db, { ...request(), extra: true } as any)).rejects.toThrow();
		await expect(saveProgramDraft(h.db, request(draft(), randomUUID()))).rejects.toThrow(
			/not found/i
		);
		await expect(loadProgramDraft(h.db, 'bad')).rejects.toThrow();
		await expect(loadProgramDraft(h.db, randomUUID())).rejects.toThrow(/not found/i);
		expect((await state()).programs).toHaveLength(0);
	});
	it('edits once concurrently, copies fresh IDs, preserves exact old tree and ended history', async () => {
		const original = await saveProgramDraft(h.db, request());
		const before = await state();
		const [session] = await h.db
			.insert(s.sessions)
			.values({
				programId: original.id,
				dayId: before.days[0].id,
				startedAt: new Date('2026-01-01'),
				endedAt: new Date('2026-01-02')
			})
			.returning();
		const [set] = await h.db
			.insert(s.sets)
			.values({
				sessionId: session.id,
				exerciseId: before.exercises[0].id,
				prescribedSetId: before.ps[0].id,
				position: 1,
				setRole: 'working',
				prescribedLoad: 25,
				prescribedRepsMin: 8,
				prescribedRepsMax: 12,
				executedLoad: 30,
				executedReps: 10
			})
			.returning();
		const d = await loadProgramDraft(h.db, original.id);
		d.name = 'New version';
		d.days[0].exercises[0].sets[0].targetRepsMax = 15;
		const input = request(d, original.id);
		const results = await Promise.all([
			saveProgramDraft(h.db, input),
			saveProgramDraft(h.db, input)
		]);
		expect(results[0]).toEqual(results[1]);
		const after = await state();
		expect(after.programs).toHaveLength(2);
		expect(after.programs.find((p) => p.id === original.id)).toEqual({
			...before.programs[0],
			isActive: false
		});
		expect(after.programs.find((p) => p.id === results[0].id)).toMatchObject({
			name: 'New version',
			sourceProgramId: original.id,
			isActive: true
		});
		for (const key of ['days', 'dx', 'ps'] as const) {
			expect(after[key]).toHaveLength(before[key].length * 2);
			for (const row of before[key]) expect(after[key]).toContainEqual(row);
		}
		expect(await h.db.select().from(s.sessions)).toEqual([session]);
		expect(await h.db.select().from(s.sets)).toEqual([set]);
		expect(await loadProgramDraft(h.db, results[0].id)).toEqual(d);
	});
	it('rolls back copied tree, source archive and quick-add rows after failed edit', async () => {
		const original = await saveProgramDraft(h.db, request());
		const before = await state();
		const d = draft();
		d.days[0].exercises[0].newExercise!.name = 'Must roll back';
		d.days[0].exercises.push({ ...blankExerciseDraft(), exerciseId: randomUUID() });
		await expect(saveProgramDraft(h.db, request(d, original.id))).rejects.toThrow();
		expect(await state()).toEqual(before);
	});
	it('serializes distinct edits on the same source and allows only one successor', async () => {
		const original = await saveProgramDraft(h.db, request());
		const d = await loadProgramDraft(h.db, original.id);
		const results = await Promise.allSettled([
			saveProgramDraft(h.db, request(d, original.id)),
			saveProgramDraft(h.db, request({ ...d, name: 'Race' }, original.id))
		]);
		expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
		expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
		expect((await state()).programs).toHaveLength(2);
		expect((await state()).requests).toHaveLength(2);
	});
});
