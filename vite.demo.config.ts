/**
 * Vitest project config for the demo seed.
 *
 * WHY A SEPARATE FILE: `seedDemo` creates its owner through `createUser`,
 * which writes through the app's `auth` singleton — bound to DATABASE_URL at
 * module import (db/index.ts) and therefore fixed for the life of the process.
 * The demo rows go to the database handle the caller passes. If those two
 * differ, the demo user is created in one database and every demo row in the
 * demo test points at a user_id that does not exist in its own database.
 *
 * That is not hypothetical: it is what the first (g0) run produced, a
 * `user_email_unique` violation, because the `server` project points
 * DATABASE_URL at doclifts_test while the seed ran against
 * doclifts_demo_test.
 *
 * In production the two are always the same database — db/index.ts builds the
 * singleton from DATABASE_URL and seed.ts builds its handle from the same
 * variable — so this file reproduces that arrangement rather than inventing
 * one. The technique is ordering, not an override flag: TEST_DATABASE_URL is
 * set to the demo database *before* importing the base config, and the base
 * config's own `process.env.VITEST` block reads TEST_DATABASE_URL first and
 * assigns both it and DATABASE_URL from that value.
 */
import { loadEnv } from 'vite';

const fromFile = loadEnv(
	process.env.NODE_ENV === 'production' ? 'production' : 'development',
	process.cwd(),
	''
);
const base =
	process.env.TEST_DATABASE_URL ??
	fromFile.TEST_DATABASE_URL ??
	'postgresql://localhost/doclifts_test';

// Same host, port and credentials; only the database name changes. The
// `_test` suffix keeps the app's own guard satisfied by construction.
process.env.TEST_DATABASE_URL = base.replace(/\/[^/]+$/, '/doclifts_demo_test');

// Imported AFTER the assignment above, deliberately.
const baseConfig = (await import('./vite.config.ts')).default;

export default {
	...baseConfig,
	test: {
		name: 'demo',
		environment: 'node',
		include: ['src/lib/server/demo.db.test.ts'],
		// One database, one test file. Strictly serial, like the other DB
		// projects, and with generous hook timeouts because beforeAll runs
		// CREATE DATABASE and the full migration chain.
		fileParallelism: false,
		hookTimeout: 120_000,
		testTimeout: 60_000
	}
};
