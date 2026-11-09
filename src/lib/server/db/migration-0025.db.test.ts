/**
 * Migration 0025's rules, asserted against the database itself (raw SQL, no
 * application code in the way), so each test proves the constraint, not a
 * check some function makes first. Positive case first in every test.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { resetTestDbWithUsers, setupTestDb } from '../test-db';

let harness: Awaited<ReturnType<typeof setupTestDb>>;
let userId: string;

beforeEach(async () => {
	harness ??= await setupTestDb();
	[{ id: userId }] = await resetTestDbWithUsers(harness.db, harness.client, 1, 'm0025');
});

afterAll(async () => {
	await harness?.end();
});

const count = async (query: Promise<{ n: number }[]>) => (await query)[0].n;

describe('0025: one credential row per (provider_id, account_id)', () => {
	it('accepts the first credential row and refuses a second for the same account', async () => {
		const sql = harness.client;
		await sql`insert into auth.account (id, account_id, provider_id, user_id, password)
		          values ('acct-1', ${userId}, 'credential', ${userId}, 'hash-1')`;
		expect(
			await count(sql`select count(*)::int as n from auth.account where user_id = ${userId}`)
		).toBe(1);

		await expect(
			sql`insert into auth.account (id, account_id, provider_id, user_id, password)
			    values ('acct-2', ${userId}, 'credential', ${userId}, 'hash-2')`
		).rejects.toMatchObject({
			code: '23505',
			constraint_name: 'auth_account_provider_account_unique'
		});
		// The state, not just the error: still one row, the first password.
		const rows = await sql<{ id: string; password: string }[]>`
			select id, password from auth.account where user_id = ${userId}`;
		expect(rows).toEqual([{ id: 'acct-1', password: 'hash-1' }]);
	});

	it('still allows the same account id under another provider', async () => {
		const sql = harness.client;
		await sql`insert into auth.account (id, account_id, provider_id, user_id)
		          values ('acct-a', ${userId}, 'credential', ${userId}),
		                 ('acct-b', ${userId}, 'other-provider', ${userId})`;
		expect(
			await count(sql`select count(*)::int as n from auth.account where user_id = ${userId}`)
		).toBe(2);
	});
});

describe('0025: a completed deletion job carries no error', () => {
	it('accepts completed-without-error and open-with-error, and refuses completed-with-error', async () => {
		const sql = harness.client;
		await sql`insert into privacy_deletions (kind, subject_hash, completed_at, last_error)
		          values ('photo', 'done', now(), null), ('photo', 'retrying', null, 'boom')`;
		expect(await count(sql`select count(*)::int as n from privacy_deletions`)).toBe(2);

		await expect(
			sql`insert into privacy_deletions (kind, subject_hash, completed_at, last_error)
			    values ('photo', 'both', now(), 'boom')`
		).rejects.toMatchObject({
			code: '23514',
			constraint_name: 'privacy_deletions_completed_no_error_check'
		});
		// Completing a job that still carries its error is refused too.
		await expect(
			sql`update privacy_deletions set completed_at = now() where subject_hash = 'retrying'`
		).rejects.toMatchObject({ constraint_name: 'privacy_deletions_completed_no_error_check' });
		const rows = await sql<{ subject_hash: string; done: boolean; last_error: string | null }[]>`
			select subject_hash, completed_at is not null as done, last_error
			from privacy_deletions order by subject_hash`;
		expect(rows).toEqual([
			{ subject_hash: 'done', done: true, last_error: null },
			{ subject_hash: 'retrying', done: false, last_error: 'boom' }
		]);
	});

	it('has a nullable claimed_until that stores a time', async () => {
		const sql = harness.client;
		await sql`insert into privacy_deletions (kind, subject_hash) values ('photo', 'lease')`;
		const [fresh] = await sql<{ claimed_until: Date | null }[]>`
			select claimed_until from privacy_deletions where subject_hash = 'lease'`;
		expect(fresh.claimed_until).toBeNull();
		await sql`update privacy_deletions set claimed_until = '2026-11-09T12:00:00Z'
		          where subject_hash = 'lease'`;
		const [claimed] = await sql<{ claimed_until: string | Date }[]>`
			select claimed_until from privacy_deletions where subject_hash = 'lease'`;
		expect(new Date(claimed.claimed_until).toISOString()).toBe('2026-11-09T12:00:00.000Z');
	});
});

describe('0025: auth.user.time_zone', () => {
	it('is NULL by default, stores a zone name, and refuses an empty or over-long value', async () => {
		const sql = harness.client;
		const read = async () =>
			(
				await sql<{ time_zone: string | null }[]>`
				select time_zone from auth.user where id = ${userId}`
			)[0].time_zone;
		expect(await read()).toBeNull();
		await sql`update auth.user set time_zone = 'America/Detroit' where id = ${userId}`;
		expect(await read()).toBe('America/Detroit');

		for (const bad of ['', 'x'.repeat(65)]) {
			await expect(
				sql`update auth.user set time_zone = ${bad} where id = ${userId}`
			).rejects.toMatchObject({
				code: '23514',
				constraint_name: 'auth_user_time_zone_length_check'
			});
		}
		expect(await read()).toBe('America/Detroit');
	});
});
