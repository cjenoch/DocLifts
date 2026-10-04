import { and, desc, eq, inArray } from 'drizzle-orm';
import { equipmentPhotos } from './db/schema';
import type { Database } from './progression';

/** IDs only; the image route separately enforces ownership on every request. */
export async function workoutMachinePhotos(db: Database, userId: string, machineIds: string[]) {
	const ids = [...new Set(machineIds)];
	if (!ids.length) return {} as Record<string, string>;
	const rows = await db
		.select({ id: equipmentPhotos.id, machineId: equipmentPhotos.gymEquipmentId })
		.from(equipmentPhotos)
		.where(
			and(
				eq(equipmentPhotos.userId, userId),
				eq(equipmentPhotos.status, 'confirmed'),
				inArray(equipmentPhotos.gymEquipmentId, ids)
			)
		)
		.orderBy(desc(equipmentPhotos.createdAt), desc(equipmentPhotos.id));
	const result: Record<string, string> = {};
	for (const row of rows)
		if (row.machineId && !result[row.machineId]) result[row.machineId] = row.id;
	return result;
}
