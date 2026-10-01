/**
 * matchCandidate (0.4.0 §5/§7): exact, prefix (owner addition), name, none —
 * and the visibility rule: a user's own model matches for them and is
 * invisible to anyone else.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setupTestDb, resetTestDbWithUsers, type TestDb } from '../test-db';
import * as s from '../db/schema';
import { isPrefixMatch, matchCandidate, nameTokens, normalizeCode } from './match';

let db: TestDb;
let handle: Awaited<ReturnType<typeof setupTestDb>>;
let alice: string;
let bob: string;

beforeAll(async () => {
	handle = await setupTestDb();
	db = handle.db;
});
afterAll(async () => {
	await handle?.end();
});

type Model = typeof s.equipmentModels.$inferSelect;
const models: Record<string, Model> = {};
async function model(
	key: string,
	v: { manufacturer: string; name: string; code?: string | null; owner?: string }
) {
	const [row] = await db
		.insert(s.equipmentModels)
		.values({
			manufacturer: v.manufacturer,
			name: v.name,
			code: v.code ?? null,
			loadingType: 'machine-plate',
			confidence: v.owner ? 'user' : 'manufacturer_page',
			ownerUserId: v.owner ?? null
		})
		.returning();
	models[key] = row;
}

beforeEach(async () => {
	[{ id: alice }, { id: bob }] = await resetTestDbWithUsers(db, handle.client, 2, 'match');
	await model('ilRow', {
		manufacturer: 'Hammer Strength',
		name: 'Iso-Lateral Row',
		code: 'IL-ROW'
	});
	await model('ilHighRow', {
		manufacturer: 'Hammer Strength',
		name: 'Iso-Lateral High Row',
		code: 'IL-HR'
	});
	await model('ilHbp', {
		manufacturer: 'Hammer Strength',
		name: 'Iso-Lateral Bench Press',
		code: 'IL-HBP'
	});
	await model('mb20', { manufacturer: 'Technogym', name: 'Pure Chest Press', code: 'MB20' });
	await model('mb21', { manufacturer: 'Technogym', name: 'Pure Shoulder Press', code: 'MB21' });
	await model('mg3000', { manufacturer: 'Technogym', name: 'Pure Leg Press', code: 'MG3000' });
	await model('mg3000a', { manufacturer: 'Technogym', name: 'Pure Leg Press A', code: 'MG3000-A' });
	await model('nlRow', { manufacturer: 'Nautilus', name: 'Leverage Row', code: '9NP-L3004' });
	await model('nlChest', {
		manufacturer: 'Nautilus',
		name: 'Leverage Chest Press',
		code: '9NP-L2002'
	});
	await model('alicesPress', {
		manufacturer: 'Garage Iron',
		name: 'Hip Thrust Station',
		code: 'GI-HT1',
		owner: alice
	});
});

const ids = (r: { matches: Model[] }) => r.matches.map((m) => m.id);

describe('normalization helpers', () => {
	it('ignores case, whitespace and hyphens', () => {
		expect(normalizeCode('IL ROW')).toBe(normalizeCode('il-row'));
		expect(normalizeCode(' MB200N0-ANV0GGGP ')).toBe('mb200n0anv0gggp');
	});
	it('a prefix needs at least 4 characters on the shorter side', () => {
		expect(isPrefixMatch('mb20', 'mb200n0anv0gggp')).toBe(true);
		expect(isPrefixMatch('mb200n0anv0gggp', 'mb20')).toBe(true);
		expect(isPrefixMatch('mb2', 'mb200')).toBe(false);
		expect(isPrefixMatch('9npl3004', 'npl3004')).toBe(false);
	});
	it('name tokens are 3+ alphanumerics, lowercased', () => {
		expect(nameTokens('Iso-Lateral Row')).toEqual(['iso', 'lateral', 'row']);
		expect(nameTokens('A 45° Leg')).toEqual(['leg']);
	});
});

describe('matchCandidate', () => {
	it('exact: manufacturer and code, case/whitespace/hyphen-insensitive, preselected', async () => {
		const r = await matchCandidate(db, alice, {
			manufacturer: 'HAMMER STRENGTH',
			model_code: 'IL ROW',
			name: 'Iso-Lateral High Row' // a name that would match something else
		});
		expect(r).toMatchObject({ method: 'exact', preselectedId: models.ilRow.id });
		expect(ids(r)).toEqual([models.ilRow.id]);
	});

	it('an exact code match wins over the name', async () => {
		const r = await matchCandidate(db, alice, {
			manufacturer: 'Hammer Strength',
			model_code: 'il-hbp',
			name: 'Iso Lateral Row'
		});
		expect(r.method).toBe('exact');
		expect(r.preselectedId).toBe(models.ilHbp.id);
	});

	it('prefix (Technogym): base code MB20 matches placard SKU MB200N0-ANV0GGGP, preselected', async () => {
		const r = await matchCandidate(db, alice, {
			manufacturer: 'Technogym',
			model_code: 'MB200N0-ANV0GGGP',
			name: null
		});
		expect(r).toMatchObject({ method: 'prefix', preselectedId: models.mb20.id });
		expect(ids(r)).toEqual([models.mb20.id]);
	});

	it('prefix with several matches: all shown, none preselected', async () => {
		// MG3000-NBGJV0 normalizes to mg3000nbgjv0: MG3000 is a prefix of it,
		// MG3000-A (mg3000a) is not. A placard reading just "MG300 0" would hit both.
		const one = await matchCandidate(db, alice, {
			manufacturer: 'Technogym',
			model_code: 'MG3000-NBGJV0',
			name: null
		});
		expect(one).toMatchObject({ method: 'prefix', preselectedId: models.mg3000.id });
		const several = await matchCandidate(db, alice, {
			manufacturer: 'Technogym',
			model_code: 'MG30',
			name: null
		});
		expect(several.method).toBe('prefix');
		expect(several.preselectedId).toBeNull();
		expect(ids(several).sort()).toEqual([models.mg3000.id, models.mg3000a.id].sort());
	});

	it('prefix stays within the manufacturer', async () => {
		const r = await matchCandidate(db, alice, {
			manufacturer: 'Hammer Strength',
			model_code: 'MB200N0',
			name: null
		});
		expect(r.method).toBe('none');
	});

	it('Nautilus 9NP-L3004 vs placard NP-L3004 is NOT a prefix match; the name step finds it', async () => {
		const r = await matchCandidate(db, alice, {
			manufacturer: 'Nautilus',
			model_code: 'NP-L3004',
			name: 'Leverage Row'
		});
		expect(r.method).toBe('name');
		expect(r.preselectedId).toBeNull();
		expect(ids(r)[0]).toBe(models.nlRow.id);
		// Without a name there is nothing to fall back to.
		const codeOnly = await matchCandidate(db, alice, {
			manufacturer: 'Nautilus',
			model_code: 'NP-L3004',
			name: null
		});
		expect(codeOnly.method).toBe('none');
	});

	it('name fallback ranks Iso-Lateral Row above Iso-Lateral High Row for "Iso Lateral Row"', async () => {
		const r = await matchCandidate(db, alice, {
			manufacturer: 'Hammer Strength',
			model_code: null,
			name: 'Iso Lateral Row'
		});
		expect(r.method).toBe('name');
		expect(r.preselectedId).toBeNull();
		expect(ids(r).slice(0, 3)).toEqual([
			models.ilRow.id,
			models.ilHighRow.id,
			models.ilHbp.id // two of three tokens
		]);
	});

	it('name matching stays within a known manufacturer, and searches all for an unknown one', async () => {
		const within = await matchCandidate(db, alice, {
			manufacturer: 'Nautilus',
			model_code: null,
			name: 'Chest Press'
		});
		expect(ids(within)).toEqual([models.nlChest.id]);
		const all = await matchCandidate(db, alice, {
			manufacturer: 'Unknown Maker',
			model_code: null,
			name: 'Chest Press'
		});
		// Both "Chest Press" rows (2 tokens) lead, from two manufacturers; then 1-token rows.
		expect(ids(all).slice(0, 2).sort()).toEqual([models.mb20.id, models.nlChest.id].sort());
		expect(ids(all)).toHaveLength(5);
	});

	it('nothing: no code match and no usable name', async () => {
		expect(
			await matchCandidate(db, alice, { manufacturer: null, model_code: null, name: 'XY' })
		).toEqual({ method: 'none', preselectedId: null, matches: [] });
	});

	it('a user’s own model is matched for them, and invisible to another user', async () => {
		const candidate = { manufacturer: 'Garage Iron', model_code: 'GI HT1', name: 'Hip Thrust' };
		const mine = await matchCandidate(db, alice, candidate);
		expect(mine).toMatchObject({ method: 'exact', preselectedId: models.alicesPress.id });
		const theirs = await matchCandidate(db, bob, candidate);
		expect(theirs).toEqual({ method: 'none', preselectedId: null, matches: [] });
	});

	it('an owned copy beside the catalog row: both shown, the owned one preselected', async () => {
		await model('aliceCopy', {
			manufacturer: 'Hammer Strength',
			name: 'Iso-Lateral Row',
			code: 'IL-ROW',
			owner: alice
		});
		const r = await matchCandidate(db, alice, {
			manufacturer: 'Hammer Strength',
			model_code: 'IL-ROW',
			name: null
		});
		expect(r.method).toBe('exact');
		expect(ids(r)).toEqual([models.aliceCopy.id, models.ilRow.id]);
		expect(r.preselectedId).toBe(models.aliceCopy.id);
		// Bob sees only the catalog row.
		const bobs = await matchCandidate(db, bob, {
			manufacturer: 'Hammer Strength',
			model_code: 'IL-ROW',
			name: null
		});
		expect(ids(bobs)).toEqual([models.ilRow.id]);
	});
});
