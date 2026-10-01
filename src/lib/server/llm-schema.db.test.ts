/**
 * Migration 0013 (llm_calls), checked against the applied database rather than
 * the SQL file: CLAUDE.md "a generated migration is verified by applying it".
 * Every object is looked up BY NAME, so a constraint Postgres named for itself,
 * or truncated past 63 bytes, fails here.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setupTestDb, resetTestDbWithUsers, type TestDb } from './test-db';
import * as s from './db/schema';

let db: TestDb;
let handle: Awaited<ReturnType<typeof setupTestDb>>;
let userId: string;
beforeAll(async () => {
	handle = await setupTestDb();
	db = handle.db;
});
afterAll(async () => {
	await handle?.end();
});
beforeEach(async () => {
	[{ id: userId }] = await resetTestDbWithUsers(db, handle.client, 1, 'llm-schema');
});

const row = (over: Partial<s.NewLlmCall> = {}): s.NewLlmCall => ({
	userId,
	purpose: 'ping',
	provider: 'openrouter',
	model: 'test/model',
	status: 'ok',
	latencyMs: 1,
	promptHash: '0123456789abcdef',
	...over
});

describe('0013 llm_calls schema', () => {
	it('has the columns, nullability and types the spec lists', async () => {
		const cols = await handle.client<
			{ column_name: string; is_nullable: string; data_type: string }[]
		>`
			SELECT column_name, is_nullable, data_type
			FROM information_schema.columns
			WHERE table_schema = 'public' AND table_name = 'llm_calls'`;
		const by = Object.fromEntries(cols.map((c) => [c.column_name, c]));
		expect(Object.keys(by).sort()).toEqual(
			[
				'id',
				'user_id',
				'purpose',
				'provider',
				'model',
				'request_id',
				'status',
				'error_code',
				'prompt_tokens',
				'completion_tokens',
				'latency_ms',
				'prompt_hash',
				'prompt_text',
				'output',
				'created_at'
			].sort()
		);
		for (const c of [
			'id',
			'user_id',
			'purpose',
			'provider',
			'model',
			'status',
			'latency_ms',
			'prompt_hash',
			'created_at'
		])
			expect(by[c].is_nullable, c).toBe('NO');
		for (const c of [
			'request_id',
			'error_code',
			'prompt_tokens',
			'completion_tokens',
			'prompt_text',
			'output'
		])
			expect(by[c].is_nullable, c).toBe('YES');
		expect(by.created_at.data_type).toBe('timestamp with time zone');
		expect(by.output.data_type).toBe('jsonb');
		expect(by.user_id.data_type).toBe('text');
	});

	it('creates the FK, CHECK and both indexes under their declared names', async () => {
		const [fk] = await handle.client<{ def: string; confdeltype: string }[]>`
			SELECT pg_get_constraintdef(oid) AS def, confdeltype FROM pg_constraint
			WHERE conname = 'llm_calls_user_id_fk'`;
		expect(fk.def).toContain('REFERENCES auth."user"(id)');
		expect(fk.confdeltype).toBe('a'); // NO ACTION
		const [check] = await handle.client<{ conname: string }[]>`
			SELECT conname FROM pg_constraint WHERE conname = 'llm_calls_status_check'`;
		expect(check?.conname).toBe('llm_calls_status_check');
		const idx = await handle.client<{ indexname: string; indexdef: string }[]>`
			SELECT indexname, indexdef FROM pg_indexes
			WHERE tablename = 'llm_calls' ORDER BY indexname`;
		const defs = Object.fromEntries(idx.map((i) => [i.indexname, i.indexdef]));
		expect(Object.keys(defs)).toEqual([
			'llm_calls_pkey',
			'llm_calls_purpose_created_idx',
			'llm_calls_user_created_idx'
		]);
		expect(defs.llm_calls_user_created_idx).toContain('(user_id, created_at)');
		expect(defs.llm_calls_purpose_created_idx).toContain('(purpose, created_at)');
	});

	it('defaults id and created_at, and refuses an unknown status or owner', async () => {
		const [ok] = await db.insert(s.llmCalls).values(row()).returning();
		expect(ok.id).toMatch(/^[0-9a-f-]{36}$/);
		expect(ok.createdAt).toBeInstanceOf(Date);
		await expect(
			db.insert(s.llmCalls).values(row({ status: 'maybe' as s.LlmCallStatus }))
		).rejects.toMatchObject({ cause: { constraint_name: 'llm_calls_status_check' } });
		await expect(
			db.insert(s.llmCalls).values(row({ userId: 'no-such-user' }))
		).rejects.toMatchObject({ cause: { constraint_name: 'llm_calls_user_id_fk' } });
	});
});
