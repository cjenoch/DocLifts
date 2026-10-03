import { and, asc, eq, inArray, isNull, max } from 'drizzle-orm';
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
	type PerformanceIdentity,
	FREE_WEIGHT_TYPES,
	historyIdentity
} from './progression';
import { snapForEquipment } from './plates';
import { mainPrefills } from './main-prefill';
import { modelReadableBy, modelVisibleTo } from './catalog';
import { defaultMachineLabel } from '../catalog-labels';

const name = z.string().trim().min(1).max(120);
const optionalText = z.preprocess((v) => (v === '' || v == null ? undefined : v), name.optional());
// A whitespace-only label is blank too: the browser sends what was typed.
const optionalLabel = z.preprocess(
	(v) => (v == null || (typeof v === 'string' && v.trim() === '') ? undefined : v),
	name.optional()
);
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
/** The eight groups an exercise can sit in (0.7.0 migration's CHECK; machines spec Part J). */
export const EXERCISE_BODY_REGIONS = [
	'legs',
	'back',
	'chest',
	'arms',
	'shoulders',
	'glutes',
	'core',
	'full body'
] as const;
// Optional whole pounds for this gym's instance (0.3.0): blank is "unknown".
const optionalLb = z.preprocess(
	(v) => (v === '' || v == null ? undefined : v),
	z.coerce.number().int().min(1).max(2000).optional()
);
const machineSchema = z.object({
	gymId: z.string().uuid(),
	// Optional since 0.3.2: blank takes a label derived from the model.
	localLabel: optionalLabel,
	equipmentType,
	equipmentModelId: optionalId,
	manufacturer: optionalText,
	modelName: optionalText,
	stackLb: optionalLb,
	incrementLb: optionalLb
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
		/** A new exercise's picker group (0.8.0, Part J); blank = "Other". */
		bodyRegion: z.preprocess(
			(v) => (v === '' || v == null ? undefined : v),
			z.enum(EXERCISE_BODY_REGIONS).optional()
		),
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
/** Shown when the label is blank and there is no model to name the machine after. */
export const LABEL_REQUIRED_MESSAGE =
	'Give the machine a label, or choose its model so the label can be taken from it';
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
			.where(and(eq(gyms.id, value.gymId), eq(gyms.userId, userId), isNull(gyms.archivedAt)));
		if (!gym) throw new MachineInputError('Gym not found');
		let modelId = value.equipmentModelId;
		if (modelId && value.modelName)
			throw new MachineInputError('Choose existing model or enter a new one, not both');
		// A blank label is named after the model: the chosen one, or the one
		// typed in. With neither there is nothing to derive it from.
		let localLabel = value.localLabel;
		// Blank stack with a catalog model: the manufacturer's standard stack.
		// An explicit value always wins; a machine with no model gets nothing.
		let stackLb = value.stackLb;
		if (!localLabel && !modelId && !value.modelName)
			throw new MachineInputError(LABEL_REQUIRED_MESSAGE);
		if (modelId) {
			// A model is usable when it is global (owner_user_id IS NULL) or
			// belongs to this user. Anything else is not found as far as this
			// user is concerned — no 403, no distinct message. A model retired
			// by a later snapshot is not offered for new machines either;
			// machines already linked to it keep it.
			const [model] = await tx
				.select()
				.from(equipmentModels)
				.where(and(eq(equipmentModels.id, modelId), modelVisibleTo(userId)));
			if (!model || model.loadingType !== value.equipmentType)
				throw new MachineInputError('Model loading type does not match machine');
			localLabel ??= defaultMachineLabel(model);
			stackLb ??= model.standardStackLb ?? undefined;
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
			localLabel ??= defaultMachineLabel(model);
		}
		if (!localLabel) throw new MachineInputError(LABEL_REQUIRED_MESSAGE);
		const [machine] = await tx
			.insert(gymEquipment)
			.values({
				gymId: gym.id,
				localLabel,
				equipmentType: value.equipmentType,
				equipmentModelId: modelId,
				stackLb,
				incrementLb: value.incrementLb
			})
			.returning();
		return machine;
	});
}
const machineEditSchema = z.object({
	localLabel: optionalLabel,
	stackLb: optionalLb,
	incrementLb: optionalLb
});

/**
 * One machine for its edit page, with its gym and model. Ownership is in the
 * query: the machine must be under `gymId`, and that gym must be this user's.
 * Another user's machine, or a machine under a different gym, is null (D6).
 */
export async function loadMachine(db: Database, userId: string, gymId: string, machineId: string) {
	const id = z.string().uuid();
	if (!id.safeParse(gymId).success || !id.safeParse(machineId).success) return null;
	const [row] = await db
		.select({ machine: gymEquipment, gym: gyms, model: equipmentModels })
		.from(gymEquipment)
		.innerJoin(gyms, eq(gyms.id, gymEquipment.gymId))
		.leftJoin(
			equipmentModels,
			// A machine keeps its model after a snapshot retires it.
			and(eq(equipmentModels.id, gymEquipment.equipmentModelId), modelReadableBy(userId))
		)
		.where(
			and(eq(gymEquipment.id, machineId), eq(gymEquipment.gymId, gymId), eq(gyms.userId, userId))
		);
	return row ?? null;
}

/**
 * Edit a machine's label, stack and increment (0.3.2). The model is not
 * changed here. A blank label takes the model's default label, exactly as on
 * create; with no model it is refused. Blank stack or increment clears it.
 * Returns null, writing nothing, when the machine is not this user's or not
 * under `gymId`: the owner chain gym_id -> gyms.user_id is in the UPDATE.
 */
export async function updateMachine(
	db: Database,
	userId: string,
	gymId: string,
	machineId: string,
	input: unknown
) {
	const value = machineEditSchema.parse(input);
	return db.transaction(async (tx) => {
		const found = await loadMachine(tx, userId, gymId, machineId);
		if (!found) return null;
		const localLabel =
			value.localLabel ?? (found.model ? defaultMachineLabel(found.model) : undefined);
		if (!localLabel) throw new MachineInputError(LABEL_REQUIRED_MESSAGE);
		const [row] = await tx
			.update(gymEquipment)
			.set({
				localLabel,
				stackLb: value.stackLb ?? null,
				incrementLb: value.incrementLb ?? null
			})
			.where(
				and(
					eq(gymEquipment.id, machineId),
					eq(gymEquipment.gymId, gymId),
					inArray(
						gymEquipment.gymId,
						tx.select({ id: gyms.id }).from(gyms).where(eq(gyms.userId, userId))
					)
				)
			)
			.returning();
		return row ?? null;
	});
}
// Models are NOT part of this: with the 0.3.0 catalog that is 543+ rows, and
// every live-session page serialized all of them to the client while using
// none. The model list is modelChoices() in catalog.ts, narrowed per gym.
export async function machineChoices(db: Database, userId: string) {
	// gym_equipment has no owner column of its own — it belongs to whoever owns
	// the gym, so it is reached by an INNER JOIN on an already-scoped gyms row
	// rather than by a separate filter.
	return {
		// Archived gyms and machines are never offered (0.7.0); an archived gym
		// hides its machines without touching them.
		gyms: await db
			.select()
			.from(gyms)
			.where(and(eq(gyms.userId, userId), isNull(gyms.archivedAt)))
			.orderBy(asc(gyms.name)),
		// Membership in the user's gyms, expressed as a subquery rather than a
		// join. A drizzle multi-table select returns rows NESTED BY TABLE
		// ({gym_equipment: {...}, gyms: {...}}), which would silently break the
		// flat shape callers already use — machines.filter(m => m.gymId === …)
		// in the add sheet (AddSheet.svelte) and gyms/+page.svelte. inArray against a
		// subquery keeps this a single-table select, so the rows stay flat.
		machines: await db
			.select()
			.from(gymEquipment)
			.where(
				and(
					isNull(gymEquipment.archivedAt),
					inArray(
						gymEquipment.gymId,
						db
							.select({ id: gyms.id })
							.from(gyms)
							.where(and(eq(gyms.userId, userId), isNull(gyms.archivedAt)))
					)
				)
			)
			.orderBy(asc(gymEquipment.localLabel)),
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
export async function lockActive(db: Database, userId: string, sessionId: string) {
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
				eq(gyms.userId, userId),
				// An archived machine or gym cannot be chosen for a workout (0.7.0).
				isNull(gymEquipment.archivedAt),
				isNull(gyms.archivedAt)
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
export async function prefillOccurrence(
	db: Database,
	userId: string,
	occurrence: typeof sessionExercises.$inferSelect,
	/**
	 * `onlyUntouched` (0.6.1, photo blocks): rows with a saved value or note
	 * keep their prescription; only the untouched rows are prefilled.
	 */
	opts: { onlyUntouched?: boolean } = {}
) {
	const rows = await db
		.select()
		.from(sets)
		.where(eq(sets.sessionExerciseId, occurrence.id))
		.orderBy(asc(sets.position));
	// Free weights look up history on any machine (0.8.0, Part J).
	const identity: PerformanceIdentity = historyIdentity(
		occurrence.gymEquipmentId,
		occurrence.loadConvention,
		occurrence.equipmentType
	);
	const histories = await Promise.all(
		rows.map((r) =>
			getLastCompletedSet(
				db,
				userId,
				r.exerciseId,
				r.setRole,
				r.position,
				occurrence.sessionId,
				identity
			)
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
					userId,
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
					userId,
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
		if (
			opts.onlyUntouched &&
			(r.executedLoad != null || r.executedReps != null || r.executedRir != null || r.notes)
		)
			continue;
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
		await prefillOccurrence(tx, userId, updated);
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
		// A quick workout records its gym (0.5.1); with no gym chosen and no new
		// one named, the exercise goes in that gym. The session row was read
		// under the owner's lock, and machineSnapshot below re-checks the gym
		// against gyms.user_id, so this default cannot reach another user's gym.
		let gymId = value.gymId ?? (value.newGymName ? undefined : (activeSession.gymId ?? undefined));
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
		// Free weights need no gym and no equipment row (0.8.0, machines spec
		// Part J, owner decision 2026-10-02): the block stores no machine, and
		// its history follows the exercise across gyms (historyIdentity).
		const free = FREE_WEIGHT_TYPES.has(value.equipmentType) && !gymEquipmentId;
		let snapshot:
			| Awaited<ReturnType<typeof machineSnapshot>>
			| {
					gymEquipmentId: null;
					loadConvention: z.infer<typeof convention>;
					machineLabel: null;
					gymName: string | null;
					modelName: null;
					equipmentType: string;
			  };
		if (free) {
			const [gym] = gymId
				? await tx
						.select({ name: gyms.name })
						.from(gyms)
						.where(and(eq(gyms.id, gymId), eq(gyms.userId, userId), isNull(gyms.archivedAt)))
				: [];
			snapshot = {
				gymEquipmentId: null,
				loadConvention: value.loadConvention,
				machineLabel: null,
				gymName: gym?.name ?? null,
				modelName: null,
				equipmentType: value.equipmentType
			};
		} else {
			if (!gymId || !gymEquipmentId)
				throw new MachineInputError('Choose or name your gym and equipment.');
			snapshot = await machineSnapshot(tx, userId, { ...value, gymId, gymEquipmentId });
			if (snapshot.equipmentType !== value.equipmentType)
				throw new MachineInputError('Machine equipment type must match exercise');
		}
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
					bodyRegion: value.bodyRegion,
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
		const [machine] = snapshot.gymEquipmentId
			? await tx.select().from(gymEquipment).where(eq(gymEquipment.id, snapshot.gymEquipmentId))
			: [];
		if (machine?.equipmentModelId)
			await tx
				.insert(exerciseEquipmentMap)
				.values({ exerciseId: exercise.id, equipmentModelId: machine.equipmentModelId })
				.onConflictDoNothing();
		await prefillOccurrence(tx, userId, occurrence);
		return occurrence;
	});
}
