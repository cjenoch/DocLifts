/**
 * Fixing the gym list (0.7.0, SPEC "machines, gyms and pickers", Parts G, H
 * and K): remove a machine or a gym without losing history, change a
 * machine's model, and merge two rows that describe one machine.
 *
 * - **Remove** (G): a row nothing points at is deleted; anything else is
 *   archived (`archived_at`), so every past set and photo keeps working while
 *   it leaves every list and picker. An archived gym hides its machines.
 * - **Change model** (H): same loading type, in place (the machine id, and so
 *   its history, carries on); another loading type is a replace, never an
 *   in-place change, because the load convention is part of the history key.
 * - **Merge** (K): every set, session exercise and photo moves from the
 *   dropped row to the kept one, recorded in `machine_merges` so undo moves
 *   back exactly those rows.
 *
 * Each refuses while an open workout uses the row. Every function takes the
 * owner's id (D5), and the owner chain `gym_equipment.gym_id -> gyms.user_id`
 * is in every statement; another user's row is "not found" (D6).
 */
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
	equipmentModels,
	equipmentPhotos,
	exerciseEquipmentMap,
	gymEquipment,
	gyms,
	machineMerges,
	sessionExercises,
	sessions,
	sets,
	type MachineMergeMoved
} from './db/schema';
import type { Database } from './progression';
import { createMachine, MachineInputError } from './machines';
import { modelReadableBy, modelVisibleTo } from './catalog';
import { defaultMachineLabel } from '../catalog-labels';

export const FINISH_WORKOUT_FIRST = 'Finish the open workout that uses it first.';

const uuid = z.string().uuid();

/** A machine of this user under `gymId`, locked when asked, or null. */
async function ownMachine(
	db: Database,
	userId: string,
	gymId: string,
	machineId: string,
	lock = false
) {
	if (!uuid.safeParse(gymId).success || !uuid.safeParse(machineId).success) return null;
	const q = db
		.select({ machine: gymEquipment, gym: gyms })
		.from(gymEquipment)
		.innerJoin(gyms, eq(gyms.id, gymEquipment.gymId))
		.where(
			and(eq(gymEquipment.id, machineId), eq(gymEquipment.gymId, gymId), eq(gyms.userId, userId))
		);
	const [row] = lock ? await q.for('update', { of: gymEquipment }) : await q;
	return row ?? null;
}

async function ownGymRow(db: Database, userId: string, gymId: string, lock = false) {
	if (!uuid.safeParse(gymId).success) return null;
	const q = db
		.select()
		.from(gyms)
		.where(and(eq(gyms.id, gymId), eq(gyms.userId, userId)));
	const [row] = lock ? await q.for('update') : await q;
	return row ?? null;
}

/** An open (not ended, not trashed) workout of this user has an exercise on one of these machines. */
async function machinesInOpenWorkout(db: Database, userId: string, machineIds: string[]) {
	if (!machineIds.length) return false;
	const [row] = await db
		.select({ n: count() })
		.from(sessionExercises)
		.innerJoin(sessions, eq(sessions.id, sessionExercises.sessionId))
		.where(
			and(
				eq(sessions.userId, userId),
				isNull(sessions.endedAt),
				isNull(sessions.deletedAt),
				inArray(sessionExercises.gymEquipmentId, machineIds)
			)
		);
	return row.n > 0;
}

/** Anything at all that points at this machine. */
async function machineIsReferenced(db: Database, machineId: string) {
	const [row] = await db.execute<{ used: boolean }>(sql`
		SELECT EXISTS (SELECT 1 FROM ${sets} WHERE ${sets.gymEquipmentId} = ${machineId})
			OR EXISTS (SELECT 1 FROM ${sessionExercises} WHERE ${sessionExercises.gymEquipmentId} = ${machineId})
			OR EXISTS (SELECT 1 FROM ${equipmentPhotos} WHERE ${equipmentPhotos.gymEquipmentId} = ${machineId})
			OR EXISTS (SELECT 1 FROM ${machineMerges} WHERE ${machineMerges.droppedId} = ${machineId} OR ${machineMerges.keptId} = ${machineId})
			OR EXISTS (SELECT 1 FROM ${gymEquipment} WHERE ${gymEquipment.mergedIntoId} = ${machineId}) AS used`);
	return Boolean(row?.used);
}

/** Anything at all that points at this gym: machines, workouts, photos. */
async function gymIsReferenced(db: Database, gymId: string) {
	const [row] = await db.execute<{ used: boolean }>(sql`
		SELECT EXISTS (SELECT 1 FROM ${gymEquipment} WHERE ${gymEquipment.gymId} = ${gymId})
			OR EXISTS (SELECT 1 FROM ${sessions} WHERE ${sessions.gymId} = ${gymId})
			OR EXISTS (SELECT 1 FROM ${equipmentPhotos} WHERE ${equipmentPhotos.gymId} = ${gymId}) AS used`);
	return Boolean(row?.used);
}

async function gymInOpenWorkout(db: Database, userId: string, gymId: string) {
	const [own] = await db
		.select({ n: count() })
		.from(sessions)
		.where(
			and(
				eq(sessions.userId, userId),
				eq(sessions.gymId, gymId),
				isNull(sessions.endedAt),
				isNull(sessions.deletedAt)
			)
		);
	if (own.n > 0) return true;
	const machineIds = (
		await db.select({ id: gymEquipment.id }).from(gymEquipment).where(eq(gymEquipment.gymId, gymId))
	).map((m) => m.id);
	return machinesInOpenWorkout(db, userId, machineIds);
}

// ---------- Part G: remove and restore ----------

export type RemovalPlan = {
	/** What Remove will do: delete a row nothing points at, archive anything else. */
	outcome: 'delete' | 'archive';
	/** Refused until the open workout that uses it is finished. */
	blocked: boolean;
};

/** What Remove would do to this machine, for the confirmation. Null when not this user's. */
export async function machineRemovalPlan(
	db: Database,
	userId: string,
	gymId: string,
	machineId: string
): Promise<RemovalPlan | null> {
	const found = await ownMachine(db, userId, gymId, machineId);
	if (!found) return null;
	return {
		outcome: (await machineIsReferenced(db, machineId)) ? 'archive' : 'delete',
		blocked: await machinesInOpenWorkout(db, userId, [machineId])
	};
}

/**
 * Remove a machine: deleted when nothing points at it, else archived. Refused
 * (MachineInputError) while an open workout uses it. Null when not this user's.
 */
export async function removeMachine(
	db: Database,
	userId: string,
	gymId: string,
	machineId: string
): Promise<{ outcome: 'deleted' | 'archived' } | null> {
	return db.transaction(async (tx) => {
		const found = await ownMachine(tx, userId, gymId, machineId, true);
		if (!found) return null;
		if (await machinesInOpenWorkout(tx, userId, [machineId]))
			throw new MachineInputError(FINISH_WORKOUT_FIRST);
		if (!(await machineIsReferenced(tx, machineId))) {
			await tx.delete(gymEquipment).where(eq(gymEquipment.id, machineId));
			return { outcome: 'deleted' };
		}
		await tx
			.update(gymEquipment)
			.set({ archivedAt: found.machine.archivedAt ?? new Date() })
			.where(eq(gymEquipment.id, machineId));
		return { outcome: 'archived' };
	});
}

/**
 * Bring an archived machine back. A machine archived by a merge comes back
 * only through that merge's undo. Null when not this user's or not archived.
 */
export async function restoreMachine(
	db: Database,
	userId: string,
	gymId: string,
	machineId: string
) {
	return db.transaction(async (tx) => {
		const found = await ownMachine(tx, userId, gymId, machineId, true);
		if (!found || !found.machine.archivedAt) return null;
		if (found.machine.mergedIntoId)
			throw new MachineInputError('This machine was merged. Undo the merge to bring it back.');
		const [row] = await tx
			.update(gymEquipment)
			.set({ archivedAt: null })
			.where(eq(gymEquipment.id, machineId))
			.returning();
		return row;
	});
}

/** What Remove would do to this gym. Null when not this user's. */
export async function gymRemovalPlan(
	db: Database,
	userId: string,
	gymId: string
): Promise<RemovalPlan | null> {
	const gym = await ownGymRow(db, userId, gymId);
	if (!gym) return null;
	return {
		outcome: (await gymIsReferenced(db, gymId)) ? 'archive' : 'delete',
		blocked: await gymInOpenWorkout(db, userId, gymId)
	};
}

/**
 * Remove a gym: deleted when it has no machines, workouts or photos, else
 * archived. Its machines are left as they are: lists reach machines through
 * the gym, so they are hidden with it and come back with it.
 */
export async function removeGym(
	db: Database,
	userId: string,
	gymId: string
): Promise<{ outcome: 'deleted' | 'archived' } | null> {
	return db.transaction(async (tx) => {
		const gym = await ownGymRow(tx, userId, gymId, true);
		if (!gym) return null;
		if (await gymInOpenWorkout(tx, userId, gymId))
			throw new MachineInputError(FINISH_WORKOUT_FIRST);
		if (!(await gymIsReferenced(tx, gymId))) {
			await tx.delete(gyms).where(and(eq(gyms.id, gymId), eq(gyms.userId, userId)));
			return { outcome: 'deleted' };
		}
		await tx
			.update(gyms)
			.set({ archivedAt: gym.archivedAt ?? new Date() })
			.where(and(eq(gyms.id, gymId), eq(gyms.userId, userId)));
		return { outcome: 'archived' };
	});
}

/** Bring an archived gym back, with every machine that was not archived on its own. */
export async function restoreGym(db: Database, userId: string, gymId: string) {
	if (!uuid.safeParse(gymId).success) return null;
	const [row] = await db
		.update(gyms)
		.set({ archivedAt: null })
		.where(and(eq(gyms.id, gymId), eq(gyms.userId, userId), isNotNull(gyms.archivedAt)))
		.returning();
	return row ?? null;
}

/** Archived gyms, and archived machines of active gyms, for the Gyms page's Archived sections. */
export async function archivedRows(db: Database, userId: string) {
	const archivedGyms = await db
		.select()
		.from(gyms)
		.where(and(eq(gyms.userId, userId), isNotNull(gyms.archivedAt)))
		.orderBy(asc(gyms.name));
	const archivedMachines = await db
		.select({ machine: gymEquipment })
		.from(gymEquipment)
		.innerJoin(gyms, eq(gyms.id, gymEquipment.gymId))
		.where(
			and(eq(gyms.userId, userId), isNull(gyms.archivedAt), isNotNull(gymEquipment.archivedAt))
		)
		.orderBy(asc(gymEquipment.localLabel));
	return { gyms: archivedGyms, machines: archivedMachines.map((r) => r.machine) };
}

// ---------- Part H: change a machine's model ----------

const changeSchema = z.object({
	/** A model id, or '' for "No model". */
	modelId: z.union([uuid, z.literal('')])
});

export type ModelChange =
	| { outcome: 'changed'; stackOffer: number | null }
	/** The model's loading type differs: offer Replace, never change in place. */
	| { outcome: 'replace'; modelId: string; label: string };

/**
 * Change a machine's model in place (same loading type). The machine id does
 * not change, so its history and suggestions carry on. A label that still
 * equals the old model's default label takes the new one; a typed label
 * stays. Stack and increment are never overwritten: a differing standard
 * stack comes back as `stackOffer`, applied only by `applyStandardStack`.
 * Each exercise logged on the machine gets an exercise_equipment_map pair for
 * the new model; old pairs stay. Past workouts keep the names they recorded.
 */
export async function changeMachineModel(
	db: Database,
	userId: string,
	gymId: string,
	machineId: string,
	input: unknown
): Promise<ModelChange | null> {
	const value = changeSchema.parse(input);
	return db.transaction(async (tx) => {
		const found = await ownMachine(tx, userId, gymId, machineId, true);
		if (!found || found.machine.archivedAt) return null;
		if (await machinesInOpenWorkout(tx, userId, [machineId]))
			throw new MachineInputError(FINISH_WORKOUT_FIRST);
		const machine = found.machine;
		const [oldModel] = machine.equipmentModelId
			? await tx
					.select()
					.from(equipmentModels)
					.where(and(eq(equipmentModels.id, machine.equipmentModelId), modelReadableBy(userId)))
			: [];
		const newModel = value.modelId
			? (
					await tx
						.select()
						.from(equipmentModels)
						.where(and(eq(equipmentModels.id, value.modelId), modelVisibleTo(userId)))
				)[0]
			: null;
		if (value.modelId && !newModel) throw new MachineInputError('Model not found');
		if (newModel && newModel.loadingType !== machine.equipmentType)
			return {
				outcome: 'replace',
				modelId: newModel.id,
				label: [newModel.manufacturer, newModel.code, newModel.name].filter(Boolean).join(' ')
			};

		const labelIsDefault = oldModel && machine.localLabel === defaultMachineLabel(oldModel);
		const localLabel =
			labelIsDefault && newModel ? defaultMachineLabel(newModel) : machine.localLabel;
		await tx
			.update(gymEquipment)
			.set({ equipmentModelId: newModel?.id ?? null, localLabel })
			.where(and(eq(gymEquipment.id, machineId), eq(gymEquipment.gymId, gymId)));
		if (newModel) {
			const logged = await exercisesLoggedOn(tx, [machineId]);
			if (logged.length)
				await tx
					.insert(exerciseEquipmentMap)
					.values(logged.map((exerciseId) => ({ exerciseId, equipmentModelId: newModel.id })))
					.onConflictDoNothing();
		}
		const standard = newModel?.standardStackLb ?? null;
		return {
			outcome: 'changed',
			stackOffer: standard != null && standard !== machine.stackLb ? standard : null
		};
	});
}

/** The one-tap stack offer: set the machine's stack to its model's standard stack. */
export async function applyStandardStack(
	db: Database,
	userId: string,
	gymId: string,
	machineId: string
) {
	return db.transaction(async (tx) => {
		const found = await ownMachine(tx, userId, gymId, machineId, true);
		if (!found || !found.machine.equipmentModelId) return null;
		const [model] = await tx
			.select()
			.from(equipmentModels)
			.where(and(eq(equipmentModels.id, found.machine.equipmentModelId), modelReadableBy(userId)));
		if (!model?.standardStackLb) return null;
		const [row] = await tx
			.update(gymEquipment)
			.set({ stackLb: model.standardStackLb })
			.where(eq(gymEquipment.id, machineId))
			.returning();
		return row;
	});
}

/**
 * Replace a machine with a new one on a model of another loading type: the
 * old one is removed (archived when it has history, deleted when not) and a
 * new one is created. Suggestions start fresh on the new machine; past
 * workouts keep the old one.
 */
export async function replaceMachine(
	db: Database,
	userId: string,
	gymId: string,
	machineId: string,
	input: unknown
) {
	const { modelId } = z.object({ modelId: uuid }).parse(input);
	return db.transaction(async (tx) => {
		const found = await ownMachine(tx, userId, gymId, machineId, true);
		if (!found || found.machine.archivedAt) return null;
		const [model] = await tx
			.select()
			.from(equipmentModels)
			.where(and(eq(equipmentModels.id, modelId), modelVisibleTo(userId)));
		if (!model) throw new MachineInputError('Model not found');
		const removed = await removeMachine(tx, userId, gymId, machineId);
		if (!removed) return null;
		const label = found.machine.localLabel;
		const keepsLabel = !found.machine.equipmentModelId;
		const created = await createMachine(tx, userId, {
			gymId,
			localLabel: keepsLabel ? label : undefined,
			equipmentType: model.loadingType,
			equipmentModelId: model.id
		});
		return { machine: created, old: removed.outcome };
	});
}

async function exercisesLoggedOn(db: Database, machineIds: string[]) {
	if (!machineIds.length) return [];
	const rows = await db
		.selectDistinct({ exerciseId: sessionExercises.exerciseId })
		.from(sessionExercises)
		.where(inArray(sessionExercises.gymEquipmentId, machineIds));
	const fromSets = await db
		.selectDistinct({ exerciseId: sets.exerciseId })
		.from(sets)
		.where(inArray(sets.gymEquipmentId, machineIds));
	return [...new Set([...rows, ...fromSets].map((r) => r.exerciseId))];
}

// ---------- Part K: merge two machines ----------

/** Other active machines in the same gym with the same loading type: what "Same machine as…" lists. */
export async function mergeCandidates(
	db: Database,
	userId: string,
	gymId: string,
	machineId: string
) {
	const found = await ownMachine(db, userId, gymId, machineId);
	if (!found || found.machine.archivedAt) return [];
	const rows = await db
		.select({ machine: gymEquipment })
		.from(gymEquipment)
		.innerJoin(gyms, eq(gyms.id, gymEquipment.gymId))
		.where(
			and(
				eq(gyms.userId, userId),
				eq(gymEquipment.gymId, gymId),
				ne(gymEquipment.id, machineId),
				isNull(gymEquipment.archivedAt),
				eq(gymEquipment.equipmentType, found.machine.equipmentType)
			)
		)
		.orderBy(asc(gymEquipment.localLabel));
	return rows.map((r) => r.machine);
}

export type MergePreview = {
	sets: number;
	workouts: number;
	photos: number;
	from: Date | null;
	to: Date | null;
	/** The two rows hold sets in different weight formats: those histories stay separate. */
	formatsDiffer: boolean;
	/** The row to keep by default: the one with a model, or with more history. */
	suggestedKeptId: string;
};

async function historyOf(db: Database, machineId: string) {
	const [row] = await db
		.select({
			sets: count(sets.id),
			workouts: sql<number>`count(distinct ${sets.sessionId})::int`,
			from: sql<Date | null>`min(${sessions.startedAt})`,
			to: sql<Date | null>`max(${sessions.startedAt})`
		})
		.from(sets)
		.innerJoin(sessions, eq(sessions.id, sets.sessionId))
		.where(eq(sets.gymEquipmentId, machineId));
	const conventions = (
		await db
			.selectDistinct({ c: sets.loadConvention })
			.from(sets)
			.where(eq(sets.gymEquipmentId, machineId))
	).map((r) => r.c);
	return { ...row, conventions };
}

/** What a merge of `droppedId` into `keptId` would move. Null unless both are this user's, in this gym, same type. */
export async function mergePreview(
	db: Database,
	userId: string,
	gymId: string,
	keptId: string,
	droppedId: string
): Promise<MergePreview | null> {
	const kept = await ownMachine(db, userId, gymId, keptId);
	const dropped = await ownMachine(db, userId, gymId, droppedId);
	if (!kept || !dropped || keptId === droppedId) return null;
	if (kept.machine.equipmentType !== dropped.machine.equipmentType) return null;
	const a = await historyOf(db, keptId);
	const b = await historyOf(db, droppedId);
	const [photos] = await db
		.select({ n: count() })
		.from(equipmentPhotos)
		.where(eq(equipmentPhotos.gymEquipmentId, droppedId));
	const conventions = new Set([...a.conventions, ...b.conventions]);
	const hasModel = (m: typeof kept.machine) => m.equipmentModelId != null;
	const suggestedKeptId =
		hasModel(kept.machine) !== hasModel(dropped.machine)
			? hasModel(kept.machine)
				? keptId
				: droppedId
			: b.sets > a.sets
				? droppedId
				: keptId;
	return {
		sets: b.sets,
		workouts: b.workouts,
		photos: photos.n,
		from: b.from,
		to: b.to,
		formatsDiffer: conventions.size > 1,
		suggestedKeptId
	};
}

/**
 * Merge `droppedId` into `keptId`, in one transaction with both rows locked:
 * sets, session exercises and photos move to the kept row (session exercises
 * keep the names they recorded); exercises that moved get map pairs for the
 * kept row's model; the dropped row is archived with `merged_into_id`; one
 * `machine_merges` row lists every moved id. Same gym and loading type only;
 * refused while an open workout uses either machine.
 */
export async function mergeMachines(db: Database, userId: string, gymId: string, input: unknown) {
	const { keptId, droppedId } = z.object({ keptId: uuid, droppedId: uuid }).parse(input);
	if (keptId === droppedId) throw new MachineInputError('Choose two different machines');
	return db.transaction(async (tx) => {
		// Lock in a fixed order so two merges of the same pair cannot deadlock.
		const [first, second] = [keptId, droppedId].sort();
		const a = await ownMachine(tx, userId, gymId, first, true);
		const b = await ownMachine(tx, userId, gymId, second, true);
		if (!a || !b) return null;
		const kept = a.machine.id === keptId ? a.machine : b.machine;
		const dropped = a.machine.id === droppedId ? a.machine : b.machine;
		if (kept.archivedAt || dropped.archivedAt) return null;
		if (kept.equipmentType !== dropped.equipmentType)
			throw new MachineInputError('Only machines of the same type can be merged');
		if (await machinesInOpenWorkout(tx, userId, [keptId, droppedId]))
			throw new MachineInputError(FINISH_WORKOUT_FIRST);

		const moved: MachineMergeMoved = {
			sets: (
				await tx
					.update(sets)
					.set({ gymEquipmentId: keptId })
					.where(eq(sets.gymEquipmentId, droppedId))
					.returning({ id: sets.id })
			).map((r) => r.id),
			sessionExercises: (
				await tx
					.update(sessionExercises)
					.set({ gymEquipmentId: keptId })
					.where(eq(sessionExercises.gymEquipmentId, droppedId))
					.returning({ id: sessionExercises.id })
			).map((r) => r.id),
			photos: (
				await tx
					.update(equipmentPhotos)
					.set({ gymEquipmentId: keptId })
					.where(
						and(eq(equipmentPhotos.gymEquipmentId, droppedId), eq(equipmentPhotos.userId, userId))
					)
					.returning({ id: equipmentPhotos.id })
			).map((r) => r.id)
		};
		if (kept.equipmentModelId) {
			const exerciseIds = await exercisesLoggedOn(tx, [keptId]);
			if (exerciseIds.length)
				await tx
					.insert(exerciseEquipmentMap)
					.values(
						exerciseIds.map((exerciseId) => ({
							exerciseId,
							equipmentModelId: kept.equipmentModelId!
						}))
					)
					.onConflictDoNothing();
		}
		await tx
			.update(gymEquipment)
			.set({ archivedAt: new Date(), mergedIntoId: keptId })
			.where(eq(gymEquipment.id, droppedId));
		const [merge] = await tx
			.insert(machineMerges)
			.values({ userId, droppedId, keptId, moved })
			.returning();
		return merge;
	});
}

/** The latest merge into this machine that can still be undone, for "Undo merge". */
export async function undoableMergeInto(db: Database, userId: string, keptId: string) {
	if (!uuid.safeParse(keptId).success) return null;
	const [row] = await db
		.select({ merge: machineMerges, droppedLabel: gymEquipment.localLabel })
		.from(machineMerges)
		.innerJoin(gymEquipment, eq(gymEquipment.id, machineMerges.droppedId))
		.where(
			and(
				eq(machineMerges.userId, userId),
				eq(machineMerges.keptId, keptId),
				isNull(machineMerges.undoneAt)
			)
		)
		.orderBy(desc(machineMerges.createdAt))
		.limit(1);
	return row ?? null;
}

/**
 * Undo a merge: move back exactly the rows it lists (those still on the kept
 * machine; sets logged there after the merge stay), restore the dropped
 * machine, and mark the merge undone. Refused while an open workout uses
 * either machine. Null when not this user's or already undone.
 */
export async function undoMerge(db: Database, userId: string, mergeId: string) {
	if (!uuid.safeParse(mergeId).success) return null;
	return db.transaction(async (tx) => {
		const [merge] = await tx
			.select()
			.from(machineMerges)
			.where(
				and(
					eq(machineMerges.id, mergeId),
					eq(machineMerges.userId, userId),
					isNull(machineMerges.undoneAt)
				)
			)
			.for('update');
		if (!merge) return null;
		if (await machinesInOpenWorkout(tx, userId, [merge.keptId, merge.droppedId]))
			throw new MachineInputError(FINISH_WORKOUT_FIRST);
		const { sets: setIds, sessionExercises: occurrenceIds, photos: photoIds } = merge.moved;
		if (setIds.length)
			await tx
				.update(sets)
				.set({ gymEquipmentId: merge.droppedId })
				.where(and(inArray(sets.id, setIds), eq(sets.gymEquipmentId, merge.keptId)));
		if (occurrenceIds.length)
			await tx
				.update(sessionExercises)
				.set({ gymEquipmentId: merge.droppedId })
				.where(
					and(
						inArray(sessionExercises.id, occurrenceIds),
						eq(sessionExercises.gymEquipmentId, merge.keptId)
					)
				);
		if (photoIds.length)
			await tx
				.update(equipmentPhotos)
				.set({ gymEquipmentId: merge.droppedId })
				.where(
					and(
						inArray(equipmentPhotos.id, photoIds),
						eq(equipmentPhotos.gymEquipmentId, merge.keptId),
						eq(equipmentPhotos.userId, userId)
					)
				);
		await tx
			.update(gymEquipment)
			.set({ archivedAt: null, mergedIntoId: null })
			.where(eq(gymEquipment.id, merge.droppedId));
		const [undone] = await tx
			.update(machineMerges)
			.set({ undoneAt: new Date() })
			.where(eq(machineMerges.id, merge.id))
			.returning();
		return undone;
	});
}
