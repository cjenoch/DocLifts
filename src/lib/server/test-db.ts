/**
 * Integration-test database helper.
 *
 * Imported only by *.test.ts files. NOT to be imported from production code —
 * pulls in the migrator and runs DDL.
 *
 * Strategy:
 *   - Connect to the `postgres` admin DB on the same host as dev.
 *   - Ensure the test DB (default `doclifts_test`) exists; create it if not.
 *   - Connect to the test DB and apply migrations.
 *   - Caller is responsible for truncating between tests (use `resetTestDb`).
 *
 * Override the target via `TEST_DATABASE_URL` env var if you want a different
 * test DB (e.g. CI). No credentials live in this file: the fallback is a
 * secretless local URL, so set `TEST_DATABASE_URL` (e.g. in `.env`) for your
 * real test database rather than relying on the default.
 *
 * Parallelism note: vitest runs test FILES in parallel by default. Only one
 * DB integration test file exists today; if you add a second, either force
 * server-project file serialization or scope each file to its own DB.
 */

import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import * as schema from './db/schema';

export type TestDb = PostgresJsDatabase<typeof schema>;

// Secretless default — no user or password in source. Point TEST_DATABASE_URL
// at your real test database (e.g. via .env); see README/CONTRIBUTING.
const DEFAULT_TEST_URL = 'postgresql://localhost/doclifts_test';

function adminUrl(testUrl: string): string {
	const url = new URL(testUrl);
	url.pathname = '/postgres';
	return url.toString();
}

function dbNameFromUrl(testUrl: string): string {
	const path = new URL(testUrl).pathname;
	if (!path || path === '/') {
		throw new Error(`TEST_DATABASE_URL missing database name: ${testUrl}`);
	}
	return path.slice(1);
}

export async function setupTestDb(): Promise<{
	db: TestDb;
	client: postgres.Sql;
	end: () => Promise<void>;
}> {
	const testUrl = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_URL;
	const dbName = dbNameFromUrl(testUrl);

	// Ensure the test DB exists. Connect to admin DB to issue DDL.
	const admin = postgres(adminUrl(testUrl), { max: 1, onnotice: () => {} });
	try {
		const exists = await admin`
			SELECT 1 FROM pg_database WHERE datname = ${dbName}
		`;
		if (exists.length === 0) {
			// dbName is derived from our own URL parsing, not user input —
			// safe to interpolate as identifier.
			await admin.unsafe(`CREATE DATABASE "${dbName}"`);
		}
	} finally {
		await admin.end();
	}

	const client = postgres(testUrl, { max: 8, onnotice: () => {} });
	const db = drizzle(client, { schema });
	await migrate(db, { migrationsFolder: './drizzle' });
	return { db, client, end: () => client.end() };
}

/**
 * Truncate all application tables. Cascades clean up child rows.
 * Call from beforeEach for a clean slate per test.
 */
export async function resetTestDb(client: postgres.Sql): Promise<void> {
	await client`
		TRUNCATE
			pain_events,
			session_exercises,
			exercise_equipment_map,
			gym_equipment,
			equipment_models,
			gyms,
			sets,
			sessions,
			prescribed_sets,
			day_exercises,
			days,
			programs,
			exercises,
			program_draft_requests,
			workout_log_imports,
			imported_workouts
		RESTART IDENTITY CASCADE
	`;
}
