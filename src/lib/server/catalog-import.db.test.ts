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
import {
	browseModels,
	instancesOfModel,
	loadModel,
	modelChoices,
	parseBrowseParams
} from './catalog';
import { createGym, createMachine, loadMachine, machineChoices } from './machines';

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

	it('imports the CSV notes onto the model (0.3.2)', async () => {
		const dry = await importCatalog(db, csv, { dryRun: true });
		const report = formatImportReport(dry);
		expect(report).toContain('(kept) notes: 298 row(s) carry a note; stored on the model');
		expect(report).not.toContain('notes have no column');
		await importCatalog(db, csv, { dryRun: false });
		const [{ n }] = await db
			.select({ n: count() })
			.from(s.equipmentModels)
			.where(isNotNull(s.equipmentModels.notes));
		expect(n).toBe(298);
		const [row] = await db
			.select()
			.from(s.equipmentModels)
			.where(
				and(
					eq(s.equipmentModels.manufacturer, 'Nautilus'),
					eq(s.equipmentModels.name, 'Leverage Row')
				)
			);
		expect(row.notes).toBe('name from training data; code unknown — verify');
	});

	it('a catalog imported before 0014 gains its notes as 298 updates, 0 inserts', async () => {
		await importCatalog(db, csv, { dryRun: false });
		// Production's state after migrating to 0014: every notes value NULL.
		await db.update(s.equipmentModels).set({ notes: null });
		const dry = await importCatalog(db, csv, { dryRun: true });
		expect(totals(dry)).toEqual({ inserted: 0, updated: 298, unchanged: 245, skipped: 0 });
		expect(
			dry.plan.filter((p) => p.kind === 'update').every((p) => p.changed.join() === 'notes')
		).toBe(true);
		await importCatalog(db, csv, { dryRun: false });
		const again = await importCatalog(db, csv, { dryRun: false });
		expect(totals(again)).toEqual({ inserted: 0, updated: 0, unchanged: 543, skipped: 0 });
	});

	it('a CSV without a notes column is refused, so notes are never wiped by omission', async () => {
		const table = parseCsv(csv);
		const at = table[0].indexOf('notes');
		const without = table.map((r) => r.filter((_, i) => i !== at).join(',')).join('\n');
		const result = await importCatalog(db, without, { dryRun: false });
		expect(result.errors).toEqual([{ line: 1, message: 'missing columns: notes' }]);
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
		// stack_lb is the model's standard stack since 0.3.2, and counted.
		expect(dry.ignored.stack).toBe(26);
		expect(report).toContain('(kept) stack_lb: 26 row(s) carry a standard stack');
		expect(report).not.toContain("Stack size is the gym's instance data");
	});

	it('maps stack_lb and stack_note onto the model as its standard stack (0.3.2)', async () => {
		await importCatalog(db, csv, { dryRun: false });
		const [mtsbc] = await db
			.select()
			.from(s.equipmentModels)
			.where(eq(s.equipmentModels.code, 'MTSBC'));
		expect(mtsbc.standardStackLb).toBe(150);
		expect(mtsbc.standardStackNote).not.toBeNull();
		const [{ n }] = await db
			.select({ n: count() })
			.from(s.equipmentModels)
			.where(isNotNull(s.equipmentModels.standardStackLb));
		expect(n).toBe(26);
		// A catalog column: a drifted standard stack is restored on the next run.
		await db
			.update(s.equipmentModels)
			.set({ standardStackLb: 999, standardStackNote: null })
			.where(eq(s.equipmentModels.id, mtsbc.id));
		const again = await importCatalog(db, csv, { dryRun: false });
		expect(again.plan.find((p) => p.kind === 'update' && p.id === mtsbc.id)).toMatchObject({
			changed: ['standardStackLb', 'standardStackNote']
		});
		const [restored] = await db
			.select()
			.from(s.equipmentModels)
			.where(eq(s.equipmentModels.id, mtsbc.id));
		expect(restored).toEqual(mtsbc);
	});

	it('the 2026-10-01 snapshot: 355 standard stacks, half pounds rounded down and reported', () => {
		const next = readFileSync('data/catalog/equipment_models_seed_2026-10-01.csv', 'utf8');
		const mapped = mapCatalogCsv(next);
		expect(mapped.errors).toEqual([]);
		expect(mapped.rows.filter((r) => r.fields.standardStackLb != null)).toHaveLength(355);
		expect(mapped.ignored).toMatchObject({ stack: 355, stackRounded: 36 });
		const oplp = mapped.rows.find((r) => r.fields.code === 'OP-LP')!;
		expect(oplp.fields.standardStackLb).toBe(262);
		expect(oplp.fields.standardStackNote).toContain('262.5 lbs');
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
		expect(report).toMatch(
			/manufacturer\s+inserted\s+updated\s+promoted\s+recoded\s+unchanged\s+skipped/
		);
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

// 0.3.2: `replaces_code`, an optional last column, recodes a row in place when
// a newer snapshot corrects a manufacturer's code (Hammer Strength IL-DY ->
// IL-DRW, line 136 of the seed).
describe('a corrected code (replaces_code)', () => {
	const LINE = 136;
	/** The seed plus an empty replaces_code column, with `edits` applied to given lines. */
	function withReplaces(edits: Record<number, { code: string; replaces: string; name?: string }>) {
		const lines = csv.trimEnd().split(/\r?\n/);
		const header = lines[0].split(',');
		return lines
			.map((l, i) => {
				if (i === 0) return `${l},replaces_code`;
				const edit = edits[i + 1];
				if (!edit) return `${l},`;
				const cells = l.split(',');
				cells[header.indexOf('model_code')] = edit.code;
				if (edit.name) cells[header.indexOf('name')] = edit.name;
				return `${cells.join(',')},${edit.replaces}`;
			})
			.join('\n');
	}
	const recoded = withReplaces({
		[LINE]: { code: 'IL-DRW', replaces: 'IL-DY', name: 'Iso-Lateral D.Y. Row (corrected)' }
	});
	const byCode = async (code: string) =>
		db
			.select()
			.from(s.equipmentModels)
			.where(
				and(
					eq(s.equipmentModels.manufacturer, 'Hammer Strength'),
					eq(s.equipmentModels.code, code),
					isNull(s.equipmentModels.ownerUserId)
				)
			);

	it('recodes the old-code row in place: same id, new code and name, link kept', async () => {
		await importCatalog(db, csv, { dryRun: false });
		const [before] = await byCode('IL-DY');
		const [gym] = await db.insert(s.gyms).values({ name: 'Gym', userId: alice }).returning();
		const [machine] = await db
			.insert(s.gymEquipment)
			.values({
				gymId: gym.id,
				localLabel: 'DY row',
				equipmentType: 'machine-plate',
				equipmentModelId: before.id
			})
			.returning();

		const dry = await importCatalog(db, recoded, { dryRun: true });
		expect(dry.byManufacturer.get('Hammer Strength')).toMatchObject({
			inserted: 0,
			recoded: 1,
			unchanged: 63
		});
		const report = formatImportReport(dry);
		expect(report).toMatch(
			/manufacturer\s+inserted\s+updated\s+promoted\s+recoded\s+unchanged\s+skipped/
		);
		expect(report).toContain(
			`recode line ${LINE} Hammer Strength IL-DY -> IL-DRW: kept in place (code, name)`
		);
		expect(await byCode('IL-DRW')).toEqual([]);

		const result = await importCatalog(db, recoded, { dryRun: false });
		expect(result.failed).toBe(false);
		expect(await globals()).toBe(543);
		expect(await byCode('IL-DY')).toEqual([]);
		const [after] = await byCode('IL-DRW');
		expect(after).toEqual({ ...before, code: 'IL-DRW', name: 'Iso-Lateral D.Y. Row (corrected)' });
		const [link] = await db.select().from(s.gymEquipment).where(eq(s.gymEquipment.id, machine.id));
		expect(link.equipmentModelId).toBe(before.id);

		const again = await importCatalog(db, recoded, { dryRun: false });
		expect(totals(again)).toEqual({ inserted: 0, updated: 0, unchanged: 543, skipped: 0 });
		expect(again.byManufacturer.get('Hammer Strength')!.recoded).toBe(0);
	});

	it('fails, writing nothing, when rows exist for both the new and the old code', async () => {
		await importCatalog(db, csv, { dryRun: false });
		const [old] = await byCode('IL-DY');
		const { id: _id, ...copy } = old;
		await db.insert(s.equipmentModels).values({ ...copy, code: 'IL-DRW' });
		const result = await importCatalog(db, recoded, { dryRun: false });
		expect(result.failed).toBe(true);
		expect(totals(result).skipped).toBe(1);
		expect(formatImportReport(result)).toContain(
			`skipped line ${LINE} (Hammer Strength): global rows exist for both IL-DRW and the code it replaces, IL-DY`
		);
		expect((await byCode('IL-DY'))[0]).toEqual(old);
	});

	it('inserts as normal when neither code exists', async () => {
		const result = await importCatalog(db, recoded, { dryRun: false });
		expect(totals(result).inserted).toBe(543);
		expect(await byCode('IL-DRW')).toHaveLength(1);
	});

	it('the 2026-09-30 CSV imports the same with an empty replaces_code column as without', async () => {
		const plain = await importCatalog(db, csv, { dryRun: true });
		const empty = await importCatalog(db, withReplaces({}), { dryRun: true });
		expect(empty.errors).toEqual([]);
		expect(empty.byManufacturer).toEqual(plain.byManufacturer);
		expect(empty.plan.map((p) => [p.kind, p.row.fields])).toEqual(
			plain.plan.map((p) => [p.kind, p.row.fields])
		);
	});

	it("never recodes, or touches, a user's own row with the old code", async () => {
		const [mine] = await db
			.insert(s.equipmentModels)
			.values({
				manufacturer: 'Hammer Strength',
				code: 'IL-DY',
				name: 'My DY row',
				loadingType: 'machine-plate',
				ownerUserId: alice
			})
			.returning();
		const first = await importCatalog(db, recoded, { dryRun: false });
		expect(first.byManufacturer.get('Hammer Strength')).toMatchObject({ inserted: 64, recoded: 0 });
		await db.delete(s.equipmentModels).where(isNull(s.equipmentModels.ownerUserId));
		await importCatalog(db, csv, { dryRun: false });
		const second = await importCatalog(db, recoded, { dryRun: false });
		expect(second.byManufacturer.get('Hammer Strength')!.recoded).toBe(1);
		const [after] = await db
			.select()
			.from(s.equipmentModels)
			.where(eq(s.equipmentModels.id, mine.id));
		expect(after).toEqual(mine);
	});

	it('refuses replaces_code without a code, equal to its own code, or replaced twice', () => {
		const bad = withReplaces({
			[LINE]: { code: '', replaces: 'IL-DY' },
			138: { code: 'IL-FLP', replaces: 'IL-FLP' },
			139: { code: 'X-1', replaces: 'OLD' },
			140: { code: 'X-2', replaces: 'OLD' }
		});
		expect(mapCatalogCsv(bad).errors).toEqual([
			{ line: LINE, message: 'replaces_code given without model_code' },
			{ line: 138, message: "replaces_code 'IL-FLP' is the row's own model_code" },
			{ line: 140, message: "replaces_code 'OLD' also replaced on line 139" }
		]);
	});

	it('fails when one CSV row recodes a row another still lists under the old code', async () => {
		await importCatalog(db, csv, { dryRun: false });
		const lines = recoded.split('\n');
		// The old IL-DY row listed again, alongside the row that replaces it.
		const oldRow = csv.trimEnd().split(/\r?\n/)[LINE - 1];
		const result = await importCatalog(db, [...lines, `${oldRow},`].join('\n'), {
			dryRun: false
		});
		expect(result.failed).toBe(true);
		expect(totals(result).skipped).toBe(2);
		expect(await byCode('IL-DRW')).toEqual([]);
	});
});

// 0.3.2: a global row the snapshot no longer contains is retired, never deleted.
describe('retiring models a snapshot no longer contains', () => {
	const LINE = 360; // Nautilus "Leverage Row", codeless
	const lines = csv.trimEnd().split(/\r?\n/);
	const without = [...lines.slice(0, LINE - 1), ...lines.slice(LINE)].join('\n');
	const leverageRow = async () =>
		(
			await db
				.select()
				.from(s.equipmentModels)
				.where(
					and(
						eq(s.equipmentModels.manufacturer, 'Nautilus'),
						eq(s.equipmentModels.name, 'Leverage Row'),
						isNull(s.equipmentModels.ownerUserId)
					)
				)
		)[0];

	it('retires it, hides it from browse and pickers, and a linked machine keeps working', async () => {
		await importCatalog(db, csv, { dryRun: false });
		const before = await leverageRow();
		const gym = await createGym(db, alice, { name: 'Gym' });
		const machine = await createMachine(db, alice, {
			gymId: gym.id,
			localLabel: 'Next to deadlift platform',
			equipmentType: 'machine-plate',
			equipmentModelId: before.id
		});

		const dry = await importCatalog(db, without, { dryRun: true });
		expect(dry.byManufacturer.get('Nautilus')).toMatchObject({ retired: 1, unchanged: 42 });
		expect(dry.retired.map((r) => r.id)).toEqual([before.id]);
		const report = formatImportReport(dry);
		expect(report).toMatch(
			/inserted\s+updated\s+promoted\s+recoded\s+unchanged\s+skipped\s+retired/
		);
		expect(report).toContain(
			'retire Nautilus Leverage Row [Leverage (plate loaded)]: not in this snapshot'
		);
		expect(report).not.toContain('were left as they are');
		expect((await leverageRow()).retiredAt).toBeNull(); // dry run wrote nothing

		const run = await importCatalog(db, without, { dryRun: false });
		expect(run.failed).toBe(false);
		const after = await leverageRow();
		expect(after.retiredAt).toBeInstanceOf(Date);
		expect(after).toEqual({ ...before, retiredAt: after.retiredAt }); // nothing else moved
		expect(await globals()).toBe(543); // nothing deleted

		// Hidden from browse, search and the add-machine picker...
		const browse = await browseModels(
			db,
			alice,
			parseBrowseParams(new URLSearchParams('q=Leverage Row'))
		);
		expect(browse.rows.map((r) => r.id)).not.toContain(before.id);
		expect(browse.total).toBe(0);
		const picker = await modelChoices(db, alice, { all: true });
		expect(picker.models).toHaveLength(542);
		expect(picker.models.map((m) => m.id)).not.toContain(before.id);
		// ...and not offered for a new machine.
		await expect(
			createMachine(db, alice, {
				gymId: gym.id,
				localLabel: 'Second row',
				equipmentType: 'machine-plate',
				equipmentModelId: before.id
			})
		).rejects.toThrow();
		// But its page and the machine linked to it still read it.
		expect((await loadModel(db, alice, before.id))?.id).toBe(before.id);
		expect(await instancesOfModel(db, alice, before.id)).toHaveLength(1);
		expect((await loadMachine(db, alice, gym.id, machine.id))?.model?.id).toBe(before.id);
		expect((await machineChoices(db, alice)).machines.map((m) => m.id)).toEqual([machine.id]);
		const [link] = await db.select().from(s.gymEquipment).where(eq(s.gymEquipment.id, machine.id));
		expect(link.equipmentModelId).toBe(before.id);

		// Idempotent: a second run retires nothing more and keeps the first date.
		const again = await importCatalog(db, without, { dryRun: false });
		expect(again.retired).toEqual([]);
		expect(totals(again)).toEqual({ inserted: 0, updated: 0, unchanged: 542, skipped: 0 });
		expect((await leverageRow()).retiredAt).toEqual(after.retiredAt);
	});

	it('a snapshot that lists it again un-retires it', async () => {
		await importCatalog(db, csv, { dryRun: false });
		await importCatalog(db, without, { dryRun: false });
		const retired = await leverageRow();
		expect(retired.retiredAt).not.toBeNull();
		const back = await importCatalog(db, csv, { dryRun: false });
		expect(back.plan.find((p) => 'id' in p && p.id === retired.id)).toMatchObject({
			kind: 'update',
			changed: ['retiredAt']
		});
		expect((await leverageRow()).retiredAt).toBeNull();
		const browse = await browseModels(
			db,
			alice,
			parseBrowseParams(new URLSearchParams('q=Leverage Row'))
		);
		expect(browse.rows.map((r) => r.id)).toContain(retired.id);
		const third = await importCatalog(db, csv, { dryRun: false });
		expect(totals(third)).toEqual({ inserted: 0, updated: 0, unchanged: 543, skipped: 0 });
		expect(third.retired).toEqual([]);
	});

	it('never retires an owned row, and an owned row stays listed for its owner', async () => {
		const [mine] = await db
			.insert(s.equipmentModels)
			.values({
				manufacturer: 'Nautilus',
				name: 'My own row',
				loadingType: 'machine-plate',
				ownerUserId: alice
			})
			.returning();
		const result = await importCatalog(db, csv, { dryRun: false });
		expect(result.retired.map((r) => r.id)).not.toContain(mine.id);
		await importCatalog(db, without, { dryRun: false });
		const [after] = await db
			.select()
			.from(s.equipmentModels)
			.where(eq(s.equipmentModels.id, mine.id));
		expect(after).toEqual(mine);
		const listed = await browseModels(
			db,
			alice,
			parseBrowseParams(new URLSearchParams('q=My own row'))
		);
		expect(listed.rows.map((r) => r.id)).toEqual([mine.id]);
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
