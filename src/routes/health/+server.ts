/**
 * Readiness for the container healthcheck and the deploy checks.
 *
 * WHY IT IS PUBLIC AND WHY IT IS ONE FIELD
 * ----------------------------------------
 * `/health` is on the guard's allowlist (src/lib/server/request-user.ts): the
 * probe runs before anyone has signed in. That makes it publicly reachable on
 * the public origin, so the body is deliberately one word and no detail — a
 * database error string carries the host, the database and the role, and none
 * of that belongs in an unauthenticated response. The failure is logged
 * server-side instead (src/lib/server/health.ts, at most once a minute).
 *
 * 200 only when a bounded `select 1` returned; 503 otherwise. A caller reading
 * the status alone learns "this app cannot reach its database", which is what
 * `docker compose --wait`, a deploy check and a human need. Note that Compose
 * does not restart a service for being unhealthy: this is a signal, not a
 * self-healing control.
 *
 * It is a route file rather than a page: no layout, no session lookup, no
 * rendered HTML.
 */
import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { databaseReady } from '$lib/server/health';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	const ready = await databaseReady(db);
	return json({ status: ready ? 'ok' : 'unavailable' }, { status: ready ? 200 : 503 });
};
