import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { setupTestDb, resetTestDb, type TestDb } from '$lib/server/test-db';
import { startSessionForDay } from '$lib/server/sessions';

const testDb = vi.hoisted(() => ({ db: null as TestDb | null }));
vi.mock('$lib/server/db', async () => {
	const schema = await import('$lib/server/db/schema');
	return {
		get db() {
			return testDb.db;
		},
		...schema
	};
});

import { load } from './+page.server';
import * as s from '$lib/server/db/schema';

let harness: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
	harness = await setupTestDb();
	testDb.db = harness.db;
});
beforeEach(async () => {
	await resetTestDb(harness.client);
});
afterAll(async () => {
	await harness?.end();
});

type HistoryData = {
	month: string;
	prevMonth: string;
	nextMonth: string | null;
	sessions: { id: string }[];
};
const call = async (month: string | null): Promise<HistoryData> => {
	const url = new URL('http://test.local/history');
	if (month !== null) url.searchParams.set('month', month);
	const result = await load({ url } as Parameters<typeof load>[0]);
	if (!result || typeof result !== 'object') throw new Error('history load returned nothing');
	return result as unknown as HistoryData;
};

async function sessionInMonth(year: number, monthIndex: number) {
	const db = testDb.db!;
	const [program] = await db.insert(s.programs).values({ name: 'P' }).returning();
	const [day] = await db
		.insert(s.days)
		.values({ programId: program.id, name: 'D', position: 1 })
		.returning();
	const started = await startSessionForDay(db, day.id);
	if (!started.ok) throw new Error(started.message);
	await db
		.update(s.sessions)
		.set({ startedAt: new Date(Date.UTC(year, monthIndex, 15, 12)) })
		.where(eq(s.sessions.id, started.sessionId));
	return started.sessionId;
}

it('honours a valid ?month=YYYY-MM parameter', async () => {
	const result = await call('2026-01');
	expect(result.month).toBe('2026-01');
	expect(result.prevMonth).toBe('2025-12');
	expect(result.nextMonth).toBe('2026-02');
});

it('falls back to the current month for a malformed month parameter', async () => {
	const result = await call('january');
	const now = new Date();
	const expected = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
	expect(result.month).toBe(expected);
});

it('falls back to the current month when the parameter is absent', async () => {
	const result = await call(null);
	const now = new Date();
	const expected = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
	expect(result.month).toBe(expected);
});

it('only returns sessions started within the requested month', async () => {
	const sessionId = await sessionInMonth(2026, 0);
	const january = await call('2026-01');
	expect(january.sessions.map((r) => r.id)).toContain(sessionId);
	const february = await call('2026-02');
	expect(february.sessions.map((r) => r.id)).not.toContain(sessionId);
});
