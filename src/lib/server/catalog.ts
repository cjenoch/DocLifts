/**
 * Equipment model reads and the owned-row writes (spec 0.3.0 A3–A6).
 *
 * `equipment_models` holds two kinds of row (CLAUDE.md, "The one exception:
 * the global equipment catalog"): global catalog rows (owner_user_id IS NULL),
 * read-only to every user, and owned rows (owner_user_id = userId), user data.
 * Every read here goes through `modelVisibleTo`; every write targets an owned
 * row by putting `owner_user_id = userId` in its WHERE.
 */
import { and, asc, count, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { RESISTANCE_BASES, equipmentModels, gymEquipment, gyms } from './db/schema';
import type { Database } from './progression';

/**
 * The one visibility rule for models: global, or this user's own. Another
 * user's owned model is indistinguishable from a missing id (D6).
 */
export function modelVisibleTo(userId: string): SQL {
	return or(isNull(equipmentModels.ownerUserId), eq(equipmentModels.ownerUserId, userId))!;
}

export const PAGE_SIZE = 50;
export const LOADING_TYPES = ['machine-stack', 'machine-plate', 'cable'] as const;

/** `%`, `_` and `\` are literal in a search box, not ILIKE wildcards. */
export function likePattern(q: string): string {
	return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

// GET parameters. A malformed value is dropped, not an error: a hand-edited
// URL gets an unfiltered page, never a 500.
const text = z
	.string()
	.trim()
	.max(120)
	.transform((v) => v || undefined)
	.optional()
	.catch(undefined);
const browseSchema = z.object({
	manufacturer: text,
	line: text,
	loadingType: z.enum(LOADING_TYPES).optional().catch(undefined),
	bodyRegion: text,
	q: text,
	page: z.coerce.number().int().min(1).max(10_000).catch(1)
});
export type BrowseFilters = z.infer<typeof browseSchema>;

export function parseBrowseParams(params: URLSearchParams): BrowseFilters {
	return browseSchema.parse(Object.fromEntries(params));
}

/** Case-insensitive match on name OR code. */
function matchesQuery(q: string): SQL {
	return or(
		ilike(equipmentModels.name, likePattern(q)),
		ilike(equipmentModels.code, likePattern(q))
	)!;
}

/** The browse list: filtered, sorted by manufacturer, line, code, paginated at 50. */
export async function browseModels(db: Database, userId: string, filters: BrowseFilters) {
	const where = and(
		modelVisibleTo(userId),
		filters.manufacturer ? eq(equipmentModels.manufacturer, filters.manufacturer) : undefined,
		filters.line ? eq(equipmentModels.productLine, filters.line) : undefined,
		filters.loadingType ? eq(equipmentModels.loadingType, filters.loadingType) : undefined,
		filters.bodyRegion ? eq(equipmentModels.bodyRegion, filters.bodyRegion) : undefined,
		filters.q ? matchesQuery(filters.q) : undefined
	);
	const [{ total }] = await db.select({ total: count() }).from(equipmentModels).where(where);
	const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
	// Past the end clamps to the last page rather than showing an empty one.
	const page = Math.min(filters.page, pages);
	const rows = await db
		.select()
		.from(equipmentModels)
		.where(where)
		.orderBy(
			asc(equipmentModels.manufacturer),
			sql`${equipmentModels.productLine} ASC NULLS LAST`,
			sql`${equipmentModels.code} ASC NULLS LAST`,
			asc(equipmentModels.name),
			asc(equipmentModels.id)
		)
		.limit(PAGE_SIZE)
		.offset((page - 1) * PAGE_SIZE);
	return { rows, total, page, pages, pageSize: PAGE_SIZE };
}

/** Filter options. Product lines only for a chosen manufacturer (the second step). */
export async function browseFacets(db: Database, userId: string, manufacturer?: string) {
	const manufacturers = (
		await db
			.selectDistinct({ v: equipmentModels.manufacturer })
			.from(equipmentModels)
			.where(modelVisibleTo(userId))
			.orderBy(asc(equipmentModels.manufacturer))
	).map((r) => r.v);
	const lines = manufacturer
		? (
				await db
					.selectDistinct({ v: equipmentModels.productLine })
					.from(equipmentModels)
					.where(and(modelVisibleTo(userId), eq(equipmentModels.manufacturer, manufacturer)))
					.orderBy(asc(equipmentModels.productLine))
			)
				.map((r) => r.v)
				.filter((v): v is string => !!v)
		: [];
	const bodyRegions = (
		await db
			.selectDistinct({ v: equipmentModels.bodyRegion })
			.from(equipmentModels)
			.where(modelVisibleTo(userId))
			.orderBy(asc(equipmentModels.bodyRegion))
	)
		.map((r) => r.v)
		.filter((v): v is string => !!v);
	return { manufacturers, lines, bodyRegions };
}

const uuid = z.string().uuid();

/** One model, if this user may see it. Another user's owned model is null, like a missing id. */
export async function loadModel(db: Database, userId: string, modelId: string) {
	if (!uuid.safeParse(modelId).success) return null;
	const [row] = await db
		.select()
		.from(equipmentModels)
		.where(and(eq(equipmentModels.id, modelId), modelVisibleTo(userId)));
	return row ?? null;
}

/** This user's machines that are an instance of the model. Never another user's gyms. */
export async function instancesOfModel(db: Database, userId: string, modelId: string) {
	return db
		.select({
			gymEquipmentId: gymEquipment.id,
			gymId: gyms.id,
			gymName: gyms.name,
			localLabel: gymEquipment.localLabel,
			stackLb: gymEquipment.stackLb,
			incrementLb: gymEquipment.incrementLb
		})
		.from(gymEquipment)
		.innerJoin(gyms, eq(gyms.id, gymEquipment.gymId))
		.where(and(eq(gymEquipment.equipmentModelId, modelId), eq(gyms.userId, userId)))
		.orderBy(asc(gyms.name), asc(gymEquipment.localLabel));
}

/** This user's gyms, for the add-to-gym select. */
export async function gymsOf(db: Database, userId: string) {
	return db.select().from(gyms).where(eq(gyms.userId, userId)).orderBy(asc(gyms.name));
}

const pickerSchema = z.object({
	gym: z.string().uuid().optional().catch(undefined),
	q: text,
	all: z
		.string()
		.optional()
		.transform((v) => v === '1')
		.catch(false)
});
export type PickerParams = z.infer<typeof pickerSchema>;
export function parsePickerParams(params: URLSearchParams): PickerParams {
	return pickerSchema.parse(Object.fromEntries(params));
}

/**
 * The model list for the "add a physical machine" form, narrowed so 543
 * catalog rows stay usable without a typeahead:
 *
 *   - default: models whose manufacturer already appears among THIS gym's
 *     machines (the gym must be the user's own; another user's gym id yields
 *     no manufacturers, exactly like a missing one);
 *   - `all`: every visible model ("all manufacturers" expander);
 *   - `q`: models whose name or code matches, across all manufacturers.
 */
export async function modelChoices(
	db: Database,
	userId: string,
	params: { gym?: string; q?: string; all?: boolean }
) {
	const gymManufacturers = params.gym
		? (
				await db
					.selectDistinct({ v: equipmentModels.manufacturer })
					.from(gymEquipment)
					.innerJoin(gyms, eq(gyms.id, gymEquipment.gymId))
					.innerJoin(equipmentModels, eq(equipmentModels.id, gymEquipment.equipmentModelId))
					.where(and(eq(gyms.id, params.gym), eq(gyms.userId, userId), modelVisibleTo(userId)))
					.orderBy(asc(equipmentModels.manufacturer))
			).map((r) => r.v)
		: [];
	const scope: 'search' | 'all' | 'gym' = params.q ? 'search' : params.all ? 'all' : 'gym';
	const narrowing =
		scope === 'search'
			? matchesQuery(params.q!)
			: scope === 'all'
				? undefined
				: gymManufacturers.length
					? inArray(equipmentModels.manufacturer, gymManufacturers)
					: sql`false`;
	const models = await db
		.select()
		.from(equipmentModels)
		.where(and(modelVisibleTo(userId), narrowing))
		.orderBy(
			asc(equipmentModels.manufacturer),
			asc(equipmentModels.name),
			sql`${equipmentModels.code} ASC NULLS LAST`
		);
	return { models, scope, gymManufacturers };
}

export const LATERALITIES = ['bilateral', 'independent', 'not_applicable', 'unknown'] as const;
const blankToNull = (v: unknown) => (v === '' || v == null ? null : v);
const loadFieldsSchema = z
	.object({
		startingResistance: z.preprocess(blankToNull, z.coerce.number().min(0).max(2000).nullable()),
		startingResistanceBasis: z.preprocess(blankToNull, z.enum(RESISTANCE_BASES).nullable()),
		laterality: z.enum(LATERALITIES)
	})
	.refine((v) => v.startingResistance == null || v.startingResistanceBasis != null, {
		message: 'Say whether the starting resistance is total or per arm'
	})
	// A basis with no number means nothing; drop it rather than store noise.
	.transform((v) => ({
		...v,
		startingResistanceBasis: v.startingResistance == null ? null : v.startingResistanceBasis
	}));
export type LoadFields = z.infer<typeof loadFieldsSchema>;

/**
 * Edit the load fields of a model THIS user owns. The owner is in the UPDATE's
 * WHERE, so a global row or another user's row is simply not found (null),
 * never changed: global rows are catalog data and are not editable in place.
 */
export async function updateOwnedModel(
	db: Database,
	userId: string,
	modelId: string,
	input: unknown
) {
	if (!uuid.safeParse(modelId).success) return null;
	const value = loadFieldsSchema.parse(input);
	const [row] = await db
		.update(equipmentModels)
		.set(value)
		.where(and(eq(equipmentModels.id, modelId), eq(equipmentModels.ownerUserId, userId)))
		.returning();
	return row ?? null;
}

/**
 * "Create my own copy": an owned duplicate of a visible model, carrying the
 * user's load fields and confidence 'user', so a wrong catalog number can be
 * corrected for one person without changing the catalog for everyone. The
 * copy keeps the model's identity (manufacturer, line, code, name, loading
 * type, body region) and the catalog's notes, and drops the catalog
 * provenance (source, snapshot).
 * Returns null when the model is not visible to this user.
 */
export async function copyModelForUser(
	db: Database,
	userId: string,
	modelId: string,
	input: unknown
) {
	const value = loadFieldsSchema.parse(input);
	const source = await loadModel(db, userId, modelId);
	if (!source) return null;
	const [copy] = await db
		.insert(equipmentModels)
		.values({
			manufacturer: source.manufacturer,
			productLine: source.productLine,
			code: source.code,
			name: source.name,
			loadingType: source.loadingType,
			bodyRegion: source.bodyRegion,
			notes: source.notes,
			...value,
			confidence: 'user',
			sourceUrl: null,
			catalogSnapshot: null,
			ownerUserId: userId
		})
		.returning();
	return copy;
}
