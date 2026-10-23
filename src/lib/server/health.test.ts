/**
 * The readiness probe: reachable, unreachable, and bounded.
 *
 * The third test is the one that matters and the one a boolean assertion would
 * miss: it proves the timeout is enforced by Postgres, not by a client-side
 * race. A `Promise.race` answers `false` on schedule too — and leaves a `SELECT`
 * running that the app has stopped waiting for, which is what a probe on a 10 s
 * interval would accumulate against a sick database.
 */
import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { READINESS_TIMEOUT_MS, databaseReady } from './health';
import type { Database } from './progression';
import { setupTestDb } from './test-db';

describe('databaseReady', () => {
	it('answers true against the test database', async () => {
		const harness = await setupTestDb();
		try {
			expect(READINESS_TIMEOUT_MS).toBeGreaterThan(0);
			await expect(databaseReady(harness.db)).resolves.toBe(true);
		} finally {
			await harness.end();
		}
	});

	it('shares one probe between concurrent callers, so probes cannot stack', async () => {
		// The pool wait is the one phase no server-side timeout can bound (no
		// connection exists yet), so the bound is that concurrent probes are the
		// SAME probe. A second caller must not open a second transaction.
		let transactions = 0;
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => (release = resolve));
		const fake = {
			transaction: async (run: (tx: unknown) => Promise<unknown>) => {
				transactions++;
				await gate;
				return run({ execute: async () => [] });
			}
		} as unknown as Database;

		const probes = [databaseReady(fake), databaseReady(fake), databaseReady(fake)];
		release();

		await expect(Promise.all(probes)).resolves.toEqual([true, true, true]);
		expect(transactions, 'three concurrent probes must run one transaction').toBe(1);
	});

	it('answers false, without throwing, when nothing is listening', async () => {
		// An isolated dead endpoint on loopback: real socket, real refusal. The
		// probe must report it, not reject and not hang past the healthcheck.
		const dead = postgres('postgresql://probe:probe@127.0.0.1:1/doclifts_probe_test', {
			max: 1,
			connect_timeout: 2
		});
		const started = Date.now();
		try {
			await expect(databaseReady(drizzle(dead))).resolves.toBe(false);
		} finally {
			await dead.end();
		}
		expect(Date.now() - started).toBeLessThan(10_000);
	});

	it('cancels a slow probe in the database rather than leaving it running', async () => {
		const harness = await setupTestDb();
		try {
			const started = Date.now();
			await expect(
				databaseReady(harness.db, { timeoutMs: 200, query: sql`select pg_sleep(5)` })
			).resolves.toBe(false);
			// The statement timeout fired well before the sleep would have ended.
			expect(Date.now() - started).toBeLessThan(2_000);

			// ...and the sleep is gone. A client-side race would still have it
			// active for another ~4 s, visible here as the same fault under load.
			// `pid <> pg_backend_pid()`: this query's own text contains the LIKE
			// pattern, so an active session matches itself otherwise.
			await new Promise((resolve) => setTimeout(resolve, 600));
			const [row] = await harness.db.execute(
				sql`select count(*)::int as n from pg_stat_activity
				    where state = 'active' and pid <> pg_backend_pid()
				      and query like '%pg_sleep%'`
			);
			expect(row.n).toBe(0);

			// The transaction was aborted with the statement, not left open: an
			// idle-in-transaction session holds locks and is the other half of
			// "work that survives a caller that stopped waiting".
			const [txRow] = await harness.db.execute(
				sql`select count(*)::int as n from pg_stat_activity
				    where state = 'idle in transaction' and pid <> pg_backend_pid()`
			);
			expect(txRow.n).toBe(0);
		} finally {
			await harness.end();
		}
	});
});
