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
 * Record correction (2026-09-29): commit 9101e91 replaced a `doclifts:dev`
 * default and described it as "not matching any documented setup". That was
 * wrong — `doclifts:dev` is the documented dev credential in `.env.example`
 * and the README. The secretless default is still the right call (no
 * password in source), but note what it assumes: with no user in the URL,
 * postgres-js connects as your OS user, so a bare `pnpm test` fails with
 * "password authentication failed for user <you>" unless that role exists.
 * Set `TEST_DATABASE_URL` and it does not matter.
 *
 * Parallelism note: vitest runs test FILES in parallel by default. Only one
 * DB integration test file exists today; if you add a second, either force
 * server-project file serialization or scope each file to its own DB.
 */

import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import * as schema from './db/schema';
import { authUsers } from './db/schema';

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

	// NOTE: this does NOT protect the app's `db` singleton. That is created at
	// module import from DATABASE_URL, so a test importing `auth` before
	// calling this still points at whatever DATABASE_URL is in the
	// environment. The real guard is the `env` block in vite.config.ts's server
	// project, which rewrites DATABASE_URL before any module loads. Do not rely
	// on this line for that — it is here only so a test that lazily imports
	// auth AFTER setup resolves the same URL as the migrator.

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
 * Fail if any ownership-scoped row has a NULL user_id.
 *
 * WHY THIS EXISTS: between 0009 and 0010 the `user_id` columns are NULLABLE
 * in the TS schema, so the compiler cannot catch an insert that forgets an
 * owner. T3's modules write and filter `user_id`; an insert that omits it
 * would create a row that every scoped query silently skips. The type system
 * takes over when 0010 applies `notNull()` — delete this then.
 *
 * Call from `afterEach` of every `*.db.test.ts` from the first T3 module
 * onward. It is a no-op (returns) on tables that do not exist yet, so it is
 * safe to wire in before 0009 has been applied to the test DB.
 */
export async function assertNoUnownedRows(client: postgres.Sql): Promise<void> {
	const scoped = [
		'programs',
		'gyms',
		'exercises',
		'sessions',
		'sets',
		'pain_events',
		'workout_log_imports',
		'program_draft_requests'
	];

	// Only check tables that actually have the column — before 0009 the test
	// DB has no user_id at all, and a missing table is not a test failure.
	const present = await client<{ exists: number }[]>`
		SELECT count(*)::int AS exists
		FROM information_schema.columns
		WHERE table_schema = 'public' AND column_name = 'user_id'
	`;
	if (!present[0]?.exists) return;

	for (const table of scoped) {
		const rows = await client.unsafe<{ n: number }[]>(
			`SELECT count(*)::int AS n FROM "${table}" WHERE user_id IS NULL`
		);
		const n = rows[0]?.n ?? 0;
		if (n > 0) {
			throw new Error(
				`assertNoUnownedRows: ${table} has ${n} row(s) with user_id NULL. ` +
					`Every insert in a T3-scoped module must supply the owner.`
			);
		}
	}
}

/**
 * A bare `auth.user` row, no credential.
 *
 * T3 modules scope reads and writes by userId, so tests need real users that
 * exist in the auth schema for the FK. They do NOT need a password: nothing
 * here signs in over HTTP, and Better Auth's password tables are only
 * exercised by the sign-in path, which uses `createUser` from users.ts.
 *
 * Asserts the test-DB guard before inserting — this must never be reachable
 * with a production URL.
 */
export async function createTestUser(db: TestDb, label = 'fixture'): Promise<string> {
	const url = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_URL;
	const name = dbNameFromUrl(url);
	if (!name.endsWith('_test')) {
		throw new Error(
			`createTestUser refuses to run against "${name}": only a *_test database is allowed.`
		);
	}
	const [row] = await db
		.insert(authUsers)
		.values({
			// auth."user".id has NO database default — Better Auth mints it in
			// application code, so the drizzle column types it as required and
			// the test must supply it. This is a fixture, not a sign-in: no
			// credential row is created, so nothing here can authenticate.
			id: crypto.randomUUID(),
			// email must be unique; label + randomness keeps parallel/repeat
			// runs from colliding on a 23505.
			email: `${label}-${Math.random().toString(36).slice(2, 10)}@test.local`,
			name: label,
			emailVerified: true
		})
		.returning();
	return row.id;
}

/**
 * Two distinct users, for cross-tenant assertions. Named for intent at the
 * call site: `const { alice, bob } = await withTwoUsers(db)`.
 */
export async function withTwoUsers(db: TestDb): Promise<{ alice: string; bob: string }> {
	const alice = await createTestUser(db, 'alice');
	const bob = await createTestUser(db, 'bob');
	return { alice, bob };
}

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
			imported_workouts,
			-- Better Auth's four tables, child-first. Without these a test that
			-- creates a user leaves it behind and the next run's "already
			-- exists" assertion fails for the wrong reason. Qualified because
			-- they live in a different Postgres schema.
			"auth"."verification",
			"auth"."account",
			"auth"."session",
			"auth"."user"
		RESTART IDENTITY CASCADE
	`;
}
