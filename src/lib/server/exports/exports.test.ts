import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { eq } from 'drizzle-orm';
import { setupTestDb, resetTestDbWithUsers } from '../test-db';
import * as s from '../db/schema';
import {
	readAccountExport,
	hasExportSession,
	ExportAccessError,
	MAX_EXPORT_BYTES,
	ExportLimitError
} from './data';
import { csvCell, jsonArchive, spreadsheetArchive, strongCsv, workoutRows } from './formats';
import { createExportGate } from './admission';
import { seedExportFixture } from './test-fixtures';

describe('account export isolation and fidelity', () => {
	let h: Awaited<ReturnType<typeof setupTestDb>>;
	let alice: string, bob: string;
	beforeAll(async () => {
		h = await setupTestDb();
	});
	afterAll(async () => {
		await h?.end();
	});
	beforeEach(async () => {
		const users = await resetTestDbWithUsers(h.db, h.client, 2);
		[alice, bob] = users.map((x) => x.id);
	});
	it('exports the entire owned graph, including incomplete/trash/imported records, without auth secrets or another owner', async () => {
		const a = await seedExportFixture(h.db, alice, 'ALICE', 100);
		const b = await seedExportFixture(h.db, bob, 'BOB', 200);
		const sessionId = crypto.randomUUID();
		await h.db.insert(s.authSessions).values({
			id: sessionId,
			userId: alice,
			token: 'never-export-this-token',
			expiresAt: new Date(Date.now() + 60000)
		});
		const mine = await readAccountExport(h.db, alice);
		for (const [name, rows] of Object.entries(mine)) expect(rows.length, name).toBeGreaterThan(0);
		expect(mine.sessions).toHaveLength(4);
		expect(mine.sets).toHaveLength(6);
		expect(mine.sets.find((x) => x.id === a.logged.id)).toMatchObject({
			prescribedLoad: 999,
			executedLoad: 100,
			executedRir: 1,
			loadConvention: 'plates_per_side'
		});
		expect(mine.importedWorkouts[0]).toMatchObject({
			workoutDate: null,
			earliestDate: '2020-01-01',
			latestDate: '2020-01-31'
		});
		expect(mine.importedWorkouts[0].lines[0].sets[0].evidence).toBe('user_authorized_estimate');
		expect(mine.equipmentModels.map((x) => x.id).sort()).toEqual([a.model.id, a.global.id].sort());
		const encoded = JSON.stringify(jsonArchive(mine));
		for (const forbidden of [
			'BOB',
			b.logged.id,
			b.photo.id,
			'never-export-this-token',
			'private-object-ALICE',
			'password',
			'authSessions'
		]) {
			// The dictionary describes password exclusion; actual exported fields/records must not contain it.
			if (forbidden === 'password') expect(JSON.stringify(mine)).not.toContain(forbidden);
			else expect(encoded).not.toContain(forbidden);
		}
		const theirs = await readAccountExport(h.db, bob);
		expect(theirs.sets.find((x) => x.id === b.logged.id)?.executedLoad).toBe(200);
		expect(JSON.stringify(theirs)).not.toContain('ALICE');
		expect(await hasExportSession(h.db, alice, sessionId)).toBe(true);
		expect(await hasExportSession(h.db, bob, sessionId)).toBe(false);
		await h.db.delete(s.authSessions).where(eq(s.authSessions.id, sessionId));
		expect(await hasExportSession(h.db, alice, sessionId)).toBe(false);
		expect((await h.db.select().from(s.sets)).length).toBe(12);
		await h.db
			.update(s.authUsers)
			.set({ deletionRequestedAt: new Date() })
			.where(eq(s.authUsers.id, alice));
		await expect(readAccountExport(h.db, alice)).rejects.toBeInstanceOf(ExportAccessError);
	});
	it('keeps exact JSON text and produces readable tables with protected cells, notes, zero and uncertain notebook sets', async () => {
		await seedExportFixture(h.db, alice, 'ALICE');
		const data = await readAccountExport(h.db, alice);
		const files = unzipSync(spreadsheetArchive(data));
		const table = strFromU8(files['workout_sets.csv']);
		expect(table).toContain('"\'=1+1, ""quoted""\nALICE"');
		expect(table).toContain('ALICE historical name');
		expect(table).toContain('"999"');
		expect(table).toContain('"100"');
		const notebook = strFromU8(files['notebook_sets.csv']);
		expect(notebook).toContain('user_authorized_estimate');
		expect(notebook).toContain('Unstructured note');
		expect(notebook).toContain('2020-01-31');
		expect(JSON.parse(strFromU8(files['manifest.json'])).counts.sets).toBe(6);
		expect(data.sets.some((x) => x.notes?.startsWith('=1+1'))).toBe(true);
		for (const value of ['=1+1', ' +SUM(A1:A2)', '\t@SUM(A1)', '\nplain', '－1'])
			expect(csvCell(value).startsWith('"\'')).toBe(true);
		expect(csvCell(0)).toBe('"0"');
		expect(csvCell(null)).toBe('""');
		expect(csvCell(-1)).toBe('"-1"');
		const empty = await readAccountExport(h.db, bob);
		expect(strFromU8(unzipSync(spreadsheetArchive(empty))['sets.csv'])).toContain('"executedLoad"');
	});
	it('adapts only entered completed sets, keeps per-side basis and RIR, converts pounds once and separates timed work', async () => {
		const fixture = await seedExportFixture(h.db, alice, 'ALICE');
		const data = await readAccountExport(h.db, alice);
		const csv = strongCsv(data, 'America/New_York');
		expect(csv).toContain(
			'"Date","Workout Name","Duration","Exercise Name","Set Order","Weight","Reps","Distance","Seconds","Notes","Workout Notes","RPE"'
		);
		expect(csv).toContain('"2026-06-09 21:30:00"');
		expect(csv).toContain('"45.359237","5","",""');
		expect(csv).toContain('"0","","","30"');
		expect(csv).toContain('[plates_per_side]');
		expect(csv).toContain('RIR 1 (not converted to RPE)');
		expect(csv).toContain('"31m 30s"');
		expect(csv).not.toContain('"999"');
		for (const id of [fixture.open.id, fixture.trash.id, fixture.empty.id])
			expect(csv).not.toContain(id);
		expect(csv).not.toContain('notebook');
		expect(workoutRows(data)).toHaveLength(6);
	});
	it('rejects an oversized archive rather than returning a truncated file and releases bounded export slots', async () => {
		const [program] = await h.db
			.insert(s.programs)
			.values({ userId: alice, name: 'large', description: 'x'.repeat(MAX_EXPORT_BYTES) })
			.returning({ id: s.programs.id });
		await expect(readAccountExport(h.db, alice)).rejects.toBeInstanceOf(ExportLimitError);
		await h.db.delete(s.programs).where(eq(s.programs.id, program.id));
		const enter = createExportGate();
		const leave = enter(alice)!;
		expect(enter(alice)).toBeNull();
		const leaveB = enter(bob)!;
		expect(enter('third')).toBeNull();
		leave();
		leaveB();
		expect(enter('third')).toBeTypeOf('function');
	});
});
