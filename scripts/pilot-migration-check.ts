// Isolated restore rehearsal. Never prints or writes private row contents.
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL required');
const parsed = new URL(url);
if (
	parsed.hostname !== '127.0.0.1' ||
	parsed.port !== '55439' ||
	parsed.pathname !== '/doclifts_pilot_restore'
)
	throw new Error('Only isolated pilot restore target allowed');
const client = postgres(url, { max: 1, onnotice: () => {} });
const tables = [
	'programs',
	'days',
	'day_exercises',
	'prescribed_sets',
	'exercises',
	'sessions',
	'sets',
	'pain_events'
] as const;
const before = new Map<string, { columns: string[]; count: number; hash: string }>();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
try {
	for (const table of tables) {
		const columns = (
			await client`select column_name from information_schema.columns where table_schema='public' and table_name=${table} order by ordinal_position`
		).map((r) => r.column_name as string);
		const rows = await client`select ${client(columns)} from ${client(table)} order by id`;
		before.set(table, { columns, count: rows.length, hash: hash(rows) });
	}
	await migrate(drizzle(client), { migrationsFolder: './drizzle' });
	for (const [table, baseline] of before) {
		const rows = await client`select ${client(baseline.columns)} from ${client(table)} order by id`;
		assert.equal(rows.length, baseline.count, `${table} row count changed`);
		assert.equal(hash(rows), baseline.hash, `${table} legacy data changed`);
		console.log(
			`${table}: ${rows.length} rows; original columns byte-equivalent after serialization`
		);
	}
	const [mappings] =
		await client`select count(*)::int as count from sets where gym_equipment_id is not null or session_exercise_id is not null or load_convention <> 'legacy'`;
	assert.equal(mappings.count, 0);
	console.log(
		'PASS: no inferred legacy machine/model mappings; original IDs, prescriptions and execution unchanged.'
	);
} finally {
	await client.end();
}
