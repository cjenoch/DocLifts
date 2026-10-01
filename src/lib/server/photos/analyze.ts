/**
 * Photo analysis (0.4.0 §4): one vision call through `complete()`, the only
 * way this app calls a model (CLAUDE.md). The output is a CANDIDATE — a
 * suggestion the user reviews and approves on /photos/[id]/review. Nothing
 * here writes to `gym_equipment` or `equipment_models`.
 *
 * The image sent is the stored one: already oriented, resized and stripped of
 * all metadata (process.ts), so no location or device data reaches a provider.
 */
import { and, count, eq, gt, inArray, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { equipmentPhotos, llmCalls } from '../db/schema';
import type { Database } from '../progression';
import { complete as defaultComplete, LlmError, type CompleteRequest } from '../llm';
import type { PhotoLimits } from './config';
import { isUuid, PhotoLimitError } from './index';
import type { PhotoStore } from './store';

export const PHOTO_PURPOSE = 'equipment_from_photo';

const confidence = z.number().min(0).max(1).default(0);
const text = (max: number) => z.string().max(max);
/** null when unknown, and null when the model leaves the key out entirely. */
const maybe = <T extends z.ZodType>(t: T) => t.nullable().default(null);

/** Lower-case, and spaces/hyphens/slashes to underscores: "Weight-stack" -> "weight_stack". */
const key = (v: string) =>
	v
		.trim()
		.toLowerCase()
		.replace(/[\s\-/]+/g, '_');

/**
 * Models word these their own way: production's first real placards
 * (2026-10-01) came back with loading_type "weight_stack" and laterality
 * "iso-lateral", and both readings were otherwise right. Any synonym maps to
 * the allowed value; any other string is 'unknown' (what the model saw is
 * still in placard_text and notes). A non-string is still refused.
 */
const LOADING_SYNONYMS: Record<string, string> = {
	selectorized: 'selectorized',
	selectorised: 'selectorized',
	selector: 'selectorized',
	weight_stack: 'selectorized',
	weightstack: 'selectorized',
	stack: 'selectorized',
	stack_loaded: 'selectorized',
	pin_loaded: 'selectorized',
	plate_loaded: 'plate_loaded',
	plate: 'plate_loaded',
	plates: 'plate_loaded',
	plateloaded: 'plate_loaded',
	cable_stack: 'cable_stack',
	cable: 'cable_stack',
	cables: 'cable_stack',
	pulley: 'cable_stack',
	cable_column: 'cable_stack',
	unknown: 'unknown'
};
const LATERALITY_SYNONYMS: Record<string, string> = {
	independent: 'independent',
	independent_arms: 'independent',
	iso_lateral: 'independent',
	isolateral: 'independent',
	unilateral: 'independent',
	dual: 'independent',
	bilateral: 'bilateral',
	single: 'bilateral',
	unknown: 'unknown'
};

/** An enum that maps synonyms first, defaults to 'unknown', and only refuses a non-string. */
function oneOf<const T extends readonly [string, ...string[]]>(
	values: T,
	synonyms: Record<string, string>
) {
	return z.preprocess(
		(v) => (typeof v === 'string' ? (synonyms[key(v)] ?? 'unknown') : v),
		z.enum(values).default('unknown' as T[number])
	);
}

/**
 * What the model is asked to return. Field names are the spec's, verbatim.
 *
 * Every key tolerates being ABSENT, falling back to what "unknown" already
 * means: null, '', 'unknown', confidence 0 (which the review page marks as
 * low). A model without enforced structured output omits keys it has nothing
 * for — on 2026-10-01 production's first real analysis read the placard
 * perfectly and was refused as schema_error for leaving out product_line.
 * Wrong types and out-of-range values are still refused.
 */
export const EquipmentCandidate = z.object({
	/** Verbatim text visible on any label or placard; '' if none. */
	placard_text: text(4000).default(''),
	manufacturer: maybe(text(200)),
	product_line: maybe(text(200)),
	/** Exactly as printed, no normalization. */
	model_code: maybe(text(200)),
	/** e.g. "Iso-Lateral Row". */
	name: maybe(text(200)),
	loading_type: oneOf(['selectorized', 'plate_loaded', 'cable_stack', 'unknown'], LOADING_SYNONYMS),
	laterality: oneOf(['independent', 'bilateral', 'unknown'], LATERALITY_SYNONYMS),
	/** Only if printed; never estimated. */
	starting_resistance_lb: maybe(z.number().min(0).max(2000)),
	/** Only if a stack is visible and its top plate is legible. */
	stack_lb: maybe(z.number().min(0).max(2000)),
	field_confidence: z
		.object({
			manufacturer: confidence,
			model_code: confidence,
			name: confidence,
			loading_type: confidence
		})
		.default({ manufacturer: 0, model_code: 0, name: 0, loading_type: 0 }),
	/** What was unclear. */
	notes: text(2000).default('')
});
/**
 * What the model is SENT (0.4.4): the same fields, types and allowed values
 * as `EquipmentCandidate`, without its lengths, ranges and defaults, which
 * the reply is still held to by the zod schema. A derived schema took 15-16 s
 * per analysis on Claude Haiku 4.5 via OpenRouter and timed out on the owner's
 * photos; this one 3.7-7 s. `candidate-wire.test.ts` keeps the two in step.
 */
const nullable = (type: string) => ({ type: [type, 'null'] });
export const CANDIDATE_WIRE_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: [
		'placard_text',
		'manufacturer',
		'product_line',
		'model_code',
		'name',
		'loading_type',
		'laterality',
		'starting_resistance_lb',
		'stack_lb',
		'field_confidence',
		'notes'
	],
	properties: {
		placard_text: { type: 'string' },
		manufacturer: nullable('string'),
		product_line: nullable('string'),
		model_code: nullable('string'),
		name: nullable('string'),
		loading_type: {
			type: 'string',
			enum: ['selectorized', 'plate_loaded', 'cable_stack', 'unknown']
		},
		laterality: { type: 'string', enum: ['independent', 'bilateral', 'unknown'] },
		starting_resistance_lb: nullable('number'),
		stack_lb: nullable('number'),
		field_confidence: {
			type: 'object',
			additionalProperties: false,
			required: ['manufacturer', 'model_code', 'name', 'loading_type'],
			properties: {
				manufacturer: { type: 'number' },
				model_code: { type: 'number' },
				name: { type: 'number' },
				loading_type: { type: 'number' }
			}
		},
		notes: { type: 'string' }
	}
} as const;

export type EquipmentCandidate = z.infer<typeof EquipmentCandidate>;

/** The system prompt, verbatim. Its rules are the contract the review page relies on. */
export const SYSTEM_PROMPT = [
	'You read the identification placard of a gym strength machine from a photo, and report what it says.',
	'Rules:',
	'1. Report only what is visible in the photo. Do not use what you know about a product line to fill in anything that is not shown.',
	'2. null beats a guess. If a field is not clearly visible, return null for it (or "unknown" for loading_type and laterality).',
	'3. Transcribe the model code character for character, exactly as printed: same letters, digits, hyphens, spaces and case. Do not correct, complete or normalize it.',
	'4. Never estimate starting resistance. Give starting_resistance_lb only if a starting resistance is printed, in pounds; otherwise null.',
	'5. Give stack_lb only if a weight stack is visible and the number on its top plate is legible; otherwise null.',
	'6. placard_text is the verbatim text visible on any label or placard, or an empty string if there is none.',
	'7. If no placard is visible, say so in notes. Use notes for anything that was unclear.',
	'8. field_confidence is your confidence, from 0 to 1, that each of manufacturer, model_code, name and loading_type is correct as given.'
].join('\n');

/** The user message's text part: the instruction plus the user's optional note. */
export function userText(note?: string | null): string {
	const trimmed = note?.trim();
	return trimmed
		? `Read this machine's placard. The user adds: ${trimmed}`
		: "Read this machine's placard.";
}

export type CompleteFn = <T>(
	db: Database,
	userId: string,
	request: CompleteRequest<T>
) => Promise<{ output: T; callId: string }>;

/** Analyses (calls that reached the provider) for this user in the last 24 hours. */
export async function analysesInLastDay(db: Database, userId: string): Promise<number> {
	const [{ n }] = await db
		.select({ n: count() })
		.from(llmCalls)
		.where(
			and(
				eq(llmCalls.userId, userId),
				eq(llmCalls.purpose, PHOTO_PURPOSE),
				ne(llmCalls.status, 'refused'),
				gt(llmCalls.createdAt, sql`now() - interval '24 hours'`)
			)
		);
	return n;
}

export const analysisLimitMessage = (limit: number) =>
	limit === 0
		? 'Photo analysis is switched off.'
		: `You have run ${limit} photo analyses in the last 24 hours, the daily limit. Try again later.`;

export type AnalyzeOutcome =
	| { ok: true; candidate: EquipmentCandidate; callId: string }
	/** The call failed; the photo row is unchanged and `llm_calls` says why. */
	| { ok: false; error: LlmError };

async function readAll(body: NodeJS.ReadableStream): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const c of body) chunks.push(Buffer.from(c as Buffer));
	return Buffer.concat(chunks);
}

/**
 * Read one of this user's photos with the vision model and attach the
 * candidate (status `analyzed`). Allowed on `uploaded` and `analyzed`
 * (re-analysis); a confirmed or discarded photo is not analyzed.
 *
 * Returns null when the photo is not this user's (or not analyzable). On a
 * model failure (schema miss, provider error, timeout, not configured, hourly
 * cap) the row is NOT changed — an `uploaded` photo stays `uploaded` — and the
 * outcome carries the typed error; `complete()` has already recorded the call.
 *
 * Capped by PHOTO_DAILY_LIMIT, counted over this user's analyses (llm_calls
 * rows for this purpose that reached the provider) in the last 24 hours, and
 * separately from uploads. Throws `PhotoLimitError`.
 */
export async function analyzePhoto(
	db: Database,
	userId: string,
	photoId: string,
	deps: { store: PhotoStore; limits: PhotoLimits; note?: string | null; complete?: CompleteFn }
): Promise<AnalyzeOutcome | null> {
	if (!isUuid(photoId)) return null;
	const [photo] = await db
		.select()
		.from(equipmentPhotos)
		.where(
			and(
				eq(equipmentPhotos.id, photoId),
				eq(equipmentPhotos.userId, userId),
				inArray(equipmentPhotos.status, ['uploaded', 'analyzed'])
			)
		);
	if (!photo) return null;
	if ((await analysesInLastDay(db, userId)) >= deps.limits.dailyLimit) {
		throw new PhotoLimitError(analysisLimitMessage(deps.limits.dailyLimit));
	}
	const object = await deps.store.get(photo.storageKey);
	if (!object) return null;
	const image = await readAll(object.body);

	const complete = deps.complete ?? defaultComplete;
	try {
		const { output, callId } = await complete(db, userId, {
			purpose: PHOTO_PURPOSE,
			kind: 'vision',
			system: SYSTEM_PROMPT,
			messages: [
				{
					role: 'user',
					content: [
						{ type: 'image', image, mediaType: 'image/jpeg' },
						{ type: 'text', text: userText(deps.note) }
					]
				}
			],
			schema: EquipmentCandidate,
			wireSchema: CANDIDATE_WIRE_SCHEMA
		});
		await db
			.update(equipmentPhotos)
			.set({ candidate: output, llmCallId: callId, status: 'analyzed' })
			.where(
				and(
					eq(equipmentPhotos.id, photo.id),
					eq(equipmentPhotos.userId, userId),
					inArray(equipmentPhotos.status, ['uploaded', 'analyzed'])
				)
			);
		return { ok: true, candidate: output, callId };
	} catch (error) {
		if (error instanceof LlmError) return { ok: false, error };
		throw error;
	}
}

/** A stored candidate, re-validated on read: jsonb is not trusted to be the current shape. */
export function parseCandidate(value: unknown): EquipmentCandidate | null {
	const parsed = EquipmentCandidate.safeParse(value);
	return parsed.success ? parsed.data : null;
}
