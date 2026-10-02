/**
 * Matching a photo's candidate against the models this user can see (0.4.0
 * §5). Server-side; every query carries `modelVisibleTo(userId)`, so a global
 * catalog row or the user's own model can match, and another user's owned
 * model never does (it is invisible, exactly as on /equipment).
 *
 * In order, stopping at the first that finds anything:
 *
 *  1. exact — manufacturer (case-insensitive) and model code (case-,
 *     whitespace- and hyphen-insensitive: `IL ROW` = `IL-ROW` = `il-row`).
 *     One match is preselected.
 *  2. prefix (owner addition, 2026-10-01) — within the manufacturer, a code
 *     whose normalized form is a prefix of the other's, the shorter at least
 *     4 characters. Catalogs often list a BASE code while the placard prints
 *     the full SKU: Technogym `MB20` vs placard `MB200N0-ANV0GGGP`, Pure
 *     `MG3000` vs `MG3000-NBGJV0`. One match is preselected and labelled a
 *     prefix match; several are shown with none preselected.
 *  2b. (checked between 1 and 2) leading digit — owner-approved: within the
 *     manufacturer, the two normalized codes differ only by one leading digit
 *     on one side (Nautilus `9NP-L3004` vs placard `NP-L3004`, either way
 *     round), the shared part at least 4 characters. One match is
 *     preselected and labelled a leading-digit match; several, none.
 *  3. name — the candidate name's tokens (length >= 3), each an ILIKE on the
 *     model name, ranked by how many appear, then by the shorter name (so
 *     "Iso-Lateral Row" outranks "Iso-Lateral High Row" for "Iso Lateral
 *     Row"); within the manufacturer when the user can see any of its models,
 *     otherwise across all; top 5; nothing preselected.
 *  4. none.
 *
 * Order: exact, leading digit, prefix, name, none. If a photo is preselected
 * to the wrong model, suspect the leading-digit rule first. See docs/photos.md.
 *
 * Name guard (owner decision, 0.5.2): a code match (exact, leading digit or
 * prefix) is preselected only when the read name shares at least one
 * meaningful word with the matched model's name. Maker words, the model's
 * product-line words and GENERIC_NAME_WORDS do not count, so "Pure Kraft" or
 * "Iso-Lateral" can't vouch for a wrong machine. If they share none, the code
 * matches are returned with the name matches after them, nothing preselected,
 * and `nameDisagrees` set. With no meaningful name read, the code alone still
 * preselects. Why: a placard misread to a real code (gym80 4352 read as 4157,
 * a different machine) is repeated across reads at confidence 1.0; the name
 * is the independent check that catches it.
 */
import { and, asc, eq, isNotNull, sql, type SQL } from 'drizzle-orm';
import { equipmentModels } from '../db/schema';
import type { Database } from '../progression';
import { likePattern, modelVisibleTo } from '../catalog';
import type { EquipmentCandidate } from './analyze';

export type EquipmentModel = typeof equipmentModels.$inferSelect;
export type MatchMethod = 'exact' | 'leading_digit' | 'prefix' | 'name' | 'none';
export type CandidateMatches = {
	method: MatchMethod;
	/** The match to preselect, or null when the user must choose. */
	preselectedId: string | null;
	matches: EquipmentModel[];
	/** A code match whose model name shares no meaningful word with the name read (0.5.2). */
	nameDisagrees?: boolean;
};

/** Words that say nothing about which machine it is. Maker and line words are added per model. */
export const GENERIC_NAME_WORDS = ['series', 'machine', 'station'];

/** The shortest code a prefix match may rest on. */
export const MIN_PREFIX_LENGTH = 4;
export const NAME_MATCH_LIMIT = 5;

/** Case-, whitespace- and hyphen-insensitive form of a model code. */
export const normalizeCode = (code: string): string => code.toLowerCase().replace(/[\s-]+/g, '');

/** The same normalization, in SQL, for the exact step. */
const normalizedCodeSql = sql`regexp_replace(lower(${equipmentModels.code}), '[[:space:]-]+', '', 'g')`;
const sameManufacturer = (m: string): SQL =>
	sql`lower(btrim(${equipmentModels.manufacturer})) = ${m.trim().toLowerCase()}`;

/**
 * True when two normalized codes differ only by ONE leading digit on one side:
 * Nautilus lists `9NP-L3004` where the placard prints `NP-L3004` (or the
 * reverse). The shared part must be at least 4 characters, like a prefix.
 */
export function isLeadingDigitMatch(a: string, b: string): boolean {
	const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
	return (
		longer.length === shorter.length + 1 &&
		shorter.length >= MIN_PREFIX_LENGTH &&
		/^[0-9]$/.test(longer[0]) &&
		longer.slice(1) === shorter
	);
}

/** True when one normalized code is a prefix of the other, the shorter >= 4 chars. */
export function isPrefixMatch(a: string, b: string): boolean {
	const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
	return shorter.length >= MIN_PREFIX_LENGTH && longer.startsWith(shorter);
}

/** Name tokens: alphanumeric runs of 3+ characters, lowercased, deduplicated. */
export function nameTokens(name: string): string[] {
	return [...new Set((name.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 3))];
}

/** The name's tokens minus maker, product-line and generic words (0.5.2 name guard). */
export function meaningfulTokens(
	name: string | null | undefined,
	ignore: (string | null | undefined)[]
): string[] {
	const skip = new Set([...GENERIC_NAME_WORDS, ...ignore.flatMap((w) => (w ? nameTokens(w) : []))]);
	return name ? nameTokens(name).filter((t) => !skip.has(t)) : [];
}

/** True when the read name and the model's name share a meaningful word, or nothing meaningful was read. */
export function nameAgrees(
	readName: string | null | undefined,
	readMaker: string | null,
	model: EquipmentModel
): boolean {
	const ignore = [readMaker, model.manufacturer, model.productLine];
	const read = meaningfulTokens(readName, ignore);
	if (!read.length) return true;
	const theirs = new Set(meaningfulTokens(model.name, ignore));
	return read.some((t) => theirs.has(t));
}

/** Several exact rows (a user's own copy beside the catalog row): prefer the single owned one. */
function preselectAmong(rows: EquipmentModel[]): string | null {
	if (rows.length === 1) return rows[0].id;
	const owned = rows.filter((r) => r.ownerUserId !== null);
	return owned.length === 1 ? owned[0].id : null;
}

export async function matchCandidate(
	db: Database,
	userId: string,
	candidate: Pick<EquipmentCandidate, 'manufacturer' | 'model_code' | 'name'>
): Promise<CandidateMatches> {
	const manufacturer = candidate.manufacturer?.trim() || null;
	const code = candidate.model_code ? normalizeCode(candidate.model_code) : '';
	const tokens = candidate.name ? nameTokens(candidate.name) : [];

	// The name guard: keep a code preselection only if the names agree.
	const guarded = async (
		method: MatchMethod,
		matches: EquipmentModel[],
		preselectedId: string | null
	): Promise<CandidateMatches> => {
		const chosen = matches.find((m) => m.id === preselectedId);
		if (!chosen || nameAgrees(candidate.name, manufacturer, chosen)) {
			return { method, preselectedId, matches };
		}
		const byName = await nameMatches(db, userId, manufacturer, tokens);
		const seen = new Set(matches.map((m) => m.id));
		return {
			method,
			preselectedId: null,
			matches: [...matches, ...byName.filter((m) => !seen.has(m.id))],
			nameDisagrees: true
		};
	};

	if (manufacturer && code) {
		const exact = await db
			.select()
			.from(equipmentModels)
			.where(
				and(
					modelVisibleTo(userId),
					sameManufacturer(manufacturer),
					isNotNull(equipmentModels.code),
					sql`${normalizedCodeSql} = ${code}`
				)
			)
			// The user's own row first, then the catalog's.
			.orderBy(sql`${equipmentModels.ownerUserId} IS NULL`, asc(equipmentModels.id));
		if (exact.length) {
			return guarded('exact', exact, preselectAmong(exact));
		}

		const coded = await db
			.select()
			.from(equipmentModels)
			.where(
				and(modelVisibleTo(userId), sameManufacturer(manufacturer), isNotNull(equipmentModels.code))
			)
			.orderBy(asc(equipmentModels.code), asc(equipmentModels.id));
		// Leading digit (owner-approved, 0.4.0), before prefix: the more
		// specific rule. If a photo is preselected to the wrong model, this
		// rule is the first suspect (docs/photos.md).
		const leading = coded.filter((m) => isLeadingDigitMatch(normalizeCode(m.code!), code));
		if (leading.length) {
			return guarded('leading_digit', leading, leading.length === 1 ? leading[0].id : null);
		}

		const prefix = coded.filter((m) => isPrefixMatch(normalizeCode(m.code!), code));
		if (prefix.length) {
			return guarded('prefix', prefix, prefix.length === 1 ? prefix[0].id : null);
		}
	}

	const byName = await nameMatches(db, userId, manufacturer, tokens);
	if (byName.length) return { method: 'name', preselectedId: null, matches: byName };

	return { method: 'none', preselectedId: null, matches: [] };
}

/** Step 3, the name search: also offered after a code match whose name disagrees. */
async function nameMatches(
	db: Database,
	userId: string,
	manufacturer: string | null,
	tokens: string[]
): Promise<EquipmentModel[]> {
	if (!tokens.length) return [];
	const [{ known }] = manufacturer
		? await db
				.select({ known: sql<number>`count(*)::int` })
				.from(equipmentModels)
				.where(and(modelVisibleTo(userId), sameManufacturer(manufacturer)))
		: [{ known: 0 }];
	const score = sql<number>`(${sql.join(
		tokens.map(
			(t) => sql`(CASE WHEN ${equipmentModels.name} ILIKE ${likePattern(t)} THEN 1 ELSE 0 END)`
		),
		sql` + `
	)})`;
	const rows = await db
		.select({ model: equipmentModels, score })
		.from(equipmentModels)
		.where(
			and(
				modelVisibleTo(userId),
				known > 0 ? sameManufacturer(manufacturer!) : undefined,
				sql`${score} > 0`
			)
		)
		.orderBy(
			sql`${score} DESC`,
			sql`length(${equipmentModels.name}) ASC`,
			asc(equipmentModels.name),
			asc(equipmentModels.id)
		)
		.limit(NAME_MATCH_LIMIT);
	return rows.map((r) => r.model);
}
