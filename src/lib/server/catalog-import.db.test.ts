/**
 * The catalog importer against the real seed CSV (spec A2).
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, count, eq, isNotNull, isNull } from 'drizzle-orm';
import { setupTestDb, resetTestDbWithUsers, type TestDb } from './test-db';
import * as s from './db/schema';
import { formatImportReport, importCatalog, mapCatalogCsv, parseCsv } from './catalog-import';

const CSV_PATH = 'data/catalog/equipment_models_seed_2026-09-30.csv';
const csv = readFileSync(CSV_PATH, 'utf8');

let db: TestDb;
let handle: Awaited<ReturnType<typeof setupTestDb>>;
let alice: string;
beforeAll(async () => {
	handle = await setupTestDb();
	db = handle.db;
});
afterAll(async () => {
	await handle?.end();
});
beforeEach(async () => {
	[{ id: alice }] = await resetTestDbWithUsers(db, handle.client, 1, 'catalog-import');
});

const globals = async () =>
	(
		await db
			.select({ n: count() })
			.from(s.equipmentModels)
			.where(isNull(s.equipmentModels.ownerUserId))
	)[0].n;
const owned = async () =>
	(
		await db
			.select({ n: count() })
			.from(s.equipmentModels)
			.where(isNotNull(s.equipmentModels.ownerUserId))
	)[0].n;
const totals = (r: Awaited<ReturnType<typeof importCatalog>>) =>
	[...r.byManufacturer.values()].reduce(
		(t, v) => ({
			inserted: t.inserted + v.inserted,
			updated: t.updated + v.updated,
			unchanged: t.unchanged + v.unchanged,
			skipped: t.skipped + v.skipped
		}),
		{ inserted: 0, updated: 0, unchanged: 0, skipped: 0 }
	);
/** The real CSV with one cell replaced, by header name, on the first data row. */
function withCell(column: string, value: string, line = 2) {
	const rows = csv.split('\n');
	const header = rows[0].split(',');
	const cells = rows[line - 1].split(',');
	cells[header.indexOf(column)] = value;
	rows[line - 1] = cells.join(',');
	return rows.join('\n');
}

describe('catalog import of the 2026-09-30 seed', () => {
	it('imports 543 global rows and no owned ones, per manufacturer', async () => {
		const result = await importCatalog(db, csv, { dryRun: false });
		expect(result.errors).toEqual([]);
		expect(result.failed).toBe(false);
		expect(await globals()).toBe(543);
		expect(await owned()).toBe(0);
		expect(Object.fromEntries([...result.byManufacturer].map(([m, t]) => [m, t.inserted]))).toEqual(
			{
				gym80: 128,
				Matrix: 83,
				Precor: 66,
				'Hammer Strength': 64,
				Technogym: 62,
				'Life Fitness': 61,
				Nautilus: 43,
				Cybex: 36
			}
		);
		// Mapping, read back from the database.
		const [row] = await db
			.select()
			.from(s.equipmentModels)
			.where(
				and(
					eq(s.equipmentModels.manufacturer, 'Hammer Strength'),
					eq(s.equipmentModels.code, 'IL-ROW')
				)
			);
		expect(row).toMatchObject({
			name: 'Iso-Lateral Row',
			loadingType: 'machine-plate',
			startingResistance: 12,
			startingResistanceBasis: 'per_arm',
			catalogSnapshot: '2026-09-30',
			ownerUserId: null
		});
		const byType = await db
			.select({ t: s.equipmentModels.loadingType, n: count() })
			.from(s.equipmentModels)
			.groupBy(s.equipmentModels.loadingType);
		expect(Object.fromEntries(byType.map((r) => [r.t, r.n]))).toEqual({
			'machine-stack': 355,
			'machine-plate': 180,
			cable: 8
		});
	});

	it('is idempotent: the second run changes nothing', async () => {
		await importCatalog(db, csv, { dryRun: false });
		const second = await importCatalog(db, csv, { dryRun: false });
		expect(totals(second)).toEqual({ inserted: 0, updated: 0, unchanged: 543, skipped: 0 });
		expect(await globals()).toBe(543);
	});

	it('a dry run writes nothing but reports the same plan', async () => {
		const dry = await importCatalog(db, csv, { dryRun: true });
		expect(totals(dry).inserted).toBe(543);
		expect(await globals()).toBe(0);
		const report = formatImportReport(dry);
		expect(report).toContain('DRY RUN');
		// stack_lb is not imported, but nothing is silently dropped.
		expect(dry.stackRows).toHaveLength(26);
		expect(report).toContain('stack_lb: 26 row(s)');
	});

	it('restores a drifted catalog row, and only the catalog columns', async () => {
		await importCatalog(db, csv, { dryRun: false });
		await db
			.update(s.equipmentModels)
			.set({ name: 'Drifted', startingResistance: 99 })
			.where(
				and(
					eq(s.equipmentModels.manufacturer, 'Hammer Strength'),
					eq(s.equipmentModels.code, 'IL-ROW')
				)
			);
		const again = await importCatalog(db, csv, { dryRun: false });
		expect(totals(again)).toMatchObject({ inserted: 0, updated: 1, unchanged: 542 });
		const [row] = await db
			.select()
			.from(s.equipmentModels)
			.where(eq(s.equipmentModels.code, 'IL-ROW'));
		expect(row).toMatchObject({ name: 'Iso-Lateral Row', startingResistance: 12 });
	});

	it("never touches a user's own row with the same manufacturer and code", async () => {
		const [mine] = await db
			.insert(s.equipmentModels)
			.values({
				manufacturer: 'Hammer Strength',
				code: 'IL-ROW',
				name: 'My row, my numbers',
				loadingType: 'machine-plate',
				startingResistance: 20,
				startingResistanceBasis: 'total',
				ownerUserId: alice
			})
			.returning();
		const result = await importCatalog(db, csv, { dryRun: false });
		expect(totals(result)).toMatchObject({ inserted: 543, updated: 0 });
		const [after] = await db
			.select()
			.from(s.equipmentModels)
			.where(eq(s.equipmentModels.id, mine.id));
		expect(after).toEqual(mine);
		expect(await owned()).toBe(1);
		expect(await globals()).toBe(543);
	});

	it('an unknown loading_type fails the whole run and writes nothing', async () => {
		const bad = withCell('loading_type', 'hydraulic');
		const result = await importCatalog(db, bad, { dryRun: false });
		expect(result.failed).toBe(true);
		expect(result.errors).toEqual([{ line: 2, message: "unknown loading_type 'hydraulic'" }]);
		expect(await globals()).toBe(0);
		expect(formatImportReport(result)).toContain('REFUSED');
	});

	it('refuses a row whose key repeats within the file', async () => {
		const lines = csv.trimEnd().split('\n');
		const dup = [...lines, lines[1]].join('\n');
		const result = await importCatalog(db, dup, { dryRun: false });
		expect(result.errors).toEqual([
			{ line: 545, message: 'duplicate of line 2 (same import key)' }
		]);
		expect(await globals()).toBe(0);
	});

	it('skips, and fails on, a codeless row matching two existing globals', async () => {
		await importCatalog(db, csv, { dryRun: false });
		const [codeless] = await db
			.select()
			.from(s.equipmentModels)
			.where(and(isNull(s.equipmentModels.code), isNull(s.equipmentModels.ownerUserId)))
			.limit(1);
		const { id: _id, ...copy } = codeless;
		await db.insert(s.equipmentModels).values(copy);
		const result = await importCatalog(db, csv, { dryRun: false });
		expect(result.failed).toBe(true);
		expect(totals(result).skipped).toBe(1);
	});

	it('the CLI exits non-zero on an unmappable row', () => {
		const dir = mkdtempSync(join(tmpdir(), 'catalog-'));
		const file = join(dir, 'bad.csv');
		writeFileSync(file, withCell('confidence', 'vibes'));
		const run = spawnSync('pnpm', ['exec', 'tsx', 'scripts/catalog-import.ts', file], {
			env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL },
			encoding: 'utf8'
		});
		expect(run.stdout).toContain("unknown confidence 'vibes'");
		expect(run.status).toBe(1);
	});
});

// 0.3.2: a snapshot that adds a code to a codeless model updates that row in
// place. Production's first machine points at Nautilus "Leverage Row" (line
// 360 of the seed, codeless); TEST-ROW is a made-up code for the test.
describe('a code added to a codeless model (promotion)', () => {
	const LINE = 360;
	const coded = withCell('model_code', 'TEST-ROW', LINE);
	const leverageRow = async () =>
		db
			.select()
			.from(s.equipmentModels)
			.where(
				and(
					eq(s.equipmentModels.manufacturer, 'Nautilus'),
					eq(s.equipmentModels.name, 'Leverage Row'),
					isNull(s.equipmentModels.ownerUserId)
				)
			);

	it('updates the same row in place, keeps its gym_equipment link, and reports it', async () => {
		await importCatalog(db, csv, { dryRun: false });
		const [before] = await leverageRow();
		expect(before.code).toBeNull();
		const [gym] = await db.insert(s.gyms).values({ name: 'Gym', userId: alice }).returning();
		const [machine] = await db
			.insert(s.gymEquipment)
			.values({
				gymId: gym.id,
				localLabel: 'Next to deadlift platform',
				equipmentType: 'machine-plate',
				equipmentModelId: before.id
			})
			.returning();

		const dry = await importCatalog(db, coded, { dryRun: true });
		expect(totals(dry)).toEqual({ inserted: 0, updated: 0, unchanged: 542, skipped: 0 });
		expect(dry.byManufacturer.get('Nautilus')).toMatchObject({ promoted: 1, inserted: 0 });
		const report = formatImportReport(dry);
		expect(report).toMatch(/manufacturer\s+inserted\s+updated\s+promoted\s+unchanged\s+skipped/);
		expect(report).toContain(
			`promote line ${LINE} Nautilus Leverage Row: codeless row gains code TEST-ROW, kept in place (code)`
		);
		expect((await leverageRow())[0].code).toBeNull(); // dry run wrote nothing

		const result = await importCatalog(db, coded, { dryRun: false });
		expect(result.failed).toBe(false);
		expect(await globals()).toBe(543);
		const after = await leverageRow();
		expect(after).toHaveLength(1);
		expect(after[0]).toEqual({ ...before, code: 'TEST-ROW' });
		const [link] = await db.select().from(s.gymEquipment).where(eq(s.gymEquipment.id, machine.id));
		expect(link.equipmentModelId).toBe(before.id);

		// Idempotent afterwards: the row now matches on (manufacturer, code).
		const again = await importCatalog(db, coded, { dryRun: false });
		expect(totals(again)).toEqual({ inserted: 0, updated: 0, unchanged: 543, skipped: 0 });
		expect(again.byManufacturer.get('Nautilus')!.promoted).toBe(0);
	});

	it('fails, writing nothing, when two codeless global rows share the line and name', async () => {
		await importCatalog(db, csv, { dryRun: false });
		const [codeless] = await leverageRow();
		const { id: _id, ...copy } = codeless;
		await db.insert(s.equipmentModels).values(copy);
		const result = await importCatalog(db, coded, { dryRun: false });
		expect(result.failed).toBe(true);
		expect(totals(result).skipped).toBe(1);
		expect(formatImportReport(result)).toContain(
			`skipped line ${LINE} (Nautilus): adds a code to 2 existing codeless global rows`
		);
		expect((await leverageRow()).map((r) => r.code)).toEqual([null, null]);
		expect(await globals()).toBe(544);

		// And the CLI exits non-zero on it.
		const dir = mkdtempSync(join(tmpdir(), 'catalog-'));
		const file = join(dir, 'ambiguous.csv');
		writeFileSync(file, coded);
		const run = spawnSync('pnpm', ['exec', 'tsx', 'scripts/catalog-import.ts', file], {
			env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL },
			encoding: 'utf8'
		});
		expect(run.stdout).toContain('FAILED');
		expect(run.status).toBe(1);
	});

	it('fails when two coded CSV rows would promote the same codeless row', async () => {
		await importCatalog(db, csv, { dryRun: false });
		const lines = coded.trimEnd().split('\n');
		const twin = lines[LINE - 1].replace('TEST-ROW', 'TEST-ROW-2');
		const result = await importCatalog(db, [...lines, twin].join('\n'), { dryRun: false });
		expect(result.failed).toBe(true);
		expect(totals(result).skipped).toBe(2);
		expect((await leverageRow()).map((r) => r.code)).toEqual([null]);
	});

	it("never promotes, or touches, a user's own codeless row", async () => {
		const [mine] = await db
			.insert(s.equipmentModels)
			.values({
				manufacturer: 'Nautilus',
				productLine: 'Leverage (plate loaded)',
				name: 'Leverage Row',
				loadingType: 'machine-plate',
				ownerUserId: alice
			})
			.returning();
		// No global row yet: the coded row is an insert, not a promotion of mine.
		const first = await importCatalog(db, coded, { dryRun: false });
		expect(totals(first).inserted).toBe(543);
		expect(first.byManufacturer.get('Nautilus')!.promoted).toBe(0);
		// A global codeless row beside mine: the global one is promoted, mine is not.
		await db.delete(s.equipmentModels).where(isNull(s.equipmentModels.ownerUserId));
		await importCatalog(db, csv, { dryRun: false });
		const second = await importCatalog(db, coded, { dryRun: false });
		expect(second.byManufacturer.get('Nautilus')!.promoted).toBe(1);
		const [after] = await db
			.select()
			.from(s.equipmentModels)
			.where(eq(s.equipmentModels.id, mine.id));
		expect(after).toEqual(mine);
		expect(await owned()).toBe(1);
	});
});

describe('parseCsv', () => {
	it('handles quoted commas, doubled quotes, embedded newlines and CRLF', () => {
		expect(parseCsv('a,b\r\n"x, y","say ""hi"""\n"multi\nline",z\n')).toEqual([
			['a', 'b'],
			['x, y', 'say "hi"'],
			['multi\nline', 'z']
		]);
	});

	it('the seed parses to 543 rows of 16 fields each', () => {
		const table = parseCsv(csv);
		expect(table).toHaveLength(544);
		expect(table.every((r) => r.length === 16)).toBe(true);
		expect(mapCatalogCsv(csv).rows).toHaveLength(543);
	});
});
