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

const client = postgres(env.DATABASE_URL, { max: 10 });

export const db = drizzle(client, { schema });

export * from './schema';
