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
 *      skipped (ambiguous: the key matches more than one global row).
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
	'source',
	'catalog_snapshot'
] as const;

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
	'catalogSnapshot'
];

export type MappedRow = {
	line: number;
	fields: CatalogFields;
	/** Instance data, deliberately NOT imported onto the model; reported instead. */
	stackLb: number | null;
	stackNote: string | null;
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

export function mapCatalogCsv(text: string): {
	rows: MappedRow[];
	errors: RowError[];
	ignored: { notes: number; startingResistanceKg: number; stackNote: number; sourceNotUrl: number };
} {
	const table = parseCsv(text);
	const errors: RowError[] = [];
	const rows: MappedRow[] = [];
	const ignored = { notes: 0, startingResistanceKg: 0, stackNote: 0, sourceNotUrl: 0 };
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
		let stackLb: number | null = null;
		const stack = opt(r.stack_lb);
		if (stack) {
			stackLb = Number(stack);
			if (!Number.isFinite(stackLb) || stackLb <= 0)
				problems.push(`stack_lb '${stack}' is not a positive number`);
		}
		const snapshot = (r.catalog_snapshot ?? '').trim();
		if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshot) || Number.isNaN(Date.parse(snapshot)))
			problems.push(`catalog_snapshot '${snapshot}' is not a YYYY-MM-DD date`);
		// Stored verbatim. A few rows name their source in words ("reseller
		// spec") rather than a URL; that is still provenance, so it is kept and
		// counted, and the UI links only values that are http(s) URLs.
		const sourceUrl = opt(r.source);
		if (sourceUrl && !/^https?:\/\//.test(sourceUrl)) ignored.sourceNotUrl++;
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
		if (!blank(r.notes)) ignored.notes++;
		if (!blank(r.starting_resistance_kg)) ignored.startingResistanceKg++;
		if (!blank(r.stack_note)) ignored.stackNote++;
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
				catalogSnapshot: snapshot
			},
			stackLb,
			stackNote: opt(r.stack_note)
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
	| { kind: 'skipped'; row: MappedRow; reason: string };

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
	return rows.map((row): PlanItem => {
		const matches = byKey.get(importKey(row.fields)) ?? [];
		if (matches.length === 0) return { kind: 'insert', row };
		if (matches.length > 1)
			return {
				kind: 'skipped',
				row,
				reason: `key matches ${matches.length} existing global rows; resolve by hand`
			};
		const [e] = matches;
		const changed = COMPARED.filter((f) => (e[f] ?? null) !== (row.fields[f] ?? null));
		return changed.length
			? { kind: 'update', row, id: e.id, changed }
			: { kind: 'unchanged', row, id: e.id };
	});
}

export type ManufacturerTally = {
	inserted: number;
	updated: number;
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
	ignored: { notes: number; startingResistanceKg: number; stackNote: number; sourceNotUrl: number };
	stackRows: MappedRow[];
	/** True when the run must exit non-zero. */
	failed: boolean;
};

export async function importCatalog(
	db: Db,
	csvText: string,
	opts: { dryRun: boolean }
): Promise<ImportResult> {
	const { rows, errors, ignored } = mapCatalogCsv(csvText);
	const stackRows = rows.filter((r) => r.stackLb != null);
	const empty: ImportResult = {
		dryRun: opts.dryRun,
		errors,
		plan: [],
		byManufacturer: new Map(),
		untouchedGlobal: 0,
		ignored,
		stackRows,
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
			const t = byManufacturer.get(m) ?? { inserted: 0, updated: 0, unchanged: 0, skipped: 0 };
			if (item.kind === 'insert') t.inserted++;
			else if (item.kind === 'update') t.updated++;
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
			stackRows,
			failed: skipped
		};
		if (opts.dryRun || skipped) return result;

		const inserts = plan.flatMap((p) => (p.kind === 'insert' ? [p.row.fields] : []));
		for (let i = 0; i < inserts.length; i += 200)
			await tx
				.insert(equipmentModels)
				.values(inserts.slice(i, i + 200).map((f) => ({ ...f, ownerUserId: null })));
		for (const p of plan) {
			if (p.kind !== 'update') continue;
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
					catalogSnapshot: f.catalogSnapshot
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
	const head = ['manufacturer', 'inserted', 'updated', 'unchanged', 'skipped'];
	const lines = [...r.byManufacturer.entries()].sort(([a], [b]) => a.localeCompare(b));
	const total = lines.reduce(
		(t, [, v]) => ({
			inserted: t.inserted + v.inserted,
			updated: t.updated + v.updated,
			unchanged: t.unchanged + v.unchanged,
			skipped: t.skipped + v.skipped
		}),
		{ inserted: 0, updated: 0, unchanged: 0, skipped: 0 }
	);
	const width = Math.max(12, ...lines.map(([m]) => m.length));
	const fmt = (cells: (string | number)[]) =>
		cells.map((c, i) => (i === 0 ? String(c).padEnd(width) : String(c).padStart(9))).join(' ');
	out.push(fmt(head));
	for (const [m, v] of lines) out.push(fmt([m, v.inserted, v.updated, v.unchanged, v.skipped]));
	out.push(fmt(['TOTAL', total.inserted, total.updated, total.unchanged, total.skipped]));
	for (const p of r.plan)
		if (p.kind === 'skipped')
			out.push(`  skipped line ${p.row.line} (${p.row.fields.manufacturer}): ${p.reason}`);
	for (const p of r.plan)
		if (p.kind === 'update')
			out.push(
				`  update line ${p.row.line} ${p.row.fields.manufacturer} ${p.row.fields.code ?? p.row.fields.name}: ${p.changed.join(', ')}`
			);
	if (r.untouchedGlobal)
		out.push(
			`${r.untouchedGlobal} existing global row(s) are not in this CSV and were left as they are.`
		);
	out.push('');
	out.push('Not imported onto the model (by design):');
	out.push(
		`  stack_lb: ${r.stackRows.length} row(s). Stack size is the gym's instance data (gym_equipment.stack_lb), not the model's:`
	);
	for (const s of r.stackRows)
		out.push(
			`    ${s.fields.manufacturer} ${s.fields.code ?? s.fields.name}: ${s.stackLb} lb${s.stackNote ? ` (${s.stackNote})` : ''}`
		);
	out.push(`  notes: ${r.ignored.notes} row(s) carry a note; notes have no column.`);
	out.push(
		`  starting_resistance_kg: ${r.ignored.startingResistanceKg} row(s); the lb value is stored, kg is derived.`
	);
	if (r.ignored.sourceNotUrl)
		out.push(
			`  (kept) source: ${r.ignored.sourceNotUrl} row(s) name their source in words, not a URL; stored as written, shown unlinked.`
		);
	if (r.failed) out.push('FAILED: skipped rows above; nothing was written.');
	return out.join('\n');
}
