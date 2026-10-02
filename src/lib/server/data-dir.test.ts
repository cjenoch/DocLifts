import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { dataDir } from './data-dir';

const dir = mkdtempSync(join(tmpdir(), 'data-dir-'));
writeFileSync(join(dir, 'file.txt'), 'x');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('dataDir (DOCLIFTS_DATA_DIR)', () => {
	it('is null when unset or empty: callers skip', () => {
		expect(dataDir({})).toBeNull();
		expect(dataDir({ DOCLIFTS_DATA_DIR: '' })).toBeNull();
	});

	it('returns an existing absolute directory', () => {
		expect(dataDir({ DOCLIFTS_DATA_DIR: dir })).toBe(dir);
	});

	it('throws when set but wrong, so a typo is not read as "no data"', () => {
		expect(() => dataDir({ DOCLIFTS_DATA_DIR: 'relative/dir' })).toThrow(/absolute/);
		expect(() => dataDir({ DOCLIFTS_DATA_DIR: join(dir, 'missing') })).toThrow(/does not exist/);
		expect(() => dataDir({ DOCLIFTS_DATA_DIR: join(dir, 'file.txt') })).toThrow(/not a directory/);
	});
});
