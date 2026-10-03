/**
 * What the add sheet shows (0.8.0, SPEC "machines, gyms and pickers", Parts I
 * and J): the user's active machines with their model, body region, newest
 * photo and last use; the user's exercises with their region and last top
 * set; what was done on each machine; and the weight format to reuse for each
 * exercise and machine. One owner-scoped read (D5): machines through
 * `gyms.user_id`, exercises and sets through `user_id`. Archived gyms,
 * machines and exercises, and the photo placeholder exercise, never appear.
 */
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import {
	equipmentModels,
	equipmentPhotos,
	exerciseEquipmentMap,
	exercises,
	gymEquipment,
	gyms
} from './db/schema';
import { modelReadableBy } from './catalog';
import { lastUsedGymId } from './quick-workouts';
import { PLACEHOLDER_MOVEMENT } from './photo-workout';
import { FREE_WEIGHT_TYPES, type Database } from './progression';

export type LastTop = { at: string; load: number; reps: number };
export type PickerMachine = {
	id: string;
	gymId: string;
	label: string;
	equipmentType: string;
	modelName: string | null;
	modelCode: string | null;
	/** From the machine's catalog model; null = "Other". */
	bodyRegion: string | null;
	photoId: string | null;
	lastUsedAt: string | null;
	lastExerciseId: string | null;
	lastTop: LastTop | null;
	/** Exercises done on it (newest first), then ones linked to its model. */
	exerciseIds: string[];
};
export type PickerExercise = {
	id: string;
	name: string;
	equipmentType: string;
	isLowerBody: boolean;
	bodyRegion: string | null;
	lastTop: LastTop | null;
};
export type PickerData = {
	gyms: { id: string; name: string }[];
	/** The gym the sheet opens on: the workout's, else the one used last. */
	gymId: string | null;
	machines: PickerMachine[];
	exercises: PickerExercise[];
	/** The last eight exercises logged, newest first. */
	recentExerciseIds: string[];
	/** Per gym, the last five machines used there, newest first. */
	recentMachineIds: Record<string, string[]>;
	/** `${exerciseId}|${machineId}` (machine '' for free weights) -> weight format last used. */
	conventions: Record<string, string>;
	/** Per exercise and gym, the machine it was last done on there: `${exerciseId}|${gymId}`. */
	lastMachineAt: Record<string, string>;
};

const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);

export async function pickerData(
	db: Database,
	userId: string,
	sessionGymId: string | null
): Promise<PickerData> {
	const gymRows = await db
		.select({ id: gyms.id, name: gyms.name })
		.from(gyms)
		.where(and(eq(gyms.userId, userId), isNull(gyms.archivedAt)))
		.orderBy(asc(gyms.name));
	const machineRows = await db
		.select({
			id: gymEquipment.id,
			gymId: gymEquipment.gymId,
			label: gymEquipment.localLabel,
			equipmentType: gymEquipment.equipmentType,
			modelId: gymEquipment.equipmentModelId,
			modelName: equipmentModels.name,
			manufacturer: equipmentModels.manufacturer,
			modelCode: equipmentModels.code,
			bodyRegion: equipmentModels.bodyRegion,
			photoId: sql<string | null>`(
				SELECT ${equipmentPhotos.id} FROM ${equipmentPhotos}
				WHERE ${equipmentPhotos.gymEquipmentId} = ${gymEquipment.id}
				  AND ${equipmentPhotos.userId} = ${userId}
				  AND ${equipmentPhotos.status} = 'confirmed'
				ORDER BY ${equipmentPhotos.createdAt} DESC LIMIT 1)`
		})
		.from(gymEquipment)
		.innerJoin(gyms, eq(gyms.id, gymEquipment.gymId))
		.leftJoin(
			equipmentModels,
			and(eq(equipmentModels.id, gymEquipment.equipmentModelId), modelReadableBy(userId))
		)
		.where(and(eq(gyms.userId, userId), isNull(gyms.archivedAt), isNull(gymEquipment.archivedAt)))
		.orderBy(asc(gymEquipment.localLabel));

	const exerciseRows = await db
		.select({
			id: exercises.id,
			name: exercises.name,
			equipmentType: exercises.equipmentType,
			isLowerBody: exercises.isLowerBody,
			bodyRegion: exercises.bodyRegion
		})
		.from(exercises)
		.where(
			and(
				eq(exercises.userId, userId),
				isNull(exercises.archivedAt),
				sql`${exercises.canonicalMovement} IS DISTINCT FROM ${PLACEHOLDER_MOVEMENT}`
			)
		)
		.orderBy(asc(exercises.name));

	// The top set of the latest finished workout, per exercise and per machine:
	// the heaviest executed set of that workout. History filters as everywhere
	// (CLAUDE.md): ended, not deleted, load and reps present.
	const topByExercise = await db.execute<{
		exercise_id: string;
		started_at: Date;
		load: number;
		reps: number;
	}>(sql`
		SELECT DISTINCT ON (st.exercise_id) st.exercise_id, s.started_at,
			st.executed_load AS load, st.executed_reps AS reps
		FROM sets st JOIN sessions s ON s.id = st.session_id
		WHERE st.user_id = ${userId} AND s.user_id = ${userId}
		  AND s.ended_at IS NOT NULL AND s.deleted_at IS NULL
		  AND st.executed_load IS NOT NULL AND st.executed_reps IS NOT NULL
		ORDER BY st.exercise_id, s.started_at DESC, st.executed_load DESC, st.executed_reps DESC`);
	const topByMachine = await db.execute<{
		machine_id: string;
		exercise_id: string;
		started_at: Date;
		load: number;
		reps: number;
	}>(sql`
		SELECT DISTINCT ON (st.gym_equipment_id) st.gym_equipment_id AS machine_id, st.exercise_id,
			s.started_at, st.executed_load AS load, st.executed_reps AS reps
		FROM sets st JOIN sessions s ON s.id = st.session_id
		WHERE st.user_id = ${userId} AND s.user_id = ${userId} AND st.gym_equipment_id IS NOT NULL
		  AND s.ended_at IS NOT NULL AND s.deleted_at IS NULL
		  AND st.executed_load IS NOT NULL AND st.executed_reps IS NOT NULL
		ORDER BY st.gym_equipment_id, s.started_at DESC, st.executed_load DESC, st.executed_reps DESC`);
	// Exercises done on each machine, newest first (blocks with a logged set).
	const doneOn = await db.execute<{ machine_id: string; exercise_id: string; at: Date }>(sql`
		SELECT st.gym_equipment_id AS machine_id, st.exercise_id, max(s.started_at) AS at
		FROM sets st JOIN sessions s ON s.id = st.session_id
		WHERE st.user_id = ${userId} AND s.user_id = ${userId} AND st.gym_equipment_id IS NOT NULL
		  AND s.deleted_at IS NULL AND st.executed_load IS NOT NULL
		GROUP BY st.gym_equipment_id, st.exercise_id
		ORDER BY at DESC`);
	// The weight format last used per exercise and machine (machine '' for free weights).
	const formats = await db.execute<{
		exercise_id: string;
		machine_id: string | null;
		equipment_type: string;
		load_convention: string;
	}>(sql`
		SELECT DISTINCT ON (se.exercise_id, se.gym_equipment_id) se.exercise_id,
			se.gym_equipment_id AS machine_id, se.equipment_type, se.load_convention
		FROM session_exercises se JOIN sessions s ON s.id = se.session_id
		WHERE s.user_id = ${userId} AND s.deleted_at IS NULL AND se.load_convention <> 'legacy'
		ORDER BY se.exercise_id, se.gym_equipment_id, s.started_at DESC`);
	const mapped = await db
		.select({
			exerciseId: exerciseEquipmentMap.exerciseId,
			modelId: exerciseEquipmentMap.equipmentModelId
		})
		.from(exerciseEquipmentMap)
		.innerJoin(exercises, eq(exercises.id, exerciseEquipmentMap.exerciseId))
		.where(and(eq(exercises.userId, userId), isNull(exercises.archivedAt)));

	const activeExercise = new Set(exerciseRows.map((e) => e.id));
	const lastTopEx = new Map(
		[...topByExercise].map((r) => [
			r.exercise_id,
			{ at: iso(r.started_at)!, load: Number(r.load), reps: Number(r.reps) }
		])
	);
	const lastTopMachine = new Map([...topByMachine].map((r) => [r.machine_id, r]));
	const machineExercises = new Map<string, string[]>();
	for (const r of doneOn) {
		if (!activeExercise.has(r.exercise_id)) continue;
		const list = machineExercises.get(r.machine_id) ?? [];
		if (!list.includes(r.exercise_id)) list.push(r.exercise_id);
		machineExercises.set(r.machine_id, list);
	}

	// Free-weight equipment rows such as "Dumbbells" stay in the database for
	// their history but are not machines to pick (machines spec Part J).
	const machines: PickerMachine[] = machineRows
		.filter((m) => !FREE_WEIGHT_TYPES.has(m.equipmentType))
		.map((m) => {
			const top = lastTopMachine.get(m.id);
			const ids = machineExercises.get(m.id) ?? [];
			for (const link of mapped)
				if (
					link.modelId === m.modelId &&
					activeExercise.has(link.exerciseId) &&
					!ids.includes(link.exerciseId)
				)
					ids.push(link.exerciseId);
			return {
				id: m.id,
				gymId: m.gymId,
				label: m.label,
				equipmentType: m.equipmentType,
				modelName: m.manufacturer ? `${m.manufacturer} ${m.modelName}` : null,
				modelCode: m.modelCode,
				bodyRegion: m.bodyRegion,
				photoId: m.photoId,
				lastUsedAt: top ? iso(top.started_at) : null,
				lastExerciseId: top && activeExercise.has(top.exercise_id) ? top.exercise_id : null,
				lastTop: top
					? { at: iso(top.started_at)!, load: Number(top.load), reps: Number(top.reps) }
					: null,
				exerciseIds: ids
			};
		});

	const recentExerciseIds = [...lastTopEx.entries()]
		.filter(([id]) => activeExercise.has(id))
		.sort((a, b) => b[1].at.localeCompare(a[1].at))
		.slice(0, 8)
		.map(([id]) => id);
	const recentMachineIds: Record<string, string[]> = {};
	for (const m of [...machines]
		.filter((x) => x.lastUsedAt)
		.sort((a, b) => b.lastUsedAt!.localeCompare(a.lastUsedAt!))) {
		const list = (recentMachineIds[m.gymId] ??= []);
		if (list.length < 5) list.push(m.id);
	}
	const conventions: Record<string, string> = {};
	for (const f of formats) {
		// Free weights remember one format per exercise, whatever row they sat on.
		const key = FREE_WEIGHT_TYPES.has(f.equipment_type)
			? `${f.exercise_id}|`
			: `${f.exercise_id}|${f.machine_id ?? ''}`;
		conventions[key] ??= f.load_convention;
	}
	const machineGym = new Map(machines.map((m) => [m.id, m.gymId]));
	const lastMachineAt: Record<string, string> = {};
	for (const r of doneOn) {
		const gym = machineGym.get(r.machine_id);
		if (gym) lastMachineAt[`${r.exercise_id}|${gym}`] ??= r.machine_id;
	}

	const gymId =
		(sessionGymId && gymRows.some((g) => g.id === sessionGymId) ? sessionGymId : null) ??
		(await lastUsedGymId(db, userId)) ??
		gymRows[0]?.id ??
		null;
	return {
		gyms: gymRows,
		gymId,
		machines,
		exercises: exerciseRows.map((e) => ({ ...e, lastTop: lastTopEx.get(e.id) ?? null })),
		recentExerciseIds,
		recentMachineIds,
		conventions,
		lastMachineAt
	};
}
