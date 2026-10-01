/**
 * Migration 0016 (equipment_photos), checked against the applied database
 * rather than the SQL file: CLAUDE.md "a generated migration is verified by
 * applying it". Every object is looked up BY NAME, so a constraint Postgres
 * named for itself, or truncated past 63 bytes, fails here.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setupTestDb, resetTestDbWithUsers, type TestDb } from '../test-db';
import * as s from '../db/schema';

let db: TestDb;
let handle: Awaited<ReturnType<typeof setupTestDb>>;
let userId: string;
let gymId: string;
beforeAll(async () => {
	handle = await setupTestDb();
	db = handle.db;
});
afterAll(async () => {
	await handle?.end();
});
beforeEach(async () => {
	[{ id: userId }] = await resetTestDbWithUsers(db, handle.client, 1, 'photo-schema');
	[{ id: gymId }] = await db.insert(s.gyms).values({ name: 'Gym', userId }).returning();
});

const row = (over: Partial<s.NewEquipmentPhoto> = {}): s.NewEquipmentPhoto => ({
	userId,
	gymId,
	storageKey: `users/${userId}/equipment-photos/${crypto.randomUUID()}.jpg`,
	contentType: 'image/jpeg',
	bytes: 1000,
	width: 1600,
	height: 1200,
	sha256: '0'.repeat(64),
	status: 'uploaded',
	...over
});

describe('0016 equipment_photos schema', () => {
	it('has the columns, nullability and types the spec lists', async () => {
		const cols = await handle.client<
			{ column_name: string; is_nullable: string; data_type: string }[]
		>`
			SELECT column_name, is_nullable, data_type
			FROM information_schema.columns
			WHERE table_schema = 'public' AND table_name = 'equipment_photos'`;
		const by = Object.fromEntries(cols.map((c) => [c.column_name, c]));
		const notNull = [
			'id',
			'user_id',
			'gym_id',
			'storage_key',
			'content_type',
			'bytes',
			'width',
			'height',
			'sha256',
			'status',
			'created_at'
		];
		const nullable = [
			'llm_call_id',
			'candidate',
			'matched_model_id',
			'created_model_id',
			'gym_equipment_id'
		];
		expect(Object.keys(by).sort()).toEqual([...notNull, ...nullable].sort());
		for (const c of notNull) expect(by[c].is_nullable, c).toBe('NO');
		for (const c of nullable) expect(by[c].is_nullable, c).toBe('YES');
		expect(by.user_id.data_type).toBe('text');
		expect(by.candidate.data_type).toBe('jsonb');
		expect(by.created_at.data_type).toBe('timestamp with time zone');
		for (const c of ['bytes', 'width', 'height']) expect(by[c].data_type, c).toBe('integer');
	});

	it('creates every FK, CHECK, the unique key and every index under its declared name', async () => {
		const fks = await handle.client<{ conname: string; def: string; confdeltype: string }[]>`
			SELECT conname, pg_get_constraintdef(oid) AS def, confdeltype FROM pg_constraint
			WHERE conrelid = 'public.equipment_photos'::regclass AND contype = 'f'
			ORDER BY conname`;
		const fk = Object.fromEntries(fks.map((f) => [f.conname, f]));
		expect(Object.keys(fk)).toEqual([
			'equipment_photos_created_model_id_fk',
			'equipment_photos_gym_equipment_id_fk',
			'equipment_photos_gym_id_fk',
			'equipment_photos_llm_call_id_fk',
			'equipment_photos_matched_model_id_fk',
			'equipment_photos_user_id_fk'
		]);
		expect(fk.equipment_photos_user_id_fk.def).toContain('REFERENCES auth."user"(id)');
		expect(fk.equipment_photos_gym_id_fk.def).toContain('REFERENCES gyms(id)');
		expect(fk.equipment_photos_llm_call_id_fk.def).toContain('REFERENCES llm_calls(id)');
		expect(fk.equipment_photos_matched_model_id_fk.def).toContain(
			'REFERENCES equipment_models(id)'
		);
		expect(fk.equipment_photos_created_model_id_fk.def).toContain(
			'REFERENCES equipment_models(id)'
		);
		expect(fk.equipment_photos_gym_equipment_id_fk.def).toContain('REFERENCES gym_equipment(id)');
		for (const f of fks) expect(f.confdeltype, f.conname).toBe('a'); // NO ACTION

		const others = await handle.client<{ conname: string; contype: string }[]>`
			SELECT conname, contype FROM pg_constraint
			WHERE conrelid = 'public.equipment_photos'::regclass AND contype IN ('c', 'u', 'p')
			ORDER BY conname`;
		expect(others.map((c) => c.conname)).toEqual([
			'equipment_photos_pkey',
			'equipment_photos_size_check',
			'equipment_photos_status_check',
			'equipment_photos_storage_key_unique'
		]);

		const idx = await handle.client<{ indexname: string; indexdef: string }[]>`
			SELECT indexname, indexdef FROM pg_indexes
			WHERE tablename = 'equipment_photos' ORDER BY indexname`;
		const defs = Object.fromEntries(idx.map((i) => [i.indexname, i.indexdef]));
		expect(Object.keys(defs)).toEqual([
			'equipment_photos_created_model_idx',
			'equipment_photos_gym_equipment_idx',
			'equipment_photos_gym_idx',
			'equipment_photos_llm_call_idx',
			'equipment_photos_matched_model_idx',
			'equipment_photos_pkey',
			'equipment_photos_storage_key_unique',
			'equipment_photos_user_created_idx'
		]);
		expect(defs.equipment_photos_user_created_idx).toContain('(user_id, created_at)');
		expect(defs.equipment_photos_gym_equipment_idx).toContain('(gym_equipment_id)');
	});

	it('defaults id and created_at, and refuses a bad status, size, owner, gym or duplicate key', async () => {
		const [ok] = await db.insert(s.equipmentPhotos).values(row()).returning();
		expect(ok.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(ok.createdAt).toBeInstanceOf(Date);
		const refused = (over: Partial<s.NewEquipmentPhoto>) =>
			db.insert(s.equipmentPhotos).values(row(over));
		await expect(refused({ status: 'maybe' as s.PhotoStatus })).rejects.toMatchObject({
			cause: { constraint_name: 'equipment_photos_status_check' }
		});
		await expect(refused({ bytes: 0 })).rejects.toMatchObject({
			cause: { constraint_name: 'equipment_photos_size_check' }
		});
		await expect(refused({ userId: 'no-such-user' })).rejects.toMatchObject({
			cause: { constraint_name: 'equipment_photos_user_id_fk' }
		});
		await expect(refused({ gymId: crypto.randomUUID() })).rejects.toMatchObject({
			cause: { constraint_name: 'equipment_photos_gym_id_fk' }
		});
		await expect(refused({ storageKey: ok.storageKey })).rejects.toMatchObject({
			cause: { constraint_name: 'equipment_photos_storage_key_unique' }
		});
	});
});
