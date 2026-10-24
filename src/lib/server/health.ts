/**
 * Database readiness for the container healthcheck.
 *
 * WHAT THIS IS FOR
 * ----------------
 * `GET /health` must answer "can this process reach the database right now?"
 * with one cheap round trip. The probe it replaces was `GET /`, which is an
 * unauthenticated 303 to /login — a response that proves a listener is open and
 * nothing about the database, so it stayed green while the app could not query.
 *
 * BOUNDED, SERVER-SIDE
 * --------------------
 * `statement_timeout` is set INSIDE the transaction that runs the probe, so
 * the bound is enforced by Postgres and a probe that hangs is cancelled rather
 * than abandoned. A `Promise.race` (or an AbortSignal on the client side alone)
 * would return on schedule and leave the query running: a probe on a 10 s
 * healthcheck interval would then pile up queries the app never waits for, and
 * a sick database would accumulate them instead of shedding them.
 *
 * The connect phase is the one part a statement timeout cannot bound — if the
 * database is not listening, there is no statement yet. That is bounded by the
 * probe's own `timeout` in Compose, which is why the healthcheck timeout stays
 * well under its interval: the container reports unhealthy on schedule even
 * when the failure is "cannot connect" rather than "query too slow".
 *
 * A readiness probe is not a migration check and not a schema check. It answers
 * one question, and a database that answers `select 1` but has a pending
 * migration is still "reachable" — that is what docs/migrations.md's own checks
 * are for.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { Database } from './progression';

/** Budget for the readiness statement, in ms. */
export const READINESS_TIMEOUT_MS = 2000;

/** Do not repeat a failing probe's log line more often than this. */
const LOG_INTERVAL_MS = 60_000;

let lastLoggedAt = 0;

/**
 * The probe currently in the pool, if any.
 *
 * The three ways this can hang, and what bounds each:
 *
 *   - POOL WAIT. `db` is the app's pool (max 10). A probe that finds every
 *     connection busy queues behind them, and postgres.js has no
 *     queue-visible deadline for it. Nothing server-side can bound this,
 *     because no connection exists yet — so the bound is that concurrent
 *     callers SHARE one probe (below) and a new one is never stacked behind a
 *     probe already waiting.
 *   - CONNECT. Bounded by the pool's own `connect_timeout` (30 s,
 *     src/lib/server/db/index.ts), and by the caller: Compose gives the probe
 *     5 s before it reports the container unhealthy, well under its 10 s
 *     interval.
 *   - EXECUTION. Bounded in the DATABASE, by `statement_timeout` set inside the
 *     transaction. This is the one that matters most: the query and the
 *     transaction it belongs to are aborted by Postgres, so a caller that
 *     stopped waiting cannot leave work running. A `Promise.race` would return
 *     on schedule and leave both.
 */
let inFlight: Promise<boolean> | null = null;

/** The shipped probe statement, shared by every unparameterised call. */
const DEFAULT_QUERY = sql`select 1`;

/**
 * True when a bounded query against `db` returned.
 *
 * `query` and `timeoutMs` are injectable so a test can prove the bound with a
 * genuinely slow statement (`select pg_sleep(...)`) instead of asserting that
 * the function returns a boolean. A call that overrides either one is never
 * shared, so a test's slow statement cannot be answered by another caller's.
 */
export function databaseReady(
	db: Database,
	options: { timeoutMs?: number; query?: SQL } = {}
): Promise<boolean> {
	// Decided from what the CALLER passed: a defaulted `query = sql`select 1``
	// would build a fresh object per call and nothing would ever be shared.
	const shared = options.query === undefined && options.timeoutMs === undefined;
	if (shared && inFlight) return inFlight;

	const probe = runProbe(db, {
		timeoutMs: options.timeoutMs ?? READINESS_TIMEOUT_MS,
		query: options.query ?? DEFAULT_QUERY
	});
	if (!shared) return probe;

	inFlight = probe;
	void probe.finally(() => {
		if (inFlight === probe) inFlight = null;
	});
	return probe;
}

async function runProbe(
	db: Database,
	{ timeoutMs, query }: { timeoutMs: number; query: SQL }
): Promise<boolean> {
	try {
		await db.transaction(async (tx) => {
			// `true` = local to this transaction, so the pool's other users (the
			// app's own queries) keep whatever timeout they have.
			await tx.execute(sql`select set_config('statement_timeout', ${String(timeoutMs)}, true)`);
			await tx.execute(query);
		});
		return true;
	} catch (cause) {
		// The response carries no detail (it is publicly reachable), so the clue
		// for an operator lives here — the message only, never the cause object,
		// which can carry a connection string. Rate-limited: an outage lasts
		// hours and the probe fires every 10 s.
		const now = Date.now();
		if (now - lastLoggedAt >= LOG_INTERVAL_MS) {
			lastLoggedAt = now;
			const message = cause instanceof Error ? cause.message : typeof cause;
			console.error(`[health] database readiness probe failed: ${message}`);
		}
		return false;
	}
}
