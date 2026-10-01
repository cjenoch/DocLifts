/**
 * pnpm catalog:import <csv> [--dry-run]
 *
 * Upserts a manufacturer catalog snapshot into equipment_models as GLOBAL rows
 * (owner_user_id IS NULL). Built like src/lib/server/db/seed.ts: its own
 * postgres() client from process.env.DATABASE_URL, no app singleton, no $env —
 * this runs under bare tsx, outside SvelteKit.
 *
 * Exit status: 0 on success (including a dry run that would succeed); 1 when
 * any row cannot be mapped or matched, in which case NOTHING is written; 2 on
 * usage errors.
 *
 * In production this runs through scripts/catalog-prod.sh. See docs/catalog.md.
 */
import { readFileSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../src/lib/server/db/schema';
import { formatImportReport, importCatalog } from '../src/lib/server/catalog-import';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const files = args.filter((a) => !a.startsWith('--'));
const unknown = args.filter((a) => a.startsWith('--') && a !== '--dry-run');
if (files.length !== 1 || unknown.length) {
	console.error('Usage: pnpm catalog:import <csv> [--dry-run]');
	process.exit(2);
}
const url = process.env.DATABASE_URL;
if (!url) {
	console.error('DATABASE_URL is required. Pass --env-file=.env or export it.');
	process.exit(2);
}

const client = postgres(url, { max: 1, onnotice: () => {} });
const db = drizzle(client, { schema });
try {
	const result = await importCatalog(db, readFileSync(files[0], 'utf8'), { dryRun });
	console.log(formatImportReport(result));
	if (result.failed) process.exitCode = 1;
} catch (error) {
	console.error(error instanceof Error ? error.message : 'Catalog import failed.');
	process.exitCode = 1;
} finally {
	await client.end();
}
