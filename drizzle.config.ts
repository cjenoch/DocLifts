import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

if (!process.env.DATABASE_URL) {
	throw new Error('DATABASE_URL not set — check .env');
}

export default defineConfig({
	dialect: 'postgresql',
	schema: './src/lib/server/db/schema.ts',
	out: './drizzle',
	/**
	 * Better Auth's four tables live in the `auth` Postgres schema. Without
	 * this, drizzle-kit's default `['public']` would treat them as foreign
	 * and could propose dropping them on the next push/apply.
	 */
	schemaFilter: ['public', 'auth'],
	dbCredentials: {
		url: process.env.DATABASE_URL
	},
	strict: true,
	verbose: true
});
