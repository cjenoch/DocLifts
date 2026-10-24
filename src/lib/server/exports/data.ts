import { and, eq, getTableColumns, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { Database } from '../progression';
import * as s from '../db/schema';
import { exportFields as f } from './fields';

export const MAX_EXPORT_ROWS = 50_000;
export const MAX_EXPORT_BYTES = 32 * 1024 * 1024;
export class ExportLimitError extends Error {}
export class ExportAccessError extends Error {}

function columns<T extends PgTable, K extends keyof T['_']['columns']>(
	table: T,
	keys: readonly K[]
) {
	const all = getTableColumns(table);
	return Object.fromEntries(keys.map((key) => [key, all[key]])) as Pick<T['_']['columns'], K>;
}

export async function hasExportSession(db: Database, userId: string, sessionId: string) {
	const rows = await db
		.select({ id: s.authSessions.id })
		.from(s.authSessions)
		.innerJoin(s.authUsers, eq(s.authUsers.id, s.authSessions.userId))
		.where(
			and(
				eq(s.authUsers.id, userId),
				isNull(s.authUsers.deletionRequestedAt),
				eq(s.authSessions.id, sessionId),
				gt(s.authSessions.expiresAt, new Date())
			)
		)
		.limit(1);
	return rows.length === 1;
}

/** One consistent account snapshot. No auth secrets, S3 I/O, or persistent export file. */
export async function readAccountExport(db: Database, userId: string) {
	return db.transaction(
		async (tx) => {
			await tx.execute(sql`set local statement_timeout = '5s'`);
			await tx.execute(sql`set local lock_timeout = '1s'`);
			let count = 0;
			let bytes = 0;
			const deadline = Date.now() + 15_000;
			async function read<T>(query: PromiseLike<T[]>) {
				if (Date.now() > deadline) throw new ExportLimitError('Export took too long.');
				const rows = await query;
				count += rows.length;
				if (count > MAX_EXPORT_ROWS) throw new ExportLimitError('Export exceeds the row limit.');
				bytes += Buffer.byteLength(JSON.stringify(rows));
				if (bytes > MAX_EXPORT_BYTES) throw new ExportLimitError('Export exceeds the size limit.');
				return rows;
			}
			const cap = MAX_EXPORT_ROWS + 1;
			const profile = await read(
				tx
					.select(columns(s.authUsers, f.profile))
					.from(s.authUsers)
					.where(and(eq(s.authUsers.id, userId), isNull(s.authUsers.deletionRequestedAt)))
					.limit(1)
			);
			if (!profile.length) throw new ExportAccessError('Account unavailable.');
			const programIds = tx
				.select({ id: s.programs.id })
				.from(s.programs)
				.where(eq(s.programs.userId, userId));
			const exerciseIds = tx
				.select({ id: s.exercises.id })
				.from(s.exercises)
				.where(eq(s.exercises.userId, userId));
			const dayIds = tx
				.select({ id: s.days.id })
				.from(s.days)
				.where(inArray(s.days.programId, programIds));
			const dayExerciseIds = tx
				.select({ id: s.dayExercises.id })
				.from(s.dayExercises)
				.where(
					and(
						inArray(s.dayExercises.dayId, dayIds),
						inArray(s.dayExercises.exerciseId, exerciseIds)
					)
				);
			const gymIds = tx.select({ id: s.gyms.id }).from(s.gyms).where(eq(s.gyms.userId, userId));
			const sessionIds = tx
				.select({ id: s.sessions.id })
				.from(s.sessions)
				.where(
					and(
						eq(s.sessions.userId, userId),
						inArray(s.sessions.programId, programIds),
						inArray(s.sessions.dayId, dayIds)
					)
				);
			const importIds = tx
				.select({ id: s.workoutLogImports.id })
				.from(s.workoutLogImports)
				.where(eq(s.workoutLogImports.userId, userId));
			const visibleModels = tx
				.select({ id: s.equipmentModels.id })
				.from(s.equipmentModels)
				.where(
					or(eq(s.equipmentModels.ownerUserId, userId), isNull(s.equipmentModels.ownerUserId))
				);
			const programs = await read(
				tx
					.select(columns(s.programs, f.programs))
					.from(s.programs)
					.where(eq(s.programs.userId, userId))
					.orderBy(s.programs.id)
					.limit(cap)
			);
			const days = await read(
				tx
					.select(columns(s.days, f.days))
					.from(s.days)
					.where(inArray(s.days.programId, programIds))
					.orderBy(s.days.id)
					.limit(cap)
			);
			const exercises = await read(
				tx
					.select(columns(s.exercises, f.exercises))
					.from(s.exercises)
					.where(eq(s.exercises.userId, userId))
					.orderBy(s.exercises.id)
					.limit(cap)
			);
			const dayExercises = await read(
				tx
					.select(columns(s.dayExercises, f.dayExercises))
					.from(s.dayExercises)
					.where(inArray(s.dayExercises.id, dayExerciseIds))
					.orderBy(s.dayExercises.id)
					.limit(cap)
			);
			const prescribedSets = await read(
				tx
					.select(columns(s.prescribedSets, f.prescribedSets))
					.from(s.prescribedSets)
					.where(inArray(s.prescribedSets.dayExerciseId, dayExerciseIds))
					.orderBy(s.prescribedSets.id)
					.limit(cap)
			);
			const sessions = await read(
				tx
					.select(columns(s.sessions, f.sessions))
					.from(s.sessions)
					.where(inArray(s.sessions.id, sessionIds))
					.orderBy(s.sessions.startedAt, s.sessions.id)
					.limit(cap)
			);
			const sessionExercises = await read(
				tx
					.select(columns(s.sessionExercises, f.sessionExercises))
					.from(s.sessionExercises)
					.where(
						and(
							inArray(s.sessionExercises.sessionId, sessionIds),
							inArray(s.sessionExercises.exerciseId, exerciseIds)
						)
					)
					.orderBy(s.sessionExercises.sessionId, s.sessionExercises.position)
					.limit(cap)
			);
			const sets = await read(
				tx
					.select(columns(s.sets, f.sets))
					.from(s.sets)
					.where(
						and(
							eq(s.sets.userId, userId),
							inArray(s.sets.sessionId, sessionIds),
							inArray(s.sets.exerciseId, exerciseIds)
						)
					)
					.orderBy(s.sets.sessionId, s.sets.position, s.sets.id)
					.limit(cap)
			);
			const painEvents = await read(
				tx
					.select(columns(s.painEvents, f.painEvents))
					.from(s.painEvents)
					.where(eq(s.painEvents.userId, userId))
					.orderBy(s.painEvents.id)
					.limit(cap)
			);
			const gyms = await read(
				tx
					.select(columns(s.gyms, f.gyms))
					.from(s.gyms)
					.where(eq(s.gyms.userId, userId))
					.orderBy(s.gyms.id)
					.limit(cap)
			);
			const gymEquipment = await read(
				tx
					.select(columns(s.gymEquipment, f.gymEquipment))
					.from(s.gymEquipment)
					.where(inArray(s.gymEquipment.gymId, gymIds))
					.orderBy(s.gymEquipment.id)
					.limit(cap)
			);
			const exerciseEquipmentMap = await read(
				tx
					.select(columns(s.exerciseEquipmentMap, f.exerciseEquipmentMap))
					.from(s.exerciseEquipmentMap)
					.where(
						and(
							inArray(s.exerciseEquipmentMap.exerciseId, exerciseIds),
							inArray(s.exerciseEquipmentMap.equipmentModelId, visibleModels)
						)
					)
					.orderBy(s.exerciseEquipmentMap.id)
					.limit(cap)
			);
			const workoutLogImports = await read(
				tx
					.select(columns(s.workoutLogImports, f.workoutLogImports))
					.from(s.workoutLogImports)
					.where(eq(s.workoutLogImports.userId, userId))
					.orderBy(s.workoutLogImports.id)
					.limit(cap)
			);
			const importedWorkouts = await read(
				tx
					.select(columns(s.importedWorkouts, f.importedWorkouts))
					.from(s.importedWorkouts)
					.where(inArray(s.importedWorkouts.importId, importIds))
					.orderBy(s.importedWorkouts.id)
					.limit(cap)
			);
			const equipmentPhotos = await read(
				tx
					.select(columns(s.equipmentPhotos, f.equipmentPhotos))
					.from(s.equipmentPhotos)
					.where(
						and(eq(s.equipmentPhotos.userId, userId), inArray(s.equipmentPhotos.gymId, gymIds))
					)
					.orderBy(s.equipmentPhotos.id)
					.limit(cap)
			);
			const modelIds = [
				...new Set(
					[
						...gymEquipment.map((x) => x.equipmentModelId),
						...exerciseEquipmentMap.map((x) => x.equipmentModelId),
						...equipmentPhotos.flatMap((x) => [x.matchedModelId, x.createdModelId])
					].filter((id): id is string => id !== null)
				)
			];
			const equipmentModels = await read(
				tx
					.select(columns(s.equipmentModels, f.equipmentModels))
					.from(s.equipmentModels)
					.where(
						or(
							eq(s.equipmentModels.ownerUserId, userId),
							modelIds.length
								? and(
										isNull(s.equipmentModels.ownerUserId),
										inArray(s.equipmentModels.id, modelIds)
									)
								: undefined
						)
					)
					.orderBy(s.equipmentModels.id)
					.limit(cap)
			);
			const machineMerges = await read(
				tx
					.select(columns(s.machineMerges, f.machineMerges))
					.from(s.machineMerges)
					.where(eq(s.machineMerges.userId, userId))
					.orderBy(s.machineMerges.id)
					.limit(cap)
			);
			const llmCalls = await read(
				tx
					.select(columns(s.llmCalls, f.llmCalls))
					.from(s.llmCalls)
					.where(eq(s.llmCalls.userId, userId))
					.orderBy(s.llmCalls.id)
					.limit(cap)
			);
			const photoNoticeAcknowledgements = await read(
				tx
					.select(columns(s.photoNoticeAcknowledgements, f.photoNoticeAcknowledgements))
					.from(s.photoNoticeAcknowledgements)
					.where(eq(s.photoNoticeAcknowledgements.userId, userId))
					.limit(cap)
			);
			return {
				profile,
				programs,
				days,
				exercises,
				dayExercises,
				prescribedSets,
				sessions,
				sessionExercises,
				sets,
				painEvents,
				gyms,
				gymEquipment,
				equipmentModels,
				exerciseEquipmentMap,
				workoutLogImports,
				importedWorkouts,
				equipmentPhotos,
				machineMerges,
				llmCalls,
				photoNoticeAcknowledgements
			};
		},
		{ isolationLevel: 'repeatable read', accessMode: 'read only' }
	);
}
export type AccountExport = Awaited<ReturnType<typeof readAccountExport>>;
