/**
 * Checks on the private data directory (docs/private-data.md). Skipped when
 * DOCLIFTS_DATA_DIR is unset, as in public CI; run where the data is with
 * `DOCLIFTS_DATA_DIR=… pnpm run test:unit --project server private-data`.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mapCatalogCsv, parseCsv } from './catalog-import';
import { dataDir } from './data-dir';

const dir = dataDir();

describe.skipIf(!dir)('private data directory', () => {
	const root = dir as string;

	it('every catalog snapshot is dated and maps with no row errors', () => {
		const snapDir = join(root, 'catalog', 'snapshots');
		const files = readdirSync(snapDir).filter((f) => f.endsWith('.csv'));
		expect(files.length).toBeGreaterThan(0);
		for (const f of files) {
			expect(f).toMatch(/^equipment_models_seed_\d{4}-\d{2}-\d{2}[a-z]?\.csv$/);
			const { errors } = mapCatalogCsv(readFileSync(join(snapDir, f), 'utf8'));
			expect(errors, f).toEqual([]);
		}
	});

	it('the hard-photo manifest names each photo by a unique id, a sha256 and a private bucket key', () => {
		const [header, ...rows] = parseCsv(readFileSync(join(root, 'hard-photos', 'manifest.csv'), 'utf8'));
		expect(header).toEqual(['id', 'sha256', 'bucket_key', 'true_model', 'notes']);
		const ids = new Set<string>();
		for (const [id, sha256, key, trueModel] of rows.filter((r) => r.some((c) => c !== ''))) {
			expect(ids.has(id), `duplicate id ${id}`).toBe(false);
			ids.add(id);
			expect(sha256).toMatch(/^[0-9a-f]{64}$/);
			expect(key).toMatch(/^private-data\/hard-photos\/[^/]+\.(jpe?g|png|heic|webp)$/i);
			expect(trueModel.trim()).not.toBe('');
			// The VPS copy, when present, is the photo the manifest names.
			const local = join(root, 'hard-photos', 'files', basename(key));
			if (existsSync(local)) {
				const actual = createHash('sha256').update(readFileSync(local)).digest('hex');
				expect(actual, basename(key)).toBe(sha256);
			}
		}
		expect(ids.size).toBeGreaterThan(0);
	});
});
