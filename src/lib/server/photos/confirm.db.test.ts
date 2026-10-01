/**
 * Link / create / discard (0.4.0 §5/§7), against the test database and the
 * memory store. The cross-tenant tests are in CLAUDE.md's shape: the owner's
 * positive outcome first, then the other user's refusal, then the state.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { ZodError } from 'zod';
import { setupTestDb, resetTestDbWithUsers, type TestDb } from '../test-db';
import * as s from '../db/schema';
import { MachineInputError } from '../machines';
import { MemoryPhotoStore } from './store';
import { uploadPhoto } from './index';
import { createModelFromPhoto, discardPhoto, linkPhoto } from './confirm';
import { FIXTURE_CANDIDATE, smallPng } from './test-fixtures';

let db: TestDb;
let handle: Awaited<ReturnType<typeof setupTestDb>>;
let alice: string;
let bob: string;
let gymId: string;
let store: MemoryPhotoStore;
let catalogRow: typeof s.equipmentModels.$inferSelect;
let alicesModel: typeof s.equipmentModels.$inferSelect;
const limits = { maxBytes: 10 * 1024 * 1024, dailyLimit: 20 };

beforeAll(async () => {
	handle = await setupTestDb();
	db = handle.db;
});
afterAll(async () => {
	await handle?.end();
});
beforeEach(async () => {
	[{ id: alice }, { id: bob }] = await resetTestDbWithUsers(db, handle.client, 2, 'confirm');
	[{ id: gymId }] = await db.insert(s.gyms).values({ name: 'Gym', userId: alice }).returning();
	[catalogRow] = await db
		.insert(s.equipmentModels)
		.values({
			manufacturer: 'Hammer Strength',
			name: 'Iso-Lateral Row',
			code: 'IL-ROW',
			loadingType: 'machine-plate',
			confidence: 'manufacturer_page'
		})
		.returning();
	[alicesModel] = await db
		.insert(s.equipmentModels)
		.values({
			manufacturer: 'Garage Iron',
			name: 'Hip Thrust',
			loadingType: 'machine-plate',
			ownerUserId: alice
		})
		.returning();
	store = new MemoryPhotoStore();
});

async function analyzedPhoto(userId = alice, gym = gymId) {
	const photo = (await uploadPhoto(
		db,
		userId,
		{ gymId: gym, bytes: await smallPng() },
		{ store, limits }
	))!;
	await db
		.update(s.equipmentPhotos)
		.set({ status: 'analyzed', candidate: FIXTURE_CANDIDATE })
		.where(eq(s.equipmentPhotos.id, photo.id));
	return photo;
}
const photoRow = async (id: string) =>
	(await db.select().from(s.equipmentPhotos).where(eq(s.equipmentPhotos.id, id)))[0];
const machinesAt = (gym: string) =>
	db.select().from(s.gymEquipment).where(eq(s.gymEquipment.gymId, gym));

describe('linkPhoto', () => {
	it('creates the machine at the photo’s gym with the default label, and confirms the photo', async () => {
		const photo = await analyzedPhoto();
		const out = await linkPhoto(db, alice, photo.id, { modelId: catalogRow.id, stackLb: '200' });
		expect(out).not.toBeNull();
		const [machine] = await machinesAt(gymId);
		expect(machine).toMatchObject({
			id: out!.gymEquipmentId,
			equipmentModelId: catalogRow.id,
			equipmentType: 'machine-plate',
			localLabel: 'Hammer Strength Iso-Lateral Row (IL-ROW)',
			stackLb: 200
		});
		expect(await photoRow(photo.id)).toMatchObject({
			status: 'confirmed',
			matchedModelId: catalogRow.id,
			createdModelId: null,
			gymEquipmentId: machine.id
		});
	});

	it('a typed label wins over the default', async () => {
		const photo = await analyzedPhoto();
		await linkPhoto(db, alice, photo.id, { modelId: catalogRow.id, localLabel: 'Row by window' });
		expect((await machinesAt(gymId))[0].localLabel).toBe('Row by window');
	});

	it('links the owner’s photo, and refuses another user’s photo with no row', async () => {
		const photo = await analyzedPhoto();
		const other = await analyzedPhoto();
		expect(await linkPhoto(db, alice, other.id, { modelId: catalogRow.id })).not.toBeNull();
		expect(await linkPhoto(db, bob, photo.id, { modelId: catalogRow.id })).toBeNull();
		expect(await machinesAt(gymId)).toHaveLength(1);
		expect((await photoRow(photo.id)).status).toBe('analyzed');
	});

	it('links to my own model, and another user cannot link to it', async () => {
		const photo = await analyzedPhoto();
		const mine = await linkPhoto(db, alice, photo.id, { modelId: alicesModel.id });
		expect(mine?.modelId).toBe(alicesModel.id);

		const [bobsGym] = await db.insert(s.gyms).values({ name: 'Bob Gym', userId: bob }).returning();
		const bobsPhoto = await analyzedPhoto(bob, bobsGym.id);
		await expect(linkPhoto(db, bob, bobsPhoto.id, { modelId: alicesModel.id })).rejects.toThrow(
			new MachineInputError('Model not found')
		);
		expect(await machinesAt(bobsGym.id)).toEqual([]);
		expect((await photoRow(bobsPhoto.id)).status).toBe('analyzed');
	});

	it('a blank stack takes the model’s standard stack; a given stack wins', async () => {
		await db
			.update(s.equipmentModels)
			.set({ standardStackLb: 230 })
			.where(eq(s.equipmentModels.id, catalogRow.id));
		const blank = await analyzedPhoto();
		const given = await analyzedPhoto();
		const a = await linkPhoto(db, alice, blank.id, { modelId: catalogRow.id, stackLb: '' });
		const b = await linkPhoto(db, alice, given.id, { modelId: catalogRow.id, stackLb: '200' });
		const stackOf = async (id: string) =>
			(await db.select().from(s.gymEquipment).where(eq(s.gymEquipment.id, id)))[0].stackLb;
		expect(await stackOf(a!.gymEquipmentId)).toBe(230);
		expect(await stackOf(b!.gymEquipmentId)).toBe(200);
	});

	it('a retired catalog model cannot be linked (not found), and nothing is written', async () => {
		const photo = await analyzedPhoto();
		await db
			.update(s.equipmentModels)
			.set({ retiredAt: new Date() })
			.where(eq(s.equipmentModels.id, catalogRow.id));
		await expect(linkPhoto(db, alice, photo.id, { modelId: catalogRow.id })).rejects.toThrow(
			new MachineInputError('Model not found')
		);
		expect(await machinesAt(gymId)).toEqual([]);
		expect((await photoRow(photo.id)).status).toBe('analyzed');
	});

	it('a confirmed photo cannot be confirmed again (a double submit makes one machine)', async () => {
		const photo = await analyzedPhoto();
		expect(await linkPhoto(db, alice, photo.id, { modelId: catalogRow.id })).not.toBeNull();
		expect(await linkPhoto(db, alice, photo.id, { modelId: catalogRow.id })).toBeNull();
		expect(await machinesAt(gymId)).toHaveLength(1);
	});
});

describe('createModelFromPhoto', () => {
	const form = {
		manufacturer: 'Hammer Strength',
		name: 'Iso-Lateral Row',
		code: 'IL-ROW',
		productLine: 'Plate Loaded',
		loadingType: 'machine-plate',
		laterality: 'independent',
		startingResistance: '',
		startingResistanceBasis: '',
		notes: 'Lower half of the placard is scratched.',
		localLabel: ''
	};

	it('inserts an OWNED model (confidence user, no source, the notes) and the machine', async () => {
		const photo = await analyzedPhoto();
		const out = await createModelFromPhoto(db, alice, photo.id, form);
		const [model] = await db
			.select()
			.from(s.equipmentModels)
			.where(eq(s.equipmentModels.id, out!.modelId));
		expect(model).toMatchObject({
			ownerUserId: alice,
			confidence: 'user',
			sourceUrl: null,
			catalogSnapshot: null,
			manufacturer: 'Hammer Strength',
			code: 'IL-ROW',
			laterality: 'independent',
			notes: 'Lower half of the placard is scratched.',
			startingResistance: null
		});
		const [machine] = await machinesAt(gymId);
		expect(machine).toMatchObject({
			equipmentModelId: model.id,
			localLabel: 'Hammer Strength Iso-Lateral Row (IL-ROW)'
		});
		expect(await photoRow(photo.id)).toMatchObject({
			status: 'confirmed',
			createdModelId: model.id,
			matchedModelId: null,
			gymEquipmentId: machine.id
		});
		// The catalog row with the same code is untouched and still global.
		const [still] = await db
			.select()
			.from(s.equipmentModels)
			.where(eq(s.equipmentModels.id, catalogRow.id));
		expect(still).toEqual(catalogRow);
	});

	it('creates for the owner, and another user gets null with no model and no machine', async () => {
		const photo = await analyzedPhoto();
		const other = await analyzedPhoto();
		expect(await createModelFromPhoto(db, alice, other.id, form)).not.toBeNull();
		expect(await createModelFromPhoto(db, bob, photo.id, form)).toBeNull();
		expect(
			await db.select().from(s.equipmentModels).where(eq(s.equipmentModels.ownerUserId, bob))
		).toEqual([]);
		expect(await machinesAt(gymId)).toHaveLength(1);
	});

	it('refuses a missing loading type or a resistance with no basis, writing nothing', async () => {
		const photo = await analyzedPhoto();
		await expect(
			createModelFromPhoto(db, alice, photo.id, { ...form, loadingType: '' })
		).rejects.toBeInstanceOf(ZodError);
		await expect(
			createModelFromPhoto(db, alice, photo.id, { ...form, startingResistance: '15' })
		).rejects.toBeInstanceOf(ZodError);
		expect(await machinesAt(gymId)).toEqual([]);
		expect((await photoRow(photo.id)).status).toBe('analyzed');
	});
});

describe('discardPhoto', () => {
	it('deletes the object and marks the row discarded; another user cannot', async () => {
		const photo = await analyzedPhoto();
		const other = await analyzedPhoto();
		expect(await discardPhoto(db, alice, other.id, store)).toBe(true);
		expect(await store.get(other.storageKey)).toBeNull();
		expect((await photoRow(other.id)).status).toBe('discarded');

		expect(await discardPhoto(db, bob, photo.id, store)).toBe(false);
		expect(await store.get(photo.storageKey)).not.toBeNull();
		expect((await photoRow(photo.id)).status).toBe('analyzed');
	});

	it('a store failure leaves the photo as it was', async () => {
		const photo = await analyzedPhoto();
		const broken = new MemoryPhotoStore();
		broken.delete = async () => {
			throw new Error('store down');
		};
		await expect(discardPhoto(db, alice, photo.id, broken)).rejects.toThrow('store down');
		expect((await photoRow(photo.id)).status).toBe('analyzed');
	});

	it('a confirmed photo cannot be discarded', async () => {
		const photo = await analyzedPhoto();
		await linkPhoto(db, alice, photo.id, { modelId: catalogRow.id });
		expect(await discardPhoto(db, alice, photo.id, store)).toBe(false);
		expect(await store.get(photo.storageKey)).not.toBeNull();
	});
});

describe('every equipment_photos row is owned consistently', () => {
	it('after link, create and discard: each photo, its gym and its machine share one owner', async () => {
		const [bobsGym] = await db.insert(s.gyms).values({ name: 'Bob Gym', userId: bob }).returning();
		const a = await analyzedPhoto();
		const b = await analyzedPhoto(bob, bobsGym.id);
		const c = await analyzedPhoto();
		await linkPhoto(db, alice, a.id, { modelId: catalogRow.id });
		await createModelFromPhoto(db, bob, b.id, {
			manufacturer: 'X',
			name: 'Y',
			loadingType: 'cable',
			laterality: 'unknown'
		});
		await discardPhoto(db, alice, c.id, store);
		// Positive first: the fixture really has rows of every kind to check.
		const [{ n }] = await handle.client<{ n: number }[]>`
			SELECT count(*)::int AS n FROM equipment_photos`;
		expect(n).toBe(3);
		const mismatched = await handle.client`
			SELECT p.id FROM equipment_photos p
			JOIN gyms g ON g.id = p.gym_id
			LEFT JOIN gym_equipment ge ON ge.id = p.gym_equipment_id
			LEFT JOIN gyms g2 ON g2.id = ge.gym_id
			LEFT JOIN equipment_models cm ON cm.id = p.created_model_id
			WHERE p.user_id IS NULL
			   OR p.user_id <> g.user_id
			   OR (ge.id IS NOT NULL AND g2.user_id <> p.user_id)
			   OR (cm.id IS NOT NULL AND cm.owner_user_id IS DISTINCT FROM p.user_id)`;
		expect(mismatched).toEqual([]);
	});
});
