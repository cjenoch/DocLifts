import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '$env/dynamic/private';
import * as schema from './schema';

if (!env.DATABASE_URL) {
  throw new Error('DATABASE_URL not set — check .env');
}

const client = postgres(env.DATABASE_URL, { max: 10 });

export const db = drizzle(client, { schema });

export * from './schema';
