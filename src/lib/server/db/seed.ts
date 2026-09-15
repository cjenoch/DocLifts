import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';
import { seedDemo } from '../demo';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
const client = postgres(process.env.DATABASE_URL, { max: 1 });
try {
	console.log(await seedDemo(drizzle(client, { schema }), process.env.DOCLIFTS_DEMO === '1'));
} catch (error) {
	console.error(error instanceof Error ? error.message : 'Demo initialization failed.');
	process.exitCode = 1;
} finally {
	await client.end();
}
