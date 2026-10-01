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
};

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
			return { method: 'exact', preselectedId: preselectAmong(exact), matches: exact };
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
			return {
				method: 'leading_digit',
				preselectedId: leading.length === 1 ? leading[0].id : null,
				matches: leading
			};
		}

		const prefix = coded.filter((m) => isPrefixMatch(normalizeCode(m.code!), code));
		if (prefix.length) {
			return {
				method: 'prefix',
				preselectedId: prefix.length === 1 ? prefix[0].id : null,
				matches: prefix
			};
		}
	}

	const tokens = candidate.name ? nameTokens(candidate.name) : [];
	if (tokens.length) {
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
		if (rows.length) {
			return { method: 'name', preselectedId: null, matches: rows.map((r) => r.model) };
		}
	}

	return { method: 'none', preselectedId: null, matches: [] };
}
