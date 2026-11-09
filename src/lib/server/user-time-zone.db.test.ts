import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { setupTestDb, resetTestDbWithUsers, withTwoUsers, type TestDb } from './test-db';
import * as schema from './db/schema';
import { authUsers } from './db/schema';
import { historyForLocalMonth } from './history';
import { reportSnapshot } from './machine-reports';
import { dayKeyIn, setUserTimeZone, userTimeZone, zoneOrUtc } from './user-time-zone';

// The user's own days (owner decision, 2026-11-09). How this is used on a
// phone: the browser reports its zone once, and History and Reports then show
// an 8 pm Detroit workout on the day it happened, not on the next UTC day.

let h: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
	h = await setupTestDb();
});
afterAll(async () => {
	await h?.end();
});
beforeEach(async () => {
	await resetTestDbWithUsers(h.db, h.client, 0);
});

const storedZone = async (db: TestDb, userId: string) =>
	(await db.select({ tz: authUsers.timeZone }).from(authUsers).where(eq(authUsers.id, userId)))[0]
		?.tz;

/**
 * A Drizzle client on its own connections with the session TimeZone set, so
 * the day arithmetic is checked against a database server that is not on UTC.
 * Its own pool: SET on the shared pool would reach only one connection.
 */
function dbInServerZone(serverZone: string) {
	const url = process.env.TEST_DATABASE_URL!;
	const client = postgres(url, {
		max: 2,
		onnotice: () => {},
		connection: { TimeZone: serverZone }
	});
	return { db: drizzle(client, { schema }) as unknown as TestDb, end: () => client.end() };
}

/** An ended workout of `userId`, its times written by Drizzle (UTC wall time). */
async function endedWorkoutAt(db: TestDb, userId: string, startedIso: string) {
	const [p] = await db.insert(schema.programs).values({ userId, name: 'P' }).returning();
	const [d] = await db
		.insert(schema.days)
		.values({ programId: p.id, name: 'D', position: 1 })
		.returning();
	const started = new Date(startedIso);
	const [session] = await db
		.insert(schema.sessions)
		.values({
			userId,
			programId: p.id,
			dayId: d.id,
			startedAt: started,
			endedAt: new Date(started.getTime() + 15 * 60_000)
		})
		.returning();
	return session.id;
}

describe('setUserTimeZone', () => {
	it('stores a zone the browser reports, and refuses anything else storing nothing', async () => {
		const { alice } = await withTwoUsers(h.db);
		// Positive first.
		expect(await setUserTimeZone(h.db, alice, 'America/Detroit')).toEqual({
			ok: true,
			timeZone: 'America/Detroit',
			changed: true
		});
		expect(await storedZone(h.db, alice)).toBe('America/Detroit');
		expect(await userTimeZone(h.db, alice)).toBe('America/Detroit');

		for (const bad of [
			'Mars/Olympus_Mons',
			'+05:00',
			'-0400',
			'',
			'America/' + 'x'.repeat(60),
			"UTC'; drop table sessions; --",
			123,
			null
		]) {
			const result = await setUserTimeZone(h.db, alice, bad);
			expect(result, String(bad)).toMatchObject({ ok: false, status: 400 });
			expect(await storedZone(h.db, alice), String(bad)).toBe('America/Detroit');
		}
	});

	it('leaves an unknown zone NULL when the first report is refused', async () => {
		const { alice } = await withTwoUsers(h.db);
		expect(await setUserTimeZone(h.db, alice, 'Not/AZone')).toMatchObject({ ok: false });
		expect(await storedZone(h.db, alice)).toBeNull();
		expect(zoneOrUtc(await userTimeZone(h.db, alice))).toBe('UTC');
	});

	it("writes only the caller's own row", async () => {
		const { alice, bob } = await withTwoUsers(h.db);
		// Positive first: Alice's row changes.
		expect(await setUserTimeZone(h.db, alice, 'America/Detroit')).toMatchObject({ ok: true });
		expect(await storedZone(h.db, alice)).toBe('America/Detroit');
		expect(await storedZone(h.db, bob)).toBeNull();
		// Bob's write changes Bob's row and leaves Alice's as it was.
		expect(await setUserTimeZone(h.db, bob, 'America/Chicago')).toMatchObject({ ok: true });
		expect(await storedZone(h.db, bob)).toBe('America/Chicago');
		expect(await storedZone(h.db, alice)).toBe('America/Detroit');
	});

	it('refuses an id with no user, writing nothing', async () => {
		const { alice } = await withTwoUsers(h.db);
		expect(await setUserTimeZone(h.db, alice, 'UTC')).toMatchObject({ ok: true });
		expect(
			await setUserTimeZone(h.db, '00000000-0000-4000-8000-00000000dead', 'America/Detroit')
		).toMatchObject({ ok: false, status: 404 });
		expect(await storedZone(h.db, alice)).toBe('UTC');
	});
});

// Each case runs with the database server on a zone west and east of
// Greenwich: a day that moved with the server's TimeZone would differ between
// the two, and from the expectation in at least one.
describe.each(['America/Los_Angeles', 'Asia/Tokyo'])('with the server on %s', (serverZone) => {
	let zoned: ReturnType<typeof dbInServerZone>;
	beforeAll(() => {
		zoned = dbInServerZone(serverZone);
	});
	afterAll(async () => {
		await zoned?.end();
	});

	it('the client really is on that zone', async () => {
		const [row] = await zoned.db.execute<Record<string, string>>(sql`show timezone`);
		expect(Object.values(row)[0]).toBe(serverZone);
	});

	it('History puts 00:30 UTC Nov 1 in October for Detroit and in November for UTC', async () => {
		const { alice, bob } = await withTwoUsers(zoned.db);
		await setUserTimeZone(zoned.db, alice, 'America/Detroit');
		const a = await endedWorkoutAt(zoned.db, alice, '2026-11-01T00:30:00Z');
		const b = await endedWorkoutAt(zoned.db, bob, '2026-11-01T00:30:00Z');
		const tzA = zoneOrUtc(await userTimeZone(zoned.db, alice));
		const tzB = zoneOrUtc(await userTimeZone(zoned.db, bob));
		expect([tzA, tzB]).toEqual(['America/Detroit', 'UTC']);
		// Positive first, both directions.
		expect((await historyForLocalMonth(zoned.db, alice, '2026-10', tzA)).map((r) => r.id)).toEqual([
			a
		]);
		expect(await historyForLocalMonth(zoned.db, alice, '2026-11', tzA)).toEqual([]);
		expect((await historyForLocalMonth(zoned.db, bob, '2026-11', tzB)).map((r) => r.id)).toEqual([
			b
		]);
		expect(await historyForLocalMonth(zoned.db, bob, '2026-10', tzB)).toEqual([]);
	});

	it('History labels 00:30 UTC Nov 9 as Nov 8 for Detroit and Nov 9 for NULL', async () => {
		const { alice, bob } = await withTwoUsers(zoned.db);
		await setUserTimeZone(zoned.db, alice, 'America/Detroit');
		await endedWorkoutAt(zoned.db, alice, '2026-11-09T00:30:00Z');
		await endedWorkoutAt(zoned.db, bob, '2026-11-09T00:30:00Z');
		const tzA = zoneOrUtc(await userTimeZone(zoned.db, alice));
		const tzB = zoneOrUtc(await userTimeZone(zoned.db, bob));
		const [rowA] = await historyForLocalMonth(zoned.db, alice, '2026-11', tzA);
		const [rowB] = await historyForLocalMonth(zoned.db, bob, '2026-11', tzB);
		// The instant read back is the one written, whatever the server zone.
		expect(rowA.startedAt.toISOString()).toBe('2026-11-09T00:30:00.000Z');
		expect(dayKeyIn(rowA.startedAt, tzA)).toBe('2026-11-08');
		expect(dayKeyIn(rowB.startedAt, tzB)).toBe('2026-11-09');
	});

	it("Reports bucket by the user's day and count local calendar windows", async () => {
		const { alice, bob } = await withTwoUsers(zoned.db);
		await setUserTimeZone(zoned.db, alice, 'America/Detroit');
		for (const user of [alice, bob]) {
			// 19:30 EST on Nov 8 in Detroit.
			await endedWorkoutAt(zoned.db, user, '2026-11-09T00:30:00Z');
			// 22:00 EST on Nov 2: outside Detroit's last 7 days (Nov 3-9), inside
			// UTC's (Nov 3 03:00 is on Nov 3).
			await endedWorkoutAt(zoned.db, user, '2026-11-03T03:00:00Z');
		}
		vi.useFakeTimers({ toFake: ['Date'] });
		// 07:00 EST Nov 9: today is Nov 9 in both zones.
		vi.setSystemTime(new Date('2026-11-09T12:00:00Z'));
		try {
			const detroit = await reportSnapshot(zoned.db, alice);
			const utc = await reportSnapshot(zoned.db, bob);
			const cells = (r: typeof detroit) =>
				Object.fromEntries(
					r.consistency.filter((c) => c.count > 0).map((c) => [c.dateKey, c.count])
				);

			// Positive first: each user's strip has both workouts, on their own days.
			expect(detroit.timeZone).toBe('America/Detroit');
			expect(cells(detroit)).toEqual({ '2026-11-02': 1, '2026-11-08': 1 });
			expect(detroit.consistency.at(-1)).toEqual({ dateKey: '2026-11-09', count: 0 });
			expect(detroit.overview).toMatchObject({ last7Sessions: 1, last28Sessions: 2 });

			expect(utc.timeZone).toBe('UTC');
			expect(cells(utc)).toEqual({ '2026-11-03': 1, '2026-11-09': 1 });
			expect(utc.consistency.at(-1)).toEqual({ dateKey: '2026-11-09', count: 1 });
			expect(utc.overview).toMatchObject({ last7Sessions: 2, last28Sessions: 2 });
		} finally {
			vi.useRealTimers();
		}
	});
});
