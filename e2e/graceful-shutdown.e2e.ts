/**
 * The served build exits on SIGTERM.
 *
 * WHAT WAS WRONG
 * --------------
 * adapter-node's graceful_shutdown closes the HTTP server, emits
 * `sveltekit:shutdown`, and then waits for the event loop to drain. Nothing
 * closed the postgres-js pool, so its sockets to :5432 kept the loop alive
 * forever: leftover `node build/index.js` processes with no listener and no
 * HTTP connections sat there 40+ minutes after SIGTERM. In production every
 * `docker stop` waited out the stop timeout and ended in SIGKILL. The fix is
 * the `sveltekit:shutdown` listener in src/lib/server/db/index.ts.
 *
 * WHY THE POSITIVE ASSERTION COMES FIRST
 * --------------------------------------
 * postgres-js connects lazily. A build that has not queried the database has
 * no socket open, and it exits on SIGTERM with or without the fix. So the
 * test first proves the precondition: Postgres reports a live backend tagged
 * with this server's `application_name`. Without that, a green result could
 * just mean the pool was never opened.
 *
 * Verified: with the listener removed from db/index.ts, the exit assertion
 * fails at its deadline and the backend is still connected.
 *
 * afterAll still calls `stop` (SIGKILL). That is the safety net in case this assertion
 * fails, so a regression cannot leave an orphan server holding the test DB.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
	freshTestDb,
	seedTestUser,
	signInAs,
	startTestServer,
	testDatabaseUrl,
	type TestServer,
	type TestDb
} from '$lib/server/test-auth-helpers';

/** Postgres's tag for this server's connections, so we count only its pool. */
const APP_NAME = 'doclifts-e2e-graceful-shutdown';

/**
 * How long a clean shutdown may take. It needs well under a second; the
 * margin is for a slow CI box. adapter-node's own SHUTDOWN_TIMEOUT (30s)
 * applies only to HTTP connections that stay open, and none do here.
 */
const EXIT_DEADLINE_MS = 10_000;

let server: TestServer | undefined;
let origin: string;
let db: TestDb;
let harness: Awaited<ReturnType<typeof freshTestDb>>;

const serverBackends = async (): Promise<number> =>
	(
		await db.execute<{ n: number }>(
			sql`select count(*)::int as n from pg_stat_activity where application_name = ${APP_NAME}`
		)
	)[0].n;

beforeAll(async () => {
	harness = await freshTestDb();
	db = harness.db;
	await seedTestUser(db);

	// postgres-js passes unknown URL query parameters through as connection
	// parameters, so this reaches Postgres as the backend's application_name.
	const url = new URL(testDatabaseUrl());
	url.searchParams.set('application_name', APP_NAME);
	server = await startTestServer({ DATABASE_URL: url.toString() });
	origin = server.origin;
}, 120_000);

afterAll(async () => {
	await server?.stop();
	await harness?.end();
});

describe('SIGTERM', () => {
	it('closes the database pool and exits', async () => {
		// Make the server use its pool: sign-in reads the user and writes a
		// session, and /history runs owner-scoped queries.
		const cookie = await signInAs(origin);
		const history = await fetch(new URL('/history', origin), {
			headers: { cookie },
			redirect: 'manual'
		});
		expect(history.status, 'signed-in /history should render').toBe(200);
		expect(
			await serverBackends(),
			'the served build holds no Postgres connection, so this test cannot see the bug'
		).toBeGreaterThan(0);

		const outcome = await server!.terminate(EXIT_DEADLINE_MS);

		expect(
			outcome,
			`the build was still running ${EXIT_DEADLINE_MS / 1000}s after SIGTERM; ` +
				`backends still open: ${await serverBackends()}`
		).toEqual({ code: 0, signal: null });

		// The state change, not just the exit: postgres-js sent Terminate, so
		// Postgres has dropped the backends rather than waiting to notice a
		// dead socket. Polled briefly because backend teardown is asynchronous.
		let open = await serverBackends();
		for (let i = 0; open > 0 && i < 20; i++) {
			await new Promise((r) => setTimeout(r, 100));
			open = await serverBackends();
		}
		expect(open, 'Postgres still lists backends from the exited server').toBe(0);
	}, 30_000);
});
