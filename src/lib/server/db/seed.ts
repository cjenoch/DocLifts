import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';
import * as authSchema from '../db/auth-schema';
import { seedDemo } from '../demo';
import { createAuth } from '../auth-core';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
if (!process.env.BETTER_AUTH_SECRET) throw new Error('BETTER_AUTH_SECRET is required.');
const client = postgres(process.env.DATABASE_URL, { max: 1 });
const db = drizzle(client, { schema: { ...schema, ...authSchema } });
// Built from process.env exactly like the user:* CLIs (scripts/user-cli-context.ts):
// this script runs under bare tsx and cannot import auth.ts, which reaches $env/$app.
const auth = createAuth(db, {
	secret: process.env.BETTER_AUTH_SECRET,
	baseURL: process.env.PUBLIC_ORIGIN ?? 'http://127.0.0.1:3000',
	openSignup: false,
	rateLimitStorage: 'memory'
});
try {
	console.log(await seedDemo(auth, db, process.env.DOCLIFTS_DEMO === '1'));
} catch (error) {
	console.error(error instanceof Error ? error.message : 'Demo initialization failed.');
	process.exitCode = 1;
} finally {
	await client.end();
}
