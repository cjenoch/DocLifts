import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '$env/dynamic/private';
import * as authSchema from './auth-schema';
import * as schema from './schema';

// Better Auth's four tables live in the `auth` Postgres schema. Re-exported
// so `Database` (which is `typeof schema`) includes them — the auth adapter
// and any owner-scoped FK in the ownership migration need them present.
export * from './schema';
export { authSchema };
export {
	authUsers,
	authSessions,
	authAccounts,
	authVerifications,
	authTables
} from './auth-schema';

if (!env.DATABASE_URL) {
	throw new Error('DATABASE_URL not set — check .env');
}

/**
 * Throw unless `url` names a test database. Exported for its own test —
 * see the guard's comment below for why it exists.
 *
 * The rule is a `_test` suffix, not one fixed name, so a project that runs a
 * second disposable database (`foo_test`, `integration_test`) works without a
 * code change. The scratch database used for migration verification
 * (`doclifts_scratch`) is NOT covered and does not need to be: drizzle-kit
 * migrates it with an explicit DATABASE_URL and never runs under vitest. If a
 * future test needs a second scratch database, name it with the suffix.
 *
 * The offending name is included in the error so it is obvious without
 * re-deriving it from the URL.
 */
export function assertTestDatabaseUrl(url: string): string {
	const name = new URL(url).pathname.replace(/^\//, '');
	if (!name.endsWith('_test')) {
		throw new Error(
			`Refusing to build a database client under vitest against "${name}" — ` +
				`the database name must end in _test. Set TEST_DATABASE_URL, or unset ` +
				`DATABASE_URL so vite.config.ts fills in the test database.`
		);
	}
	return name;
}

// Test-database name guard — the last line of defence against a test run
// writing to a real database.
//
// db/index.ts builds this client at MODULE IMPORT from DATABASE_URL. In a
// vitest process the URL is forced to the test database in vite.config.ts, but
// that is one layer that can be bypassed (a direct `tsx script.ts`, a custom
// config, a future test runner). This one lives at the point of use.
//
// The real hazard is a stale DATABASE_URL exported in the shell. On this host
// 127.0.0.1:5432 answers with a real Postgres, so a variable left over from a
// migration run binds a real database rather than failing loudly.
//
// Mirrors the seedDemo guard: same shape, same intent, same error style.
if (process.env.VITEST) assertTestDatabaseUrl(env.DATABASE_URL);

const client = postgres(env.DATABASE_URL, { max: 10 });

// Close the pool when adapter-node shuts down, or the process never exits.
//
// On SIGTERM/SIGINT, adapter-node's graceful_shutdown closes the HTTP server,
// emits `sveltekit:shutdown` once the last request has finished, and then
// relies on the event loop draining. The pool's sockets to Postgres keep it
// alive indefinitely: measured 2026-10-01, served builds with no listener and
// no HTTP connections, only ESTABLISHED sockets to :5432, still up 40+ minutes
// later. In production that turns every `docker stop` into a wait for the stop
// timeout followed by SIGKILL.
//
// Every request is already done when the event fires, so `end` has nothing in
// flight to wait for; the timeout bounds a Postgres that does not answer the
// terminate. e2e/graceful-shutdown.e2e.ts sends SIGTERM to a served build
// that has queried the database and asserts it exits.
process.once('sveltekit:shutdown', () => {
	client.end({ timeout: 5 }).catch((cause: unknown) => {
		console.error('[shutdown] closing the database pool failed:', cause);
	});
});

export const db = drizzle(client, { schema });

export * from './schema';
