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

/**
 * `urlOverride` is for the one caller that must reach a different database than
 * the rest of the suite: demo.db.test.ts, whose seed writes through the app's
 * `auth` singleton and therefore needs DATABASE_URL and TEST_DATABASE_URL to
 * name the same demo database (see vite.demo.config.ts). Every other caller
 * passes nothing and is unaffected.
 *
 * The override is still checked against the same `_test` rule db/index.ts
 * enforces, reimplemented locally rather than imported — that module builds
 * the production `db` singleton at import time, which test code must not
 * trigger. So a test still cannot hand this function a real database name.
 */
export async function setupTestDb(urlOverride?: string): Promise<{
	db: TestDb;
	client: postgres.Sql;
	end: () => Promise<void>;
}> {
	const testUrl = urlOverride ?? process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_URL;
	if (urlOverride && !dbNameFromUrl(urlOverride).endsWith('_test')) {
		throw new Error(
			`Refusing setupTestDb override: database name must end in _test, got ${dbNameFromUrl(urlOverride)}`
		);
	}
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

/**
 * Reset, then create fixture users — in THAT order, and only through this.
 *
 * `resetTestDb` truncates `auth.user`, so a user created before the reset is
 * gone by the time the test body runs and every owned insert fails the owner
 * FK with a confusing message. That mistake appeared in two files during the
 * accounts work, so the wrong order is now unrepresentable rather than merely
 * discouraged: there is no exported way to create a fixture user without also
 * resetting first.
 *
 * @param users how many users to create; 0 resets only.
 * @returns the created users, in a stable order, for `withTwoUsers`-style use.
 */
export async function resetTestDbWithUsers(
	db: TestDb,
	client: postgres.Sql,
	users = 1,
	label = 'test'
): Promise<{ id: string; label: string }[]> {
	await resetTestDb(client);
	const out: { id: string; label: string }[] = [];
	for (let i = 0; i < users; i++) {
		const name = users === 1 ? label : `${label}-${i + 1}`;
		out.push({ id: await createTestUser(db, name), label: name });
	}
	return out;
}

export async function resetTestDb(client: postgres.Sql): Promise<void> {
	await client`
		TRUNCATE
			"auth"."signup_attempts",
			mail_sends,
			signup_admissions,
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
			equipment_photos,
			llm_calls,
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
