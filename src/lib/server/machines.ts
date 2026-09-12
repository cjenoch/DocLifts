import { and, asc, eq, max } from 'drizzle-orm';
import { z } from 'zod';
import {
	equipmentModels,
	exerciseEquipmentMap,
	exercises,
	gymEquipment,
	gyms,
	sessionExercises,
	sessions,
	sets
} from './db/schema';
import {
	computeConsecutiveBackwards,
	defaultIncrement,
	getLastCompletedSet,
	suggestNextLoad,
	type Database,
	type PerformanceIdentity
} from './progression';
import { snapForEquipment } from './plates';

const name = z.string().trim().min(1).max(120);
const optionalText = z.preprocess((v) => (v === '' || v == null ? undefined : v), name.optional());
const optionalId = z.preprocess(
	(v) => (v === '' || v == null ? undefined : v),
	z.string().uuid().optional()
);
const equipmentType = z.enum([
	'barbell',
	'barbell-ez',
	'machine-plate',
	'machine-stack',
	'cable',
	'dumbbell',
	'smith',
	'bodyweight',
	'band'
]);
const convention = z.enum(['unknown', 'plates_per_side', 'total_plates', 'per_arm', 'displayed']);
const machineSchema = z.object({
	gymId: z.string().uuid(),
	localLabel: name,
	equipmentType,
	equipmentModelId: optionalId,
	manufacturer: optionalText,
	modelName: optionalText
});
const identitySchema = z.object({
	gymId: z.string().uuid(),
	gymEquipmentId: z.string().uuid(),
	loadConvention: convention
});
const addSchema = z
	.object({
		exerciseId: optionalId,
		exerciseName: optionalText,
		canonicalMovement: optionalText,
		equipmentType,
		isLowerBody: z.preprocess((v) => (v == null ? false : v === '1' ? true : v), z.boolean()),
		gymId: z.string().uuid(),
		gymEquipmentId: z.string().uuid(),
		loadConvention: convention,
		setCount: z.coerce.number().int().min(1).max(10),
		repsMin: z.coerce.number().int().min(0).max(100),
		repsMax: z.coerce.number().int().min(0).max(100),
		rir: z.coerce.number().int().min(0).max(10),
		tier: z.enum(['main', 'secondary', 'isolation']),
		progressionPolicy: z.enum(['standard', 'cautious', 'hold'])
	})
	.refine((v) => v.exerciseId || v.exerciseName, { message: 'Select or name an exercise' })
	.refine((v) => v.repsMin <= v.repsMax, { message: 'Minimum reps must not exceed maximum' });

export class MachineInputError extends Error {}
export async function createGym(db: Database, input: unknown) {
	const value = z.object({ name }).parse(input);
	const [gym] = await db.insert(gyms).values(value).returning();
	return gym;
}
export async function createMachine(db: Database, input: unknown) {
	const value = machineSchema.parse(input);
	if (Boolean(value.manufacturer) !== Boolean(value.modelName))
		throw new MachineInputError('Provide both manufacturer and model name, or leave both unknown');
	return db.transaction(async (tx) => {
		const [gym] = await tx.select().from(gyms).where(eq(gyms.id, value.gymId));
		if (!gym) throw new MachineInputError('Gym not found');
		let modelId = value.equipmentModelId;
		if (modelId && value.modelName)
			throw new MachineInputError('Choose existing model or enter a new one, not both');
		if (modelId) {
			const [model] = await tx
				.select()
				.from(equipmentModels)
				.where(eq(equipmentModels.id, modelId));
			if (!model || model.loadingType !== value.equipmentType)
				throw new MachineInputError('Model loading type does not match machine');
		} else if (value.manufacturer && value.modelName) {
			const [model] = await tx
				.insert(equipmentModels)
				.values({
					manufacturer: value.manufacturer,
					name: value.modelName,
					loadingType: value.equipmentType
				})
				.returning();
			modelId = model.id;
		}
		const [machine] = await tx
			.insert(gymEquipment)
			.values({
				gymId: gym.id,
				localLabel: value.localLabel,
				equipmentType: value.equipmentType,
				equipmentModelId: modelId
			})
			.returning();
		return machine;
	});
}
export async function machineChoices(db: Database) {
	return {
		gyms: await db.select().from(gyms).orderBy(asc(gyms.name)),
		machines: await db.select().from(gymEquipment).orderBy(asc(gymEquipment.localLabel)),
		models: await db.select().from(equipmentModels).orderBy(asc(equipmentModels.name)),
		exercises: await db.select().from(exercises).orderBy(asc(exercises.name))
	};
}
async function lockActive(db: Database, sessionId: string) {
	z.string().uuid().parse(sessionId);
	const [session] = await db
		.select()
		.from(sessions)
		.where(eq(sessions.id, sessionId))
		.for('update');
	if (!session || session.deletedAt) throw new MachineInputError('Session not found');
	if (session.endedAt) throw new MachineInputError('Session has ended');
	return session;
}
async function machineSnapshot(db: Database, input: unknown) {
	const value = identitySchema.parse(input);
	const [row] = await db
		.select({ machine: gymEquipment, gym: gyms, model: equipmentModels })
		.from(gymEquipment)
		.innerJoin(gyms, eq(gyms.id, gymEquipment.gymId))
		.leftJoin(equipmentModels, eq(equipmentModels.id, gymEquipment.equipmentModelId))
		.where(and(eq(gymEquipment.id, value.gymEquipmentId), eq(gymEquipment.gymId, value.gymId)));
	if (!row) throw new MachineInputError('Machine not found in selected gym');
	if (value.loadConvention === 'plates_per_side' && row.machine.equipmentType !== 'machine-plate')
		throw new MachineInputError('Per-side plates require a plate-loaded machine');
	return {
		gymEquipmentId: row.machine.id,
		loadConvention: value.loadConvention,
		machineLabel: row.machine.localLabel,
		gymName: row.gym.name,
		modelName: row.model ? `${row.model.manufacturer} ${row.model.name}` : null,
		equipmentType: row.machine.equipmentType
	};
}

// Full exercise decision, never a single-slot fallback for secondary/isolation.
async function prefillOccurrence(db: Database, occurrence: typeof sessionExercises.$inferSelect) {
	const rows = await db
		.select()
		.from(sets)
		.where(eq(sets.sessionExerciseId, occurrence.id))
		.orderBy(asc(sets.position));
	const identity: PerformanceIdentity = {
		gymEquipmentId: occurrence.gymEquipmentId,
		loadConvention: occurrence.loadConvention
	};
	const histories = await Promise.all(
		rows.map((r) =>
			getLastCompletedSet(db, r.exerciseId, r.setRole, r.position, occurrence.sessionId, identity)
		)
	);
	const [exercise] = await db
		.select()
		.from(exercises)
		.where(eq(exercises.id, occurrence.exerciseId));
	const working = rows
		.map((r, i) => ({ r, h: histories[i] }))
		.filter((v) => v.r.setRole === 'working');
	let groupDecision: ReturnType<typeof suggestNextLoad> | null = null;
	let baseline = 0;
	if (
		occurrence.tier !== 'main' &&
		working.length &&
		working.every((v) => v.h?.executedLoad != null)
	) {
		const first = working[0];
		baseline = first.h!.executedLoad!;
		const backwards = await Promise.all(
			working.map((v) =>
				computeConsecutiveBackwards(
					db,
					occurrence.exerciseId,
					'working',
					v.r.position,
					10,
					identity
				)
			)
		);
		groupDecision = suggestNextLoad({
			tier: occurrence.tier,
			policy: occurrence.progressionPolicy,
			relevantSets: working.map((v) => ({
				position: v.r.position,
				load: v.h!.executedLoad!,
				reps: v.h!.executedReps!,
				rir: v.h!.executedRir ?? v.r.prescribedRir ?? 0
			})),
			targetRepsMax: first.r.prescribedRepsMax ?? 0,
			targetRir: first.r.prescribedRir ?? 0,
			increment: defaultIncrement(exercise.isLowerBody),
			consecutiveBackwards: Math.min(...backwards)
		});
	}
	for (let i = 0; i < rows.length; i++) {
		const r = rows[i],
			h = histories[i];
		let load = h?.executedLoad ?? null;
		let reasoning: string | null = null;
		if (load != null && h && r.setRole !== 'warmup') {
			if (occurrence.tier !== 'main' && r.setRole === 'working') {
				if (groupDecision) {
					load =
						groupDecision.kind === 'advance'
							? load + groupDecision.load - baseline
							: groupDecision.kind === 'deload'
								? baseline === 0
									? 0
									: (load * groupDecision.load) / baseline
								: load;
					reasoning = groupDecision.reasoning;
				} else reasoning = 'held: incomplete working-set history for this machine';
			} else {
				const decision = suggestNextLoad({
					tier: occurrence.tier,
					policy: occurrence.progressionPolicy,
					relevantSets: [
						{
							position: r.position,
							load,
							reps: h.executedReps!,
							rir: h.executedRir ?? r.prescribedRir ?? 0
						}
					],
					targetRepsMax: r.prescribedRepsMax ?? 0,
					targetRir: r.prescribedRir ?? 0,
					increment: defaultIncrement(exercise.isLowerBody),
					consecutiveBackwards: await computeConsecutiveBackwards(
						db,
						r.exerciseId,
						r.setRole,
						r.position,
						10,
						identity
					)
				});
				load = decision.load;
				reasoning = decision.reasoning;
			}
		}
		await db
			.update(sets)
			.set({
				gymEquipmentId: identity.gymEquipmentId,
				loadConvention: identity.loadConvention,
				prescribedLoad:
					load == null
						? null
						: snapForEquipment(load, occurrence.equipmentType, identity.loadConvention).achievable,
				suggestionReasoning: reasoning
			})
			.where(eq(sets.id, r.id));
	}
}
export async function bindSessionMachine(
	db: Database,
	sessionId: string,
	occurrenceId: string,
	input: unknown
) {
	z.object({ confirm: z.literal('CHANGE') }).parse(input);
	z.string().uuid().parse(occurrenceId);
	return db.transaction(async (tx) => {
		await lockActive(tx, sessionId);
		const [occurrence] = await tx
			.select()
			.from(sessionExercises)
			.where(and(eq(sessionExercises.id, occurrenceId), eq(sessionExercises.sessionId, sessionId)));
		if (!occurrence) throw new MachineInputError('Exercise not found in this session');
		const rows = await tx.select().from(sets).where(eq(sets.sessionExerciseId, occurrence.id));
		if (
			rows.some(
				(r) => r.executedLoad != null || r.executedReps != null || r.executedRir != null || r.notes
			)
		)
			throw new MachineInputError(
				'Cannot change machine after any values are logged; add a separate exercise instead'
			);
		const snapshot = await machineSnapshot(tx, input);
		if (snapshot.equipmentType !== occurrence.equipmentType)
			throw new MachineInputError('Machine equipment type must match exercise');
		const [updated] = await tx
			.update(sessionExercises)
			.set(snapshot)
			.where(eq(sessionExercises.id, occurrence.id))
			.returning();
		await prefillOccurrence(tx, updated);
		return updated;
	});
}
export async function addSessionExercise(db: Database, sessionId: string, input: unknown) {
	const value = addSchema.parse(input);
	return db.transaction(async (tx) => {
		await lockActive(tx, sessionId);
		const snapshot = await machineSnapshot(tx, value);
		if (snapshot.equipmentType !== value.equipmentType)
			throw new MachineInputError('Machine equipment type must match exercise');
		let exercise;
		if (value.exerciseId) {
			[exercise] = await tx.select().from(exercises).where(eq(exercises.id, value.exerciseId));
			if (!exercise || exercise.equipmentType !== value.equipmentType)
				throw new MachineInputError('Exercise equipment type mismatch');
		} else {
			const existing = await tx
				.select()
				.from(exercises)
				.where(eq(exercises.name, value.exerciseName!));
			if (existing.length)
				throw new MachineInputError('Exercise name already exists; select it from the list');
			[exercise] = await tx
				.insert(exercises)
				.values({
					name: value.exerciseName!,
					equipmentType: value.equipmentType,
					canonicalMovement: value.canonicalMovement,
					isLowerBody: value.isLowerBody
				})
				.returning();
		}
		const [last] = await tx
			.select({ position: max(sessionExercises.position) })
			.from(sessionExercises)
			.where(eq(sessionExercises.sessionId, sessionId));
		const [occurrence] = await tx
			.insert(sessionExercises)
			.values({
				sessionId,
				exerciseId: exercise.id,
				exerciseName: exercise.name,
				position: (last.position ?? 0) + 1,
				tier: value.tier,
				progressionPolicy: value.progressionPolicy,
				...snapshot
			})
			.returning();
		await tx
			.insert(sets)
			.values(
				Array.from({ length: value.setCount }, (_, i) => ({
					sessionId,
					sessionExerciseId: occurrence.id,
					exerciseId: exercise.id,
					gymEquipmentId: snapshot.gymEquipmentId,
					loadConvention: snapshot.loadConvention,
					position: i + 1,
					setRole: value.tier === 'main' ? ('top' as const) : ('working' as const),
					prescribedRepsMin: value.repsMin,
					prescribedRepsMax: value.repsMax,
					prescribedRir: value.rir
				}))
			);
		const [machine] = await tx
			.select()
			.from(gymEquipment)
			.where(eq(gymEquipment.id, snapshot.gymEquipmentId));
		if (machine.equipmentModelId)
			await tx
				.insert(exerciseEquipmentMap)
				.values({ exerciseId: exercise.id, equipmentModelId: machine.equipmentModelId })
				.onConflictDoNothing();
		await prefillOccurrence(tx, occurrence);
		return occurrence;
	});
}
