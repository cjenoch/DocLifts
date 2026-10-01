/**
 * The review page's three decisions (0.4.0 §5): link an existing model,
 * create my own model from the candidate, or discard. Nothing reaches
 * `gym_equipment` or `equipment_models` except through one of these, on the
 * user's explicit confirmation.
 *
 * Every id resolves with the owner predicate in the consuming query (D6):
 *  - the photo: `equipment_photos.user_id = userId`, locked FOR UPDATE, and
 *    only while it is `uploaded` or `analyzed` (a confirmed or discarded
 *    photo is not found — a double submit cannot create two machines);
 *  - the gym: the photo row's, re-resolved by createMachine with
 *    `gyms.user_id = userId`;
 *  - a linked model: `modelVisibleTo(userId)` — a current (not retired)
 *    global model, or the user's own.
 * Another user's photo or model is null (the route answers 404), never 403.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { RESISTANCE_BASES, equipmentModels, equipmentPhotos } from '../db/schema';
import type { Database } from '../progression';
import { LATERALITIES, LOADING_TYPES, modelVisibleTo } from '../catalog';
import { createMachine, MachineInputError } from '../machines';
import { isUuid } from './index';
import type { PhotoStore } from './store';
import type { EquipmentCandidate } from './analyze';

/** Candidate loading types, as the model reports them, to the app's equipment types. */
export const CANDIDATE_LOADING_TYPES: Record<
	EquipmentCandidate['loading_type'],
	(typeof LOADING_TYPES)[number] | null
> = {
	selectorized: 'machine-stack',
	plate_loaded: 'machine-plate',
	cable_stack: 'cable',
	unknown: null
};

const blank = (v: unknown) =>
	v == null || (typeof v === 'string' && v.trim() === '') ? undefined : v;
const optionalText = (max: number) => z.preprocess(blank, z.string().trim().max(max).optional());
const optionalLb = z.preprocess(blank, z.coerce.number().int().min(1).max(2000).optional());

const machineFields = {
	localLabel: optionalText(120),
	stackLb: optionalLb,
	incrementLb: optionalLb
};

const linkSchema = z.object({ modelId: z.string().uuid(), ...machineFields });

const createSchema = z
	.object({
		manufacturer: z.string().trim().min(1, 'Give the manufacturer').max(120),
		name: z.string().trim().min(1, 'Give the model a name').max(120),
		code: optionalText(120),
		productLine: optionalText(120),
		loadingType: z.enum(LOADING_TYPES, { error: 'Choose the loading type' }),
		laterality: z.enum(LATERALITIES),
		startingResistance: z.preprocess(blank, z.coerce.number().min(0).max(2000).optional()),
		startingResistanceBasis: z.preprocess(blank, z.enum(RESISTANCE_BASES).optional()),
		notes: optionalText(2000),
		...machineFields
	})
	.refine((v) => v.startingResistance == null || v.startingResistanceBasis != null, {
		message: 'Say whether the starting resistance is total or per arm'
	});

type Tx = Database;

/** Lock one of this user's photos that can still be confirmed or discarded. */
async function lockOpenPhoto(tx: Tx, userId: string, photoId: string) {
	if (!isUuid(photoId)) return null;
	const [photo] = await tx
		.select()
		.from(equipmentPhotos)
		.where(
			and(
				eq(equipmentPhotos.id, photoId),
				eq(equipmentPhotos.userId, userId),
				inArray(equipmentPhotos.status, ['uploaded', 'analyzed'])
			)
		)
		.for('update');
	return photo ?? null;
}

export type Confirmed = { photoId: string; modelId: string; gymEquipmentId: string };

/**
 * Link: a gym_equipment row at the photo's gym for a model this user can see.
 * A blank label takes `defaultMachineLabel(model)` and a blank stack the
 * model's `standard_stack_lb` (both in createMachine, as on every add path);
 * a value the user gives wins. Returns
 * null when the photo is not this user's open photo; throws
 * `MachineInputError` when the model is not visible to them.
 */
export async function linkPhoto(
	db: Database,
	userId: string,
	photoId: string,
	input: unknown
): Promise<Confirmed | null> {
	const value = linkSchema.parse(input);
	return db.transaction(async (tx) => {
		const photo = await lockOpenPhoto(tx, userId, photoId);
		if (!photo) return null;
		// modelVisibleTo, not the by-id modelReadableBy: a model a later
		// snapshot retired is never offered for a NEW machine, so linking to it
		// is "not found", exactly like another user's model.
		const [model] = await tx
			.select()
			.from(equipmentModels)
			.where(and(eq(equipmentModels.id, value.modelId), modelVisibleTo(userId)));
		if (!model) throw new MachineInputError('Model not found');
		const machine = await createMachine(tx, userId, {
			gymId: photo.gymId,
			localLabel: value.localLabel,
			equipmentType: model.loadingType,
			equipmentModelId: model.id,
			stackLb: value.stackLb,
			incrementLb: value.incrementLb
		});
		await tx
			.update(equipmentPhotos)
			.set({ matchedModelId: model.id, gymEquipmentId: machine.id, status: 'confirmed' })
			.where(and(eq(equipmentPhotos.id, photo.id), eq(equipmentPhotos.userId, userId)));
		return { photoId: photo.id, modelId: model.id, gymEquipmentId: machine.id };
	});
}

/**
 * Create my own: an OWNED model (confidence 'user', no source) from the fields
 * the user confirmed — prefilled from the candidate, edited as they like —
 * then the same gym_equipment creation as a link. The candidate's notes may go
 * into the model's notes (0.3.2's column).
 */
export async function createModelFromPhoto(
	db: Database,
	userId: string,
	photoId: string,
	input: unknown
): Promise<Confirmed | null> {
	const value = createSchema.parse(input);
	return db.transaction(async (tx) => {
		const photo = await lockOpenPhoto(tx, userId, photoId);
		if (!photo) return null;
		const [model] = await tx
			.insert(equipmentModels)
			.values({
				manufacturer: value.manufacturer,
				productLine: value.productLine ?? null,
				code: value.code ?? null,
				name: value.name,
				loadingType: value.loadingType,
				laterality: value.laterality,
				startingResistance: value.startingResistance ?? null,
				startingResistanceBasis:
					value.startingResistance == null ? null : (value.startingResistanceBasis ?? null),
				notes: value.notes ?? null,
				confidence: 'user',
				sourceUrl: null,
				catalogSnapshot: null,
				ownerUserId: userId
			})
			.returning();
		const machine = await createMachine(tx, userId, {
			gymId: photo.gymId,
			localLabel: value.localLabel,
			equipmentType: model.loadingType,
			equipmentModelId: model.id,
			stackLb: value.stackLb,
			incrementLb: value.incrementLb
		});
		await tx
			.update(equipmentPhotos)
			.set({ createdModelId: model.id, gymEquipmentId: machine.id, status: 'confirmed' })
			.where(and(eq(equipmentPhotos.id, photo.id), eq(equipmentPhotos.userId, userId)));
		return { photoId: photo.id, modelId: model.id, gymEquipmentId: machine.id };
	});
}

/**
 * Discard: delete the object from the store, then mark the row `discarded`.
 * The row stays (audit), and so does its `llm_calls` row. The delete runs
 * inside the transaction, so a store failure leaves the photo as it was; a
 * retried discard is harmless (deleting a missing key succeeds).
 */
export async function discardPhoto(
	db: Database,
	userId: string,
	photoId: string,
	store: PhotoStore
): Promise<boolean> {
	return db.transaction(async (tx) => {
		const photo = await lockOpenPhoto(tx, userId, photoId);
		if (!photo) return false;
		await store.delete(photo.storageKey);
		await tx
			.update(equipmentPhotos)
			.set({ status: 'discarded' })
			.where(and(eq(equipmentPhotos.id, photo.id), eq(equipmentPhotos.userId, userId)));
		return true;
	});
}
