/**
 * The equipment catalog importer: a dated manufacturer snapshot CSV in, global
 * `equipment_models` rows (owner_user_id IS NULL) out.
 *
 * This is the ONLY code that writes global catalog rows (CLAUDE.md "The one
 * exception: the global equipment catalog"). It never reads or writes an owned
 * row: every lookup and every UPDATE carries `owner_user_id IS NULL`.
 *
 * No `$env`, no `$app`, no db singleton: it takes the database handle as an
 * argument so `scripts/catalog-import.ts` can build its own client under bare
 * tsx, exactly as seed.ts does.
 *
 * Shape of a run:
 *   1. parse + map every CSV row. Any row that cannot be mapped is an error,
 *      and ANY error stops the run before a single write.
 *   2. plan against the existing global rows: insert / update / unchanged /
 *      promote (a coded CSV row that names a codeless global row: the code
 *      is added to that row in place) / recode (a row whose `replaces_code`
 *      names an existing global row: that row takes the new code in place) /
 *      skipped (ambiguous or conflicting: resolve by hand).
 *   3. apply the plan in one transaction (skipped by --dry-run).
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from './db/schema';
import { BODY_REGIONS, CONFIDENCE_VALUES, RESISTANCE_BASES, equipmentModels } from './db/schema';

type Db = PostgresJsDatabase<typeof schema>;

/** CSV `loading_type` → the app's equipment type, which `createMachine` matches on. */
export const LOADING_TYPE_MAP: Record<string, string> = {
	selectorized: 'machine-stack',
	plate_loaded: 'machine-plate',
	cable_stack: 'cable'
};
/** CSV `laterality` → stored laterality. `n/a` is a real answer, not "unknown". */
export const LATERALITY_MAP: Record<string, string> = {
	bilateral: 'bilateral',
	independent: 'independent',
	'n/a': 'not_applicable'
};
/** Every value a CSV row may claim. `user` is never a catalog confidence. */
const CATALOG_CONFIDENCE = CONFIDENCE_VALUES.filter((c) => c !== 'user') as readonly string[];

const REQUIRED_COLUMNS = [
	'manufacturer',
	'product_line',
	'model_code',
	'name',
	'loading_type',
	'laterality',
	'body_region',
	'starting_resistance_lb',
	'starting_resistance_basis',
	'stack_lb',
	'confidence',
	'notes',
	'source',
	'catalog_snapshot'
] as const;
// Optional column, read when present; a snapshot without it imports exactly
// as before. `replaces_code`: the code this row's model was listed under in an
// earlier snapshot, when the manufacturer's code has been corrected (e.g.
// Hammer Strength IL-DY -> IL-DRW). Never stored; it only steers the match.

/** The columns the importer owns. On conflict, these and only these change. */
export type CatalogFields = {
	manufacturer: string;
	productLine: string | null;
	code: string | null;
	name: string;
	loadingType: string;
	laterality: string;
	bodyRegion: string | null;
	startingResistance: number | null;
	startingResistanceBasis: string | null;
	confidence: string;
	sourceUrl: string | null;
	catalogSnapshot: string;
	/** The catalog's remark on the row (0.3.2, migration 0014); empty becomes NULL. */
	notes: string | null;
	/**
	 * CSV `stack_lb`, in whole pounds rounded DOWN (0.3.2, 0015): a few
	 * manufacturers state half pounds (Life Fitness 262.5), the column and
	 * gym_equipment.stack_lb are integers, and a default must never overstate
	 * the stack. The exact figure stays in the note.
	 */
	standardStackLb: number | null;
	/** CSV `stack_note`, who stated the stack; empty becomes NULL. */
	standardStackNote: string | null;
};
const COMPARED: (keyof CatalogFields)[] = [
	'name',
	'productLine',
	'loadingType',
	'laterality',
	'bodyRegion',
	'startingResistance',
	'startingResistanceBasis',
	'confidence',
	'sourceUrl',
	'catalogSnapshot',
	'notes',
	'standardStackLb',
	'standardStackNote'
];

export type MappedRow = {
	line: number;
	fields: CatalogFields;
	/** CSV `replaces_code`: the earlier code of this model, to recode in place. */
	replacesCode: string | null;
};
export type RowError = { line: number; message: string };

/**
 * RFC 4180 CSV: quoted fields, doubled quotes, commas and newlines inside
 * quotes, CRLF or LF. Small on purpose; the repo carries no CSV dependency.
 */
export function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = '';
	let quoted = false;
	let i = 0;
	if (text.charCodeAt(0) === 0xfeff) i = 1;
	for (; i < text.length; i++) {
		const ch = text[i];
		if (quoted) {
			if (ch === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i++;
				} else quoted = false;
			} else field += ch;
		} else if (ch === '"') quoted = true;
		else if (ch === ',') {
			row.push(field);
			field = '';
		} else if (ch === '\n' || ch === '\r') {
			if (ch === '\r' && text[i + 1] === '\n') i++;
			row.push(field);
			rows.push(row);
			row = [];
			field = '';
		} else field += ch;
	}
	if (quoted) throw new Error('CSV ends inside a quoted field');
	if (field !== '' || row.length) {
		row.push(field);
		rows.push(row);
	}
	return rows.filter((r) => !(r.length === 1 && r[0].trim() === ''));
}

const blank = (v: string | undefined) => (v ?? '').trim() === '';
const opt = (v: string | undefined) => (blank(v) ? null : v!.trim());

/** Per-column counts the report states, so nothing is changed or dropped silently. */
export type Counts = {
	notes: number;
	startingResistanceKg: number;
	/** Rows with a stack_lb (stored as the model's standard stack). */
	stack: number;
	/** Of those, rows whose stack_lb is not whole pounds (stored rounded down). */
	stackRounded: number;
	sourceNotUrl: number;
};

export function mapCatalogCsv(text: string): {
	rows: MappedRow[];
	errors: RowError[];
	ignored: Counts;
} {
	const table = parseCsv(text);
	const errors: RowError[] = [];
	const rows: MappedRow[] = [];
	const ignored: Counts = {
		notes: 0,
		startingResistanceKg: 0,
		stack: 0,
		stackRounded: 0,
		sourceNotUrl: 0
	};
	if (!table.length) return { rows, errors: [{ line: 1, message: 'empty file' }], ignored };
	const header = table[0].map((h) => h.trim());
	const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
	if (missing.length)
		return {
			rows,
			errors: [{ line: 1, message: `missing columns: ${missing.join(', ')}` }],
			ignored
		};
	const keys = new Map<string, number>();
	const replaced = new Map<string, number>();
	table.slice(1).forEach((cells, idx) => {
		const line = idx + 2;
		if (cells.length !== header.length) {
			errors.push({ line, message: `expected ${header.length} fields, found ${cells.length}` });
			return;
		}
		const r = Object.fromEntries(header.map((h, i) => [h, cells[i]]));
		const problems: string[] = [];
		const manufacturer = opt(r.manufacturer);
		const name = opt(r.name);
		if (!manufacturer) problems.push('manufacturer is empty');
		if (!name) problems.push('name is empty');
		const loadingType = LOADING_TYPE_MAP[(r.loading_type ?? '').trim()];
		if (!loadingType) problems.push(`unknown loading_type '${r.loading_type}'`);
		const laterality = LATERALITY_MAP[(r.laterality ?? '').trim()];
		if (!laterality) problems.push(`unknown laterality '${r.laterality}'`);
		const bodyRegion = opt(r.body_region);
		if (bodyRegion && !(BODY_REGIONS as readonly string[]).includes(bodyRegion))
			problems.push(`unknown body_region '${bodyRegion}'`);
		const confidence = (r.confidence ?? '').trim();
		if (!CATALOG_CONFIDENCE.includes(confidence))
			problems.push(`unknown confidence '${r.confidence}'`);
		let startingResistance: number | null = null;
		const lb = opt(r.starting_resistance_lb);
		const basis = opt(r.starting_resistance_basis);
		if (lb) {
			startingResistance = Number(lb);
			if (!Number.isFinite(startingResistance) || startingResistance < 0)
				problems.push(`starting_resistance_lb '${lb}' is not a non-negative number`);
			if (!basis || !(RESISTANCE_BASES as readonly string[]).includes(basis))
				problems.push(`starting_resistance_basis '${basis ?? ''}' must be total or per_arm`);
		} else if (basis)
			problems.push('starting_resistance_basis given without starting_resistance_lb');
		let standardStackLb: number | null = null;
		const stack = opt(r.stack_lb);
		if (stack) {
			const exact = Number(stack);
			standardStackLb = Math.floor(exact);
			if (!Number.isFinite(exact) || standardStackLb < 1)
				problems.push(`stack_lb '${stack}' is not a number of pounds of at least 1`);
			else {
				ignored.stack++;
				if (standardStackLb !== exact) ignored.stackRounded++;
			}
		}
		const snapshot = (r.catalog_snapshot ?? '').trim();
		if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshot) || Number.isNaN(Date.parse(snapshot)))
			problems.push(`catalog_snapshot '${snapshot}' is not a YYYY-MM-DD date`);
		// Stored verbatim. A few rows name their source in words ("reseller
		// spec") rather than a URL; that is still provenance, so it is kept and
		// counted, and the UI links only values that are http(s) URLs.
		const sourceUrl = opt(r.source);
		if (sourceUrl && !/^https?:\/\//.test(sourceUrl)) ignored.sourceNotUrl++;
		const replacesCode = opt(r.replaces_code);
		if (replacesCode && !opt(r.model_code)) problems.push('replaces_code given without model_code');
		else if (replacesCode && replacesCode === opt(r.model_code))
			problems.push(`replaces_code '${replacesCode}' is the row's own model_code`);
		if (problems.length) {
			errors.push({ line, message: problems.join('; ') });
			return;
		}
		const code = opt(r.model_code);
		const productLine = opt(r.product_line);
		const key = importKey({ manufacturer: manufacturer!, code, productLine, name: name! });
		const seen = keys.get(key);
		if (seen) {
			errors.push({ line, message: `duplicate of line ${seen} (same import key)` });
			return;
		}
		keys.set(key, line);
		if (replacesCode) {
			const old = importKey({
				manufacturer: manufacturer!,
				code: replacesCode,
				productLine,
				name: name!
			});
			const other = replaced.get(old);
			if (other) {
				errors.push({
					line,
					message: `replaces_code '${replacesCode}' also replaced on line ${other}`
				});
				return;
			}
			replaced.set(old, line);
		}
		if (!blank(r.notes)) ignored.notes++;
		if (!blank(r.starting_resistance_kg)) ignored.startingResistanceKg++;
		rows.push({
			line,
			fields: {
				manufacturer: manufacturer!,
				productLine,
				code,
				name: name!,
				loadingType,
				laterality,
				bodyRegion,
				startingResistance,
				startingResistanceBasis: lb ? basis : null,
				confidence,
				sourceUrl,
				catalogSnapshot: snapshot,
				notes: opt(r.notes),
				standardStackLb,
				standardStackNote: opt(r.stack_note)
			},
			replacesCode
		});
	});
	return { rows, errors, ignored };
}

/**
 * The upsert key: (manufacturer, code) when the code is non-empty, else
 * (manufacturer, product_line, name). Codeless rows (Signature Series has no
 * codes) are not covered by the partial unique index, so this is their
 * only dedupe.
 */
export function importKey(r: {
	manufacturer: string;
	code: string | null;
	productLine: string | null;
	name: string;
}) {
	return r.code
		? JSON.stringify(['code', r.manufacturer, r.code])
		: JSON.stringify(['line', r.manufacturer, r.productLine ?? '', r.name]);
}

type Existing = typeof equipmentModels.$inferSelect;
export type PlanItem =
	| { kind: 'insert'; row: MappedRow }
	| { kind: 'update'; row: MappedRow; id: string; changed: (keyof CatalogFields)[] }
	| { kind: 'unchanged'; row: MappedRow; id: string }
	/** A code added to a model the catalog had without one: that row, updated in place. */
	| { kind: 'promote'; row: MappedRow; id: string; changed: (keyof CatalogFields)[] }
	/** A corrected code (`replaces_code`): the old-code row takes the new code in place. */
	| { kind: 'recode'; row: MappedRow; id: string; from: string; changed: (keyof CatalogFields)[] }
	| { kind: 'skipped'; row: MappedRow; reason: string };

/** The codeless key of a row, whatever its code: (manufacturer, product_line, name). */
const lineKey = (r: { manufacturer: string; productLine: string | null; name: string }) =>
	importKey({ ...r, code: null });

export function planImport(rows: MappedRow[], existingGlobal: Existing[]): PlanItem[] {
	const byKey = new Map<string, Existing[]>();
	for (const e of existingGlobal) {
		const k = importKey({
			manufacturer: e.manufacturer,
			code: e.code === '' ? null : e.code,
			productLine: e.productLine,
			name: e.name
		});
		byKey.set(k, [...(byKey.get(k) ?? []), e]);
	}
	const plan = rows.map((row): PlanItem => {
		let matches = byKey.get(importKey(row.fields)) ?? [];
		// A corrected code: the model was listed under `replaces_code` before.
		// Recode that row in place so gym_equipment links keep pointing at it.
		// Rows under both codes is a conflict a person must resolve.
		if (row.replacesCode) {
			const old = byKey.get(importKey({ ...row.fields, code: row.replacesCode })) ?? [];
			if (old.length && matches.length)
				return {
					kind: 'skipped',
					row,
					reason: `global rows exist for both ${row.fields.code} and the code it replaces, ${row.replacesCode}; resolve by hand`
				};
			if (old.length === 1) {
				const [e] = old;
				const changed = COMPARED.filter((f) => (e[f] ?? null) !== (row.fields[f] ?? null));
				return {
					kind: 'recode',
					row,
					id: e.id,
					from: row.replacesCode,
					changed: ['code', ...changed]
				};
			}
			if (old.length > 1)
				return {
					kind: 'skipped',
					row,
					reason: `replaces_code ${row.replacesCode} matches ${old.length} existing global rows; resolve by hand`
				};
		}
		let promote = false;
		// A snapshot that adds a code to a model the catalog had without one
		// must not insert a second row beside it: gym_equipment rows point at
		// the codeless one. With no global row for (manufacturer, code), look
		// for the codeless row of the same (manufacturer, product_line, name)
		// and give it the code in place.
		if (matches.length === 0 && row.fields.code) {
			matches = byKey.get(lineKey(row.fields)) ?? [];
			promote = matches.length > 0;
		}
		if (matches.length === 0) return { kind: 'insert', row };
		if (matches.length > 1)
			return {
				kind: 'skipped',
				row,
				reason: promote
					? `adds a code to ${matches.length} existing codeless global rows of the same line and name; resolve by hand`
					: `key matches ${matches.length} existing global rows; resolve by hand`
			};
		const [e] = matches;
		const changed = COMPARED.filter((f) => (e[f] ?? null) !== (row.fields[f] ?? null));
		if (promote) return { kind: 'promote', row, id: e.id, changed: ['code', ...changed] };
		return changed.length
			? { kind: 'update', row, id: e.id, changed }
			: { kind: 'unchanged', row, id: e.id };
	});
	// One existing row, one CSV row. Two coded rows promoting the same codeless
	// row, or a promotion of a row the CSV also names without a code, cannot
	// both be applied: every claimant is skipped, which fails the run.
	const claims = new Map<string, number>();
	for (const p of plan) if ('id' in p) claims.set(p.id, (claims.get(p.id) ?? 0) + 1);
	return plan.map((p): PlanItem => {
		// Keys are unique within the CSV, so only a promotion or a recode can
		// make a claim twice.
		if (!('id' in p) || claims.get(p.id) === 1) return p;
		return {
			kind: 'skipped',
			row: p.row,
			reason: `${claims.get(p.id)} CSV rows claim the same existing codeless global row; resolve by hand`
		};
	});
}

export type ManufacturerTally = {
	inserted: number;
	updated: number;
	promoted: number;
	recoded: number;
	unchanged: number;
	skipped: number;
};
export type ImportResult = {
	dryRun: boolean;
	errors: RowError[];
	plan: PlanItem[];
	byManufacturer: Map<string, ManufacturerTally>;
	/** Global rows of the CSV's manufacturers that this CSV does not mention. Left untouched. */
	untouchedGlobal: number;
	ignored: Counts;
	/** True when the run must exit non-zero. */
	failed: boolean;
};

export async function importCatalog(
	db: Db,
	csvText: string,
	opts: { dryRun: boolean }
): Promise<ImportResult> {
	const { rows, errors, ignored } = mapCatalogCsv(csvText);
	const empty: ImportResult = {
		dryRun: opts.dryRun,
		errors,
		plan: [],
		byManufacturer: new Map(),
		untouchedGlobal: 0,
		ignored,
		failed: true
	};
	// Any unmappable row stops the run before the database is touched.
	if (errors.length) return empty;

	return db.transaction(async (tx) => {
		// Serialize concurrent imports; app reads are not blocked.
		// SHARE ROW EXCLUSIVE conflicts with itself and with writers only.
		await tx.execute(sql`LOCK TABLE equipment_models IN SHARE ROW EXCLUSIVE MODE`);
		const existing = await tx
			.select()
			.from(equipmentModels)
			.where(isNull(equipmentModels.ownerUserId));
		const plan = planImport(rows, existing);
		const byManufacturer = new Map<string, ManufacturerTally>();
		for (const item of plan) {
			const m = item.row.fields.manufacturer;
			const t = byManufacturer.get(m) ?? {
				inserted: 0,
				updated: 0,
				promoted: 0,
				recoded: 0,
				unchanged: 0,
				skipped: 0
			};
			if (item.kind === 'insert') t.inserted++;
			else if (item.kind === 'update') t.updated++;
			else if (item.kind === 'promote') t.promoted++;
			else if (item.kind === 'recode') t.recoded++;
			else if (item.kind === 'unchanged') t.unchanged++;
			else t.skipped++;
			byManufacturer.set(m, t);
		}
		const matched = new Set(plan.flatMap((p) => ('id' in p ? [p.id] : [])));
		const manufacturers = new Set(rows.map((r) => r.fields.manufacturer));
		const untouchedGlobal = existing.filter(
			(e) => manufacturers.has(e.manufacturer) && !matched.has(e.id)
		).length;
		const skipped = plan.some((p) => p.kind === 'skipped');
		const result: ImportResult = {
			dryRun: opts.dryRun,
			errors,
			plan,
			byManufacturer,
			untouchedGlobal,
			ignored,
			failed: skipped
		};
		if (opts.dryRun || skipped) return result;

		const inserts = plan.flatMap((p) => (p.kind === 'insert' ? [p.row.fields] : []));
		for (let i = 0; i < inserts.length; i += 200)
			await tx
				.insert(equipmentModels)
				.values(inserts.slice(i, i + 200).map((f) => ({ ...f, ownerUserId: null })));
		for (const p of plan) {
			if (p.kind !== 'update' && p.kind !== 'promote' && p.kind !== 'recode') continue;
			const f = p.row.fields;
			// owner_user_id IS NULL in the WHERE, not just in the lookup above:
			// this statement can never reach an owned row.
			await tx
				.update(equipmentModels)
				.set({
					name: f.name,
					productLine: f.productLine,
					loadingType: f.loadingType,
					laterality: f.laterality,
					bodyRegion: f.bodyRegion,
					startingResistance: f.startingResistance,
					startingResistanceBasis: f.startingResistanceBasis,
					confidence: f.confidence,
					sourceUrl: f.sourceUrl,
					catalogSnapshot: f.catalogSnapshot,
					notes: f.notes,
					standardStackLb: f.standardStackLb,
					standardStackNote: f.standardStackNote,
					// A promotion adds the code and a recode replaces it; an update
					// matched on it, or has none.
					...(p.kind === 'update' ? {} : { code: f.code })
				})
				.where(and(eq(equipmentModels.id, p.id), isNull(equipmentModels.ownerUserId)));
		}
		return result;
	});
}

/** The operator-facing report. Plain text, no row data beyond catalog facts. */
export function formatImportReport(r: ImportResult): string {
	const out: string[] = [];
	if (r.errors.length) {
		out.push(`REFUSED: ${r.errors.length} row(s) cannot be mapped; nothing was written.`);
		for (const e of r.errors) out.push(`  line ${e.line}: ${e.message}`);
		return out.join('\n');
	}
	out.push(r.dryRun ? 'DRY RUN — nothing written.' : 'Applied.');
	const head = [
		'manufacturer',
		'inserted',
		'updated',
		'promoted',
		'recoded',
		'unchanged',
		'skipped'
	];
	const lines = [...r.byManufacturer.entries()].sort(([a], [b]) => a.localeCompare(b));
	const total = lines.reduce(
		(t, [, v]) => ({
			inserted: t.inserted + v.inserted,
			updated: t.updated + v.updated,
			promoted: t.promoted + v.promoted,
			recoded: t.recoded + v.recoded,
			unchanged: t.unchanged + v.unchanged,
			skipped: t.skipped + v.skipped
		}),
		{ inserted: 0, updated: 0, promoted: 0, recoded: 0, unchanged: 0, skipped: 0 }
	);
	const width = Math.max(12, ...lines.map(([m]) => m.length));
	const fmt = (cells: (string | number)[]) =>
		cells.map((c, i) => (i === 0 ? String(c).padEnd(width) : String(c).padStart(9))).join(' ');
	out.push(fmt(head));
	for (const [m, v] of lines)
		out.push(fmt([m, v.inserted, v.updated, v.promoted, v.recoded, v.unchanged, v.skipped]));
	out.push(
		fmt([
			'TOTAL',
			total.inserted,
			total.updated,
			total.promoted,
			total.recoded,
			total.unchanged,
			total.skipped
		])
	);
	for (const p of r.plan)
		if (p.kind === 'skipped')
			out.push(`  skipped line ${p.row.line} (${p.row.fields.manufacturer}): ${p.reason}`);
	for (const p of r.plan)
		if (p.kind === 'update')
			out.push(
				`  update line ${p.row.line} ${p.row.fields.manufacturer} ${p.row.fields.code ?? p.row.fields.name}: ${p.changed.join(', ')}`
			);
	for (const p of r.plan)
		if (p.kind === 'promote')
			out.push(
				`  promote line ${p.row.line} ${p.row.fields.manufacturer} ${p.row.fields.name}: codeless row gains code ${p.row.fields.code}, kept in place (${p.changed.join(', ')})`
			);
	for (const p of r.plan)
		if (p.kind === 'recode')
			out.push(
				`  recode line ${p.row.line} ${p.row.fields.manufacturer} ${p.from} -> ${p.row.fields.code}: kept in place (${p.changed.join(', ')})`
			);
	if (r.untouchedGlobal)
		out.push(
			`${r.untouchedGlobal} existing global row(s) are not in this CSV and were left as they are.`
		);
	out.push('');
	out.push('Not imported onto the model (by design):');
	out.push(
		`  starting_resistance_kg: ${r.ignored.startingResistanceKg} row(s); the lb value is stored, kg is derived.`
	);
	if (r.ignored.notes)
		out.push(
			`  (kept) notes: ${r.ignored.notes} row(s) carry a note; stored on the model (equipment_models.notes) and shown on its page.`
		);
	if (r.ignored.stack)
		out.push(
			`  (kept) stack_lb: ${r.ignored.stack} row(s) carry a standard stack; stored on the model (equipment_models.standard_stack_lb) and pre-filled when a machine is added.`
		);
	if (r.ignored.stackRounded)
		out.push(
			`  (rounded down) stack_lb: ${r.ignored.stackRounded} of them are not whole pounds; stored rounded down, the exact figure stays in stack_note.`
		);
	if (r.ignored.sourceNotUrl)
		out.push(
			`  (kept) source: ${r.ignored.sourceNotUrl} row(s) name their source in words, not a URL; stored as written, shown unlinked.`
		);
	if (r.failed) out.push('FAILED: skipped rows above; nothing was written.');
	return out.join('\n');
}
