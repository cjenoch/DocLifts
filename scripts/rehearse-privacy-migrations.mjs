import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
const require = createRequire(process.cwd() + '/package.json');
const postgres = require('postgres');
const { drizzle } = require('drizzle-orm/postgres-js');
const { migrate } = require('drizzle-orm/postgres-js/migrator');
// This rehearsal creates and drops only a randomly named scratch test database.
// It never migrates or changes the database named by TEST_DATABASE_URL.
if (!process.env.TEST_DATABASE_URL) throw new Error('Explicit TEST_DATABASE_URL required');
const url = new URL(process.env.TEST_DATABASE_URL);
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !url.pathname.endsWith('_test'))
	throw new Error('Rehearsal requires a loopback test database URL');
const name = 'doclifts_privacy_upgrade_' + randomBytes(4).toString('hex') + '_test';
const adminUrl = new URL(url);
adminUrl.pathname = '/postgres';
const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
const folder = await mkdtemp(join(tmpdir(), 'doclifts-old-migrations-'));
let client;
let created = false;
try {
	await admin.unsafe('CREATE DATABASE "' + name + '"');
	created = true;
	url.pathname = '/' + name;
	client = postgres(url.toString(), { max: 1, onnotice: () => {} });
	const journal = JSON.parse(await readFile('drizzle/meta/_journal.json', 'utf8'));
	journal.entries = journal.entries.filter((x) => x.idx <= 21);
	await mkdir(join(folder, 'meta'));
	await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify(journal));
	for (const migration of journal.entries)
		await copyFile('drizzle/' + migration.tag + '.sql', join(folder, migration.tag + '.sql'));
	const db = drizzle(client);
	await migrate(db, { migrationsFolder: folder });
	const owner = 'fictional-migration-owner',
		gym = randomUUID();
	await client`INSERT INTO auth."user"(id,name,email)VALUES(${owner},'Fictional migration','migration@fixture.invalid')`;
	await client`INSERT INTO gyms(id,name,user_id)VALUES(${gym},'Fictional gym',${owner})`;
	for (const status of ['confirmed', 'discarded']) {
		const photo = randomUUID();
		await client`INSERT INTO equipment_photos(id,user_id,gym_id,storage_key,content_type,bytes,width,height,sha256,status) VALUES(${photo},${owner},${gym},${'users/' + owner + '/equipment-photos/' + photo + '.jpg'},'image/jpeg',1,1,1,${'0'.repeat(64)},${status})`;
	}
	await migrate(db, { migrationsFolder: './drizzle' });
	const rows =
		await client`SELECT state,count(*)::int AS n FROM photo_objects GROUP BY state ORDER BY state`;
	if (
		JSON.stringify(rows) !==
		JSON.stringify([
			{ state: 'delete_pending', n: 1 },
			{ state: 'stored', n: 1 }
		])
	)
		throw new Error('Backfill mismatch');
	await client`UPDATE auth."user" SET deletion_requested_at=now() WHERE id=${owner}`;
	let rejected = false;
	try {
		await client`UPDATE equipment_photos SET status='analyzed' WHERE user_id=${owner}`;
	} catch (error) {
		rejected = error.code === '23514';
	}
	if (!rejected) throw new Error('Write fence did not reject');
	rejected = false;
	try {
		await client`INSERT INTO auth.verification(id,identifier,value,expires_at)VALUES('late','late',${JSON.stringify({ type: 'authorization_code', userId: 'removed-fixture-user' })},now()+interval '1 minute')`;
	} catch (error) {
		rejected = error.code === '23514';
	}
	if (!rejected) throw new Error('Late OAuth code did not reject');
	rejected = false;
	try {
		await client`INSERT INTO auth.verification(id,identifier,value,expires_at)VALUES('late-reset','reset-password:late','removed-fixture-user',now()+interval '1 minute')`;
	} catch (error) {
		rejected = error.code === '23514';
	}
	if (!rejected) throw new Error('Late reset code did not reject');
	console.log(
		'Migration rehearsal passed: 0021 to 0023; stored/discarded backfill, owned write fence, stale OAuth and reset-code fences.'
	);
} finally {
	if (client) await client.end();
	if (created) await admin.unsafe('DROP DATABASE "' + name + '"');
	await admin.end();
	await rm(folder, { recursive: true, force: true });
}
