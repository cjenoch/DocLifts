import { and, count, desc, eq, gte, lt, sql, type SQL } from 'drizzle-orm';
import { days, importedWorkouts, programs, sessions, workoutLogImports } from './db/schema';
import type { Database } from './progression';
import { sessionIs } from './workout-state-sql';
import { utcWallOfLocal } from './user-time-zone';

/**
 * Reads behind `/history` and `/imported-history`.
 *
 * Both routes used to query `db` inline with no owner predicate at all, so
 * each showed every user their whole training archive. They are here now,
 * scoped, with the id supplied only by `requireUser(locals).id` at the route.
 */

/**
 * Cross-program workout history, including sessions from INACTIVE programs
 * (old versions after duplicate-on-edit) so no session becomes unreachable
 * from the UI — audit finding 2026-09-26. Trash is excluded.
 *
 * `sessions` carries its own user_id, so it is filtered directly; the joined
 * program is not relied on to scope it.
 *
 * Quick workouts (0.5.1) are included: their hidden program is joined like
 * any other, and `systemKind` tells the page to label them.
 */
export async function historyForMonth(
	db: Database,
	userId: string,
	rangeStart: Date,
	rangeEnd: Date
) {
	return historyBetween(
		db,
		userId,
		gte(sessions.startedAt, rangeStart),
		lt(sessions.startedAt, rangeEnd)
	);
}

/**
 * The workouts of one calendar month in the user's own time zone (owner
 * decision, 2026-11-09): `month` is 'YYYY-MM', `timeZone` an IANA name
 * already validated by user-time-zone.ts ('UTC' when none is stored). The
 * bounds are the local month's first instant and the next month's, turned
 * into UTC wall time in SQL, so they compare with `started_at` (UTC wall
 * time) whatever the server's TimeZone is.
 */
export async function historyForLocalMonth(
	db: Database,
	userId: string,
	month: string,
	timeZone: string
) {
	const [y, m] = month.split('-').map(Number);
	const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
	return historyBetween(
		db,
		userId,
		sql`${sessions.startedAt} >= ${utcWallOfLocal(`${month}-01 00:00:00`, timeZone)}`,
		sql`${sessions.startedAt} < ${utcWallOfLocal(`${next}-01 00:00:00`, timeZone)}`
	);
}

function historyBetween(db: Database, userId: string, from: SQL, to: SQL) {
	return db
		.select({
			id: sessions.id,
			startedAt: sessions.startedAt,
			endedAt: sessions.endedAt,
			deletedAt: sessions.deletedAt,
			dayName: days.name,
			programName: programs.name,
			programIsActive: programs.isActive,
			// 'quick' for a workout started with no program (0.5.1); the page
			// labels those from workout-ui.ts instead of naming the program.
			systemKind: programs.systemKind
		})
		.from(sessions)
		.innerJoin(days, eq(days.id, sessions.dayId))
		.innerJoin(programs, eq(programs.id, sessions.programId))
		.where(and(eq(sessions.userId, userId), sessionIs.notTrashed(), from, to))
		.orderBy(desc(sessions.startedAt));
}

// This page is a client-side searchable archive (text search spans the jsonb
// `lines`, plus an "all months" view), so it can't page by month server-side
// the way /history does. Bound the query instead: the most recent
// IMPORT_LIMIT workouts (undated last) plus the total, so the UI can disclose
// the cap instead of silently dropping records.
export const IMPORT_LIMIT = 500;

/**
 * `imported_workouts` has no user_id column: it is owned through
 * `import_id` -> `workout_log_imports.user_id`. The join is what scopes it,
 * so the predicate sits on the import row in the same query rather than being
 * pre-checked by a separate lookup.
 */
export async function importedWorkoutsForOwner(db: Database, userId: string) {
	// Explicit column list rather than select(): the join makes the row shape
	// nested under the table name, which would change what the page component
	// receives. The page has always seen a flat imported_workouts row.
	const [workouts, [{ total }]] = await Promise.all([
		db
			.select({
				id: importedWorkouts.id,
				importId: importedWorkouts.importId,
				sourceLine: importedWorkouts.sourceLine,
				workoutDate: importedWorkouts.workoutDate,
				earliestDate: importedWorkouts.earliestDate,
				latestDate: importedWorkouts.latestDate,
				title: importedWorkouts.title,
				gym: importedWorkouts.gym,
				dateNote: importedWorkouts.dateNote,
				lines: importedWorkouts.lines
			})
			.from(importedWorkouts)
			.innerJoin(workoutLogImports, eq(workoutLogImports.id, importedWorkouts.importId))
			.where(eq(workoutLogImports.userId, userId))
			.orderBy(
				sql`${importedWorkouts.workoutDate} DESC NULLS LAST`,
				desc(importedWorkouts.sourceLine)
			)
			.limit(IMPORT_LIMIT),
		db
			.select({ total: count() })
			.from(importedWorkouts)
			.innerJoin(workoutLogImports, eq(workoutLogImports.id, importedWorkouts.importId))
			.where(eq(workoutLogImports.userId, userId))
	]);
	return { workouts, total, limit: IMPORT_LIMIT };
}
