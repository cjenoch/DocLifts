/**
 * Drizzle client singleton.
 *
 * Place at: src/lib/server/db/index.ts
 *
 * Used by SvelteKit server code (load functions, form actions) and by the
 * seed script. The seed bootstraps its own client for cleaner connection
 * lifecycle (it needs to call `client.end()` after seeding); SvelteKit
 * imports `db` directly and lets the connection pool manage itself.
 *
 * `process.env.DATABASE_URL` is populated:
 *   - In dev: by Vite from .env (which SvelteKit auto-loads)
 *   - In seed: by `node --env-file=.env src/lib/server/db/seed.ts`
 *   - In prod: by your deployment's environment config
 *
 * If you'd prefer SvelteKit's `$env/static/private` for build-time validation,
 * that's a one-line swap. `process.env` is fine for MVP single-tenant.
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error(
    'DATABASE_URL environment variable not set. ' +
      'Check .env (dev) or your deployment env vars.',
  );
}

// Connection pool sized for single-user MVP. Bump `max` when multi-user arrives.
const client = postgres(DATABASE_URL, { max: 10 });

export const db = drizzle(client, { schema });

// Re-export schema for convenience: `import { db, programs } from '$lib/server/db'`.
export * from './schema';
