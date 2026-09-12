import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import * as schema from './db/schema';
import { snapForEquipment } from './plates';

describe('machine identity schema and load conventions', () => {
	it('adds discovery tables without replacing legacy exercises', () => {
		expect(schema).toHaveProperty('equipmentModels');
		expect(schema).toHaveProperty('exerciseEquipmentMap');
		expect(schema).toHaveProperty('gyms');
		expect(schema).toHaveProperty('gymEquipment');
		expect(schema).toHaveProperty('sessionExercises');
		expect(getTableColumns(schema.exercises)).toHaveProperty('canonicalMovement');
		expect(getTableColumns(schema.sets)).toHaveProperty('gymEquipmentId');
		expect(getTableColumns(schema.sets)).toHaveProperty('loadConvention');
	});
	it('does not silently treat total plates as plates per side', () => {
		expect(snapForEquipment(103, 'machine-plate', 'total_plates').achievable).toBe(103);
	});
	it('passes unknown convention through and preserves legacy default routing', () => {
		expect(snapForEquipment(103, 'machine-plate', 'unknown').achievable).toBe(103);
		expect(snapForEquipment(103, 'machine-plate').achievable).toBe(102.5);
		expect(snapForEquipment(103, 'machine-plate', 'plates_per_side').achievable).toBe(102.5);
	});
});
