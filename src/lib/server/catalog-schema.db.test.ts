/**
 * Migration 0012 (equipment catalog), checked against the applied database
 * rather than the SQL file: CLAUDE.md "a generated migration is verified by
 * applying it". Every object is looked up BY NAME, so a constraint Postgres
 * silently named for itself, or truncated past 63 bytes, fails here.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setupTestDb, resetTestDbWithUsers, type TestDb } from './test-db';
import * as s from './db/schema';

let db: TestDb;
let handle: Awaited<ReturnType<typeof setupTestDb>>;
let userId: string;
beforeAll(async () => {
	handle = await setupTestDb();
	db = handle.db;
});
afterAll(async () => {
	await handle?.end();
});
beforeEach(async () => {
	[{ id: userId }] = await resetTestDbWithUsers(db, handle.client, 1, 'catalog-schema');
});

describe('0012 equipment catalog schema', () => {
	it('adds the catalog columns with their defaults and nullability', async () => {
		const cols = await handle.client<
			{
				table_name: string;
				column_name: string;
				is_nullable: string;
				column_default: string | null;
				data_type: string;
			}[]
		>`
			SELECT table_name, column_name, is_nullable, column_default, data_type
			FROM information_schema.columns
			WHERE table_schema = 'public'
			  AND (table_name, column_name) IN (
				('equipment_models', 'body_region'),
				('equipment_models', 'starting_resistance_basis'),
				('equipment_models', 'confidence'),
				('equipment_models', 'source_url'),
				('equipment_models', 'catalog_snapshot'),
				('gym_equipment', 'stack_lb'),
				('gym_equipment', 'increment_lb'))
			ORDER BY table_name, column_name`;
		const byName = Object.fromEntries(cols.map((c) => [`${c.table_name}.${c.column_name}`, c]));
		expect(Object.keys(byName)).toHaveLength(7);
		expect(byName['equipment_models.confidence']).toMatchObject({
			is_nullable: 'NO',
			column_default: "'user'::text"
		});
		expect(byName['equipment_models.catalog_snapshot'].data_type).toBe('date');
		expect(byName['gym_equipment.stack_lb']).toMatchObject({
			is_nullable: 'YES',
			data_type: 'integer'
		});
		expect(byName['gym_equipment.increment_lb'].is_nullable).toBe('YES');
	});

	it('creates every constraint and the partial index under its declared name', async () => {
		const constraints = await handle.client<{ conname: string }[]>`
			SELECT conname FROM pg_constraint
			WHERE conname IN (
				'equipment_models_confidence_check',
				'equipment_models_body_region_check',
				'equipment_models_resistance_basis_check',
				'gym_equipment_stack_lb_check',
				'gym_equipment_increment_lb_check')`;
		expect(constraints.map((c) => c.conname).sort()).toEqual([
			'equipment_models_body_region_check',
			'equipment_models_confidence_check',
			'equipment_models_resistance_basis_check',
			'gym_equipment_increment_lb_check',
			'gym_equipment_stack_lb_check'
		]);
		const [index] = await handle.client<{ indexdef: string }[]>`
			SELECT indexdef FROM pg_indexes WHERE indexname = 'equipment_models_catalog_code_unique'`;
		expect(index.indexdef).toContain('UNIQUE INDEX');
		expect(index.indexdef).toContain('(manufacturer, code)');
		expect(index.indexdef).toContain('owner_user_id IS NULL');
	});

	it('a row inserted without a confidence is a user row', async () => {
		const [row] = await db
			.insert(s.equipmentModels)
			.values({ manufacturer: 'M', name: 'N', loadingType: 'machine-stack', ownerUserId: userId })
			.returning();
		expect(row.confidence).toBe('user');
		expect(row.catalogSnapshot).toBeNull();
	});

	it('refuses a second global row with the same manufacturer and code', async () => {
		const base = { manufacturer: 'Hammer Strength', code: 'IL-ROW', loadingType: 'machine-plate' };
		await db.insert(s.equipmentModels).values({ ...base, name: 'Iso-Lateral Row' });
		await expect(
			db.insert(s.equipmentModels).values({ ...base, name: 'Duplicate' })
		).rejects.toMatchObject({ cause: { constraint_name: 'equipment_models_catalog_code_unique' } });
	});

	it('lets an owned copy reuse a catalog code, and codeless globals repeat', async () => {
		const base = { manufacturer: 'Hammer Strength', code: 'IL-ROW', loadingType: 'machine-plate' };
		await db.insert(s.equipmentModels).values({ ...base, name: 'Iso-Lateral Row' });
		await db.insert(s.equipmentModels).values({ ...base, name: 'My row', ownerUserId: userId });
		const codeless = {
			manufacturer: 'Life Fitness',
			name: 'Chest Press',
			loadingType: 'machine-stack'
		};
		await db
			.insert(s.equipmentModels)
			.values([codeless, codeless, { ...codeless, code: '' }, { ...codeless, code: '' }]);
		const rows = await db.select().from(s.equipmentModels);
		expect(rows).toHaveLength(6);
	});

	it('refuses an unknown confidence, body region, or basis, and a non-positive stack', async () => {
		const base = { manufacturer: 'M', name: 'N', loadingType: 'machine-stack' };
		await expect(
			db.insert(s.equipmentModels).values({ ...base, confidence: 'guess' })
		).rejects.toMatchObject({ cause: { constraint_name: 'equipment_models_confidence_check' } });
		await expect(
			db.insert(s.equipmentModels).values({ ...base, bodyRegion: 'neck' })
		).rejects.toMatchObject({ cause: { constraint_name: 'equipment_models_body_region_check' } });
		await expect(
			db.insert(s.equipmentModels).values({ ...base, startingResistanceBasis: 'per_side' })
		).rejects.toMatchObject({
			cause: { constraint_name: 'equipment_models_resistance_basis_check' }
		});
		const [gym] = await db.insert(s.gyms).values({ name: 'G', userId }).returning();
		await expect(
			db
				.insert(s.gymEquipment)
				.values({ gymId: gym.id, localLabel: 'L', equipmentType: 'cable', stackLb: 0 })
		).rejects.toMatchObject({ cause: { constraint_name: 'gym_equipment_stack_lb_check' } });
	});
});
