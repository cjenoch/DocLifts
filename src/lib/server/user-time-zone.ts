import { eq, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { authUsers } from './db/auth-schema';
import type { Database } from './progression';

/**
 * The user's own time zone, for the days a person sees (owner decision,
 * 2026-11-09). An 8 pm Detroit workout is a workout of that day, not of the
 * next UTC day.
 *
 * How this is used on a phone: nobody types a zone. The root layout reads
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` from the phone's browser
 * and posts it to `/account/time-zone` only when it differs from the stored
 * value, so travelling with the phone moves the days with it.
 *
 * `auth."user".time_zone` (0025) is NULL until the browser has reported one,
 * and NULL means UTC: exactly the behaviour before this change. It is not a
 * Better Auth field; this module is its only reader and writer.
 */

export const DEFAULT_TIME_ZONE = 'UTC';
export const TIME_ZONE_MAX_LENGTH = 64;

/**
 * IANA names only: `Area/Location[/More]`, or a bare name such as `UTC`.
 * Intl (Node 24) also accepts offset zones like `+05:00`, and Postgres reads
 * a bare offset with the POSIX sign flipped, so the two would disagree by
 * twice the offset. A leading sign or digit is therefore refused outright.
 */
const IANA_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/;

/** True when `value` is a zone name both Intl and this module accept. */
export function isAcceptableTimeZone(value: unknown): value is string {
	if (typeof value !== 'string') return false;
	if (value.length < 1 || value.length > TIME_ZONE_MAX_LENGTH) return false;
	if (!IANA_SHAPE.test(value)) return false;
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: value });
		return true;
	} catch {
		return false;
	}
}

/** A stored zone, or UTC when there is none (or it no longer validates). */
export function zoneOrUtc(stored: string | null | undefined): string {
	return stored && isAcceptableTimeZone(stored) ? stored : DEFAULT_TIME_ZONE;
}

/** The stored zone name, or null when the browser has not reported one. */
export async function userTimeZone(db: Database, userId: string): Promise<string | null> {
	const [row] = await db
		.select({ timeZone: authUsers.timeZone })
		.from(authUsers)
		.where(eq(authUsers.id, userId))
		.limit(1);
	return row?.timeZone ?? null;
}

export type SetTimeZoneResult =
	| { ok: true; timeZone: string; changed: boolean }
	| { ok: false; status: 400 | 404; message: string };

/**
 * Store the caller's own zone. Owner-scoped by the WHERE on `userId`; no
 * other row can be reached. Refuses, storing nothing, a value Intl rejects,
 * an offset zone, anything over 64 characters, or a name the database's own
 * zone table does not know (the queries below hand it to `AT TIME ZONE`, so
 * a name Intl knows and Postgres does not would turn History into a 500).
 */
export async function setUserTimeZone(
	db: Database,
	userId: string,
	timeZone: unknown
): Promise<SetTimeZoneResult> {
	if (!isAcceptableTimeZone(timeZone)) {
		return { ok: false, status: 400, message: 'Unknown time zone' };
	}
	try {
		await db.execute(sql`select (now() at time zone ${timeZone}) as probe`);
	} catch {
		return { ok: false, status: 400, message: 'Unknown time zone' };
	}
	const current = await userTimeZone(db, userId);
	if (current === timeZone) return { ok: true, timeZone, changed: false };
	const updated = await db
		.update(authUsers)
		.set({ timeZone })
		.where(eq(authUsers.id, userId))
		.returning({ id: authUsers.id });
	if (updated.length === 0) return { ok: false, status: 404, message: 'Not found' };
	return { ok: true, timeZone, changed: true };
}

// ---------------------------------------------------------------------------
// SQL for local days.
//
// `sessions.started_at` and its siblings are timestamp WITHOUT time zone
// holding UTC wall time. `col AT TIME ZONE 'UTC'` reads that wall time as UTC
// and yields an instant (timestamptz); `instant AT TIME ZONE $tz` yields the
// wall time in `$tz` (timestamp). Neither step consults the session's
// TimeZone setting, and neither does `to_char` of a plain timestamp, so the
// day is the same whatever the database server's TimeZone is. With $tz = 'UTC'
// the expression is the column itself: a NULL zone behaves exactly as before.
// ---------------------------------------------------------------------------

/** The column's wall time in `timeZone` (a timestamp without time zone). */
export function localWallTime(utcWallColumn: AnyPgColumn, timeZone: string): SQL {
	return sql`((${utcWallColumn} at time zone 'UTC') at time zone ${timeZone})`;
}

/** 'YYYY-MM-DD' of the column's local day in `timeZone`. */
export function localDayKey(utcWallColumn: AnyPgColumn, timeZone: string): SQL<string> {
	return sql<string>`to_char(${localWallTime(utcWallColumn, timeZone)}, 'YYYY-MM-DD')`;
}

/**
 * The UTC wall time at which a local wall time (`'YYYY-MM-DD HH:MM:SS'`)
 * occurs in `timeZone`. Used for month bounds.
 */
export function utcWallOfLocal(localWall: string, timeZone: string): SQL {
	return sql`((${localWall}::timestamp at time zone ${timeZone}) at time zone 'UTC')`;
}

/** 'YYYY-MM-DD' of an instant in `timeZone`, in JS (matches the SQL above). */
export { dayKeyIn } from '$lib/local-day';
