import { and, asc, eq, inArray, isNull, max, or } from 'drizzle-orm';
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
import { dayExercises } from './db/schema';
import {
	computeConsecutiveBackwards,
	defaultIncrement,
	getLastCompletedSet,
	HELD_NO_RULE_REASONING,
	resolveTargets,
	round05,
	suggestNextLoad,
	type Database,
	type PerformanceIdentity
} from './progression';
import { snapForEquipment } from './plates';
import { mainPrefills } from './main-prefill';

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
		requestId: optionalId,
		exerciseId: optionalId,
		exerciseName: optionalText,
		canonicalMovement: optionalText,
		equipmentType,
		isLowerBody: z.preprocess((v) => (v == null ? false : v === '1' ? true : v), z.boolean()),
		gymId: optionalId,
		gymEquipmentId: optionalId,
		newGymName: optionalText,
		newMachineName: optionalText,
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
export async function createGym(db: Database, userId: string, input: unknown) {
	const value = z.object({ name }).parse(input);
	const [gym] = await db
		.insert(gyms)
		.values({ ...value, userId })
		.returning();
	return gym;
}
export async function createMachine(db: Database, userId: string, input: unknown) {
	const value = machineSchema.parse(input);
	if (Boolean(value.manufacturer) !== Boolean(value.modelName))
		throw new MachineInputError('Provide both manufacturer and model name, or leave both unknown');
	return db.transaction(async (tx) => {
		// Ownership is part of the lookup, not a pre-check that could race:
		// another user's gym is indistinguishable from a missing one.
		const [gym] = await tx
			.select()
			.from(gyms)
			.where(and(eq(gyms.id, value.gymId), eq(gyms.userId, userId)));
		if (!gym) throw new MachineInputError('Gym not found');
		let modelId = value.equipmentModelId;
		if (modelId && value.modelName)
			throw new MachineInputError('Choose existing model or enter a new one, not both');
		if (modelId) {
			// A model is usable when it is global (owner_user_id IS NULL) or
			// belongs to this user. Anything else is not found as far as this
			// user is concerned — no 403, no distinct message.
			const [model] = await tx
				.select()
				.from(equipmentModels)
				.where(
					and(
						eq(equipmentModels.id, modelId),
						or(isNull(equipmentModels.ownerUserId), eq(equipmentModels.ownerUserId, userId))
					)
				);
			if (!model || model.loadingType !== value.equipmentType)
				throw new MachineInputError('Model loading type does not match machine');
		} else if (value.manufacturer && value.modelName) {
			const [model] = await tx
				.insert(equipmentModels)
				.values({
					manufacturer: value.manufacturer,
					name: value.modelName,
					loadingType: value.equipmentType,
					ownerUserId: userId
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
export async function machineChoices(db: Database, userId: string) {
	// gym_equipment has no owner column of its own — it belongs to whoever owns
	// the gym, so it is reached by an INNER JOIN on an already-scoped gyms row
	// rather than by a separate filter.
	return {
		gyms: await db.select().from(gyms).where(eq(gyms.userId, userId)).orderBy(asc(gyms.name)),
		// Membership in the user's gyms, expressed as a subquery rather than a
		// join. A drizzle multi-table select returns rows NESTED BY TABLE
		// ({gym_equipment: {...}, gyms: {...}}), which would silently break the
		// flat shape callers already use — machines.filter(m => m.gymId === …)
		// in AddWorkoutExercise.svelte and gyms/+page.svelte. inArray against a
		// subquery keeps this a single-table select, so the rows stay flat.
		machines: await db
			.select()
			.from(gymEquipment)
			.where(
				inArray(
					gymEquipment.gymId,
					db.select({ id: gyms.id }).from(gyms).where(eq(gyms.userId, userId))
				)
			)
			.orderBy(asc(gymEquipment.localLabel)),
		models: await db
			.select()
			.from(equipmentModels)
			.where(or(isNull(equipmentModels.ownerUserId), eq(equipmentModels.ownerUserId, userId)))
			.orderBy(asc(equipmentModels.name)),
		exercises: await db
			.select()
			.from(exercises)
			.where(eq(exercises.userId, userId))
			.orderBy(asc(exercises.name))
	};
}
// userId is part of the row lock's WHERE, not a filter applied after it.
// Another user's session is 'not found' here, identically to a nonexistent
// one — no 403, no different message (D6).
async function lockActive(db: Database, userId: string, sessionId: string) {
	z.string().uuid().parse(sessionId);
	const [session] = await db
		.select()
		.from(sessions)
		.where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
		.for('update');
	if (!session || session.deletedAt) throw new MachineInputError('Session not found');
	if (session.endedAt) throw new MachineInputError('Session has ended');
	return session;
}
async function machineSnapshot(db: Database, userId: string, input: unknown) {
	const value = identitySchema.parse(input);
	const [row] = await db
		.select({ machine: gymEquipment, gym: gyms, model: equipmentModels })
		.from(gymEquipment)
		.innerJoin(gyms, eq(gyms.id, gymEquipment.gymId))
		.leftJoin(equipmentModels, eq(equipmentModels.id, gymEquipment.equipmentModelId))
		.where(
			and(
				eq(gymEquipment.id, value.gymEquipmentId),
				eq(gymEquipment.gymId, value.gymId),
				eq(gyms.userId, userId)
			)
		);
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
	const main =
		occurrence.tier === 'main'
			? await mainPrefills(
					db,
					occurrence.exerciseId,
					rows.map((r, i) => ({
						position: r.position,
						setRole: r.setRole,
						targetRepsMax: r.prescribedRepsMax,
						targetRepsMin: r.prescribedRepsMin,
						targetRir: r.prescribedRir,
						history: histories[i]
					})),
					occurrence.progressionPolicy,
					exercise.isLowerBody,
					identity
				)
			: null;
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
			// M2 (2026-09-28): each position carries its own rep range / RIR
			// target — no more judging every position against position 1's.
			relevantSets: working.map((v) => {
				const targets = resolveTargets(
					{
						targetRepsMax: v.r.prescribedRepsMax,
						targetRepsMin: v.r.prescribedRepsMin,
						targetRir: v.r.prescribedRir
					},
					v.h
				);
				return {
					position: v.r.position,
					load: v.h!.executedLoad!,
					reps: v.h!.executedReps!,
					rir: v.h!.executedRir ?? targets.targetRir,
					...targets
				};
			}),
			increment: defaultIncrement(exercise.isLowerBody),
			consecutiveBackwards: Math.min(...backwards)
		});
	}
	for (let i = 0; i < rows.length; i++) {
		const r = rows[i],
			h = histories[i];
		let load = h?.executedLoad ?? null;
		let reasoning: string | null = null;
		if (main) {
			const prefill = main.get(r.position)!;
			load = prefill.load;
			reasoning = prefill.reasoning;
		} else if (load != null && h && r.setRole !== 'warmup') {
			if (occurrence.tier !== 'main' && r.setRole === 'working') {
				if (groupDecision) {
					load =
						groupDecision.kind === 'advance'
							? load + groupDecision.load - baseline
							: groupDecision.kind === 'deload'
								? baseline === 0
									? 0
									: round05((load * groupDecision.load) / baseline)
								: load;
					reasoning = groupDecision.reasoning;
				} else reasoning = 'held: incomplete working-set history for this machine';
			} else {
				// M1 (2026-09-28): non-main, non-working rows (in practice legacy
				// 'backoff'/'top' rows on secondary/isolation occurrences) hold at
				// their last executed load. Calling the engine per-row here would
				// let a single clearing row advance past the all-sets-clear gate —
				// the same trap sessions.ts's per-row fallback deliberately avoids.
				reasoning = HELD_NO_RULE_REASONING;
			}
		}
		// Snapshot-semantics exception, on purpose: this rewrites prescribed_load
		// and suggestion_reasoning on a live session's already-snapshotted rows.
		// Rebinding changes which history the prescription must come from, so
		// the load is re-derived. bindSessionMachine guards it (no executed
		// values or notes saved, session not ended); reps/RIR/role/metric are
		// left alone. Documented in CLAUDE.md §Snapshot semantics.
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
	userId: string,
	sessionId: string,
	occurrenceId: string,
	input: unknown
) {
	z.object({ confirm: z.literal('CHANGE') }).parse(input);
	z.string().uuid().parse(occurrenceId);
	return db.transaction(async (tx) => {
		await lockActive(tx, userId, sessionId);
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
		const snapshot = await machineSnapshot(tx, userId, input);
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
export async function addSessionExercise(
	db: Database,
	userId: string,
	sessionId: string,
	input: unknown
) {
	const value = addSchema.parse(input);
	return db.transaction(async (tx) => {
		const activeSession = await lockActive(tx, userId, sessionId);
		if (value.requestId) {
			const [existing] = await tx
				.select()
				.from(sessionExercises)
				.where(eq(sessionExercises.id, value.requestId));
			if (existing) {
				if (existing.sessionId !== sessionId)
					throw new MachineInputError('Please reload and try again.');
				return existing;
			}
		}
		let gymId = value.gymId;
		let gymEquipmentId = value.gymEquipmentId;
		if (!gymId && value.newGymName) {
			const gym = await createGym(tx, userId, { name: value.newGymName });
			gymId = gym.id;
		}
		if (!gymEquipmentId && gymId && value.newMachineName) {
			const machine = await createMachine(tx, userId, {
				gymId,
				localLabel: value.newMachineName,
				equipmentType: value.equipmentType
			});
			gymEquipmentId = machine.id;
		}
		if (!gymId || !gymEquipmentId)
			throw new MachineInputError('Choose or name your gym and equipment.');
		const snapshot = await machineSnapshot(tx, userId, { ...value, gymId, gymEquipmentId });
		if (snapshot.equipmentType !== value.equipmentType)
			throw new MachineInputError('Machine equipment type must match exercise');
		let exercise;
		if (value.exerciseId) {
			[exercise] = await tx
				.select()
				.from(exercises)
				.where(and(eq(exercises.id, value.exerciseId), eq(exercises.userId, userId)));
			if (!exercise || exercise.equipmentType !== value.equipmentType)
				throw new MachineInputError('Exercise equipment type mismatch');
		} else {
			// The duplicate-name guard is scoped to this user as well. Left
			// global, user B naming their bench "Bench Press" after user A had
			// created one would be refused — the checklist requires that call
			// to SUCCEED with B's own row.
			const existing = await tx
				.select()
				.from(exercises)
				.where(and(eq(exercises.name, value.exerciseName!), eq(exercises.userId, userId)));
			if (existing.length)
				throw new MachineInputError('Exercise name already exists; select it from the list');
			[exercise] = await tx
				.insert(exercises)
				.values({
					name: value.exerciseName!,
					equipmentType: value.equipmentType,
					canonicalMovement: value.canonicalMovement,
					isLowerBody: value.isLowerBody,
					userId
				})
				.returning();
		}
		const [last] = await tx
			.select({ position: max(sessionExercises.position) })
			.from(sessionExercises)
			.where(eq(sessionExercises.sessionId, sessionId));
		const [templateLast] = await tx
			.select({ position: max(dayExercises.position) })
			.from(dayExercises)
			.where(eq(dayExercises.dayId, activeSession.dayId));
		const [occurrence] = await tx
			.insert(sessionExercises)
			.values({
				...(value.requestId ? { id: value.requestId } : {}),
				sessionId,
				exerciseId: exercise.id,
				exerciseName: exercise.name,
				position: Math.max(last.position ?? 0, templateLast.position ?? 0) + 1,
				tier: value.tier,
				progressionPolicy: value.progressionPolicy,
				...snapshot
			})
			.returning();
		await tx.insert(sets).values(
			Array.from({ length: value.setCount }, (_, i) => ({
				userId,
				sessionId,
				sessionExerciseId: occurrence.id,
				exerciseId: exercise.id,
				gymEquipmentId: snapshot.gymEquipmentId,
				loadConvention: snapshot.loadConvention,
				position: i + 1,
				setRole:
					value.tier === 'main'
						? i === 0
							? ('top' as const)
							: ('backoff' as const)
						: ('working' as const),
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
