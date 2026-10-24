import postgres from 'postgres';
import type { Database } from '../progression';

// Separate from the web query pool. At most two connections, no lock wait and
// no transaction across object I/O. An expired lease could let a late PUT
// resurrect a removed image; a session lock lives until the writer disconnects.
const pools = new WeakMap<Database, postgres.Sql>();
const urls = new WeakMap<Database, string>();
export function configureStorageLocks(db: Database, url: string) {
	urls.set(db, url);
}
export async function closeStorageLocks(db: Database) {
	const pool = pools.get(db);
	pools.delete(db);
	urls.delete(db);
	if (pool) await pool.end({ timeout: 5 });
}
export async function withStorageLock<T>(db: Database, key: string, work: () => Promise<T>) {
	let pool = pools.get(db);
	if (!pool) {
		const url = urls.get(db);
		if (!url) throw new Error('Storage operations require a configured root database handle');
		pool = postgres(url, { max: 2, idle_timeout: 2, max_lifetime: 60, connect_timeout: 5 });
		pools.set(db, pool);
	}
	const connection = await pool.reserve();
	let locked = false;
	try {
		const [row] =
			await connection`SELECT pg_try_advisory_lock(hashtextextended(${key}, 29)) AS locked`;
		locked = row.locked;
		if (!locked) throw new Error('storage_busy');
		return await work();
	} finally {
		try {
			if (locked) await connection`SELECT pg_advisory_unlock(hashtextextended(${key}, 29))`;
		} finally {
			connection.release();
		}
	}
}
