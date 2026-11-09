import { and, count, desc, eq, sql } from 'drizzle-orm';
import { days, exercises, programs, sessionExercises, sessions, sets } from './db/schema';
import type { Database } from './progression';
import { historyFilter, sessionIs, setIs } from './workout-state-sql';
import { dayKeyIn, localDayKey, userTimeZone, utcWallOfLocal, zoneOrUtc } from './user-time-zone';
export async function topExerciseIdentities(db: Database, userId: string) {
	const exerciseName = sql<string>`coalesce(${sessionExercises.exerciseName}, ${exercises.name})`;
	return db
		.select({
			exerciseName,
			exerciseId: sets.exerciseId,
			gymEquipmentId: sets.gymEquipmentId,
			loadConvention: sets.loadConvention,
			machineLabel: sessionExercises.machineLabel,
			gymName: sessionExercises.gymName,
			completedSetRows: count(sets.id)
		})
		.from(sets)
		.innerJoin(sessions, eq(sessions.id, sets.sessionId))
		.innerJoin(exercises, eq(exercises.id, sets.exerciseId))
		.leftJoin(sessionExercises, eq(sessionExercises.id, sets.sessionExerciseId))
		.where(
			and(
				// `sets` carries its own user_id, so it filters directly rather
				// than relying on the joined session being scoped.
				eq(sets.userId, userId),
				historyFilter()
			)
		)
		.groupBy(
			sets.exerciseId,
			sets.gymEquipmentId,
			sets.loadConvention,
			exerciseName,
			sessionExercises.machineLabel,
			sessionExercises.gymName
		)
		.orderBy(desc(count(sets.id)))
		.limit(10);
}

const DAY_MS = 86_400_000;

// Every read behind /reports. The route used to run six of these inline with
// no owner predicate anywhere, so the page counted the whole database. Moved
// here and scoped; `requireUser(locals).id` is the only source of the id.
//
// Days are the user's own (owner decision, 2026-11-09): the zone the phone's
// browser reported (user-time-zone.ts), or UTC while none is stored, which is
// exactly the behaviour before. `sessions.started_at` is a timestamp WITHOUT
// time zone holding UTC wall time, so its local day is
// `to_char((started_at at time zone 'UTC') at time zone $tz, ...)`, and a
// window starts at the UTC wall time of a local midnight. None of it reads
// the server's TimeZone: PR #63 found `started_at at time zone 'UTC'` alone
// re-rendered through it and moved evening workouts west of Greenwich to the
// day before. "Last N days" are the N local calendar days ending today, the
// same days the 14-day strip shows.
export async function reportSnapshot(db: Database, userId: string) {
	const timeZone = zoneOrUtc(await userTimeZone(db, userId));
	const startedLocalDay = localDayKey(sessions.startedAt, timeZone);
	const [sessionCounts] = await db
		.select({
			totalNotDeleted: count(sessions.id),
			// Counted over not-trashed rows only (the WHERE), so these are exactly
			// the ended and open phases.
			endedNotDeleted: count(sql`CASE WHEN ${sessionIs.ended()} THEN 1 END`),
			openNotDeleted: count(sql`CASE WHEN ${sessionIs.open()} THEN 1 END`)
		})
		.from(sessions)
		.where(and(eq(sessions.userId, userId), sessionIs.notTrashed()));

	const [setCounts] = await db
		.select({
			totalInEndedSessions: count(sets.id),
			completedInEndedSessions: count(sql`CASE WHEN ${setIs.completed()} THEN 1 END`)
		})
		.from(sets)
		.innerJoin(sessions, eq(sessions.id, sets.sessionId))
		.where(and(eq(sets.userId, userId), sessionIs.ended()));

	const completed = setCounts.completedInEndedSessions ?? 0;
	const totalEndedSetRows = setCounts.totalInEndedSessions ?? 0;
	const completionRatePct =
		totalEndedSetRows > 0 ? Math.round((completed / totalEndedSetRows) * 1000) / 10 : 0;

	const recentSessions = await db
		.select({
			id: sessions.id,
			startedAt: sessions.startedAt,
			endedAt: sessions.endedAt,
			dayName: days.name,
			systemKind: programs.systemKind,
			totalSets: count(sets.id),
			completedSets: count(sql`CASE WHEN ${setIs.completed()} THEN 1 END`)
		})
		.from(sessions)
		// Joined for the label only: the session's own user_id scopes the read.
		.innerJoin(days, eq(days.id, sessions.dayId))
		.innerJoin(programs, eq(programs.id, sessions.programId))
		.leftJoin(sets, eq(sets.sessionId, sessions.id))
		.where(and(eq(sessions.userId, userId), sessionIs.ended()))
		.groupBy(sessions.id, days.name, programs.systemKind)
		.orderBy(desc(sessions.startedAt))
		.limit(10);

	const recentTrend = recentSessions.map((s) => ({
		sessionId: s.id,
		startedAt: s.startedAt,
		// Quick workouts (0.5.1) are labelled on the page from workout-ui.ts.
		dayName: s.dayName,
		quick: s.systemKind === 'quick',
		totalSets: s.totalSets,
		completedSets: s.completedSets,
		completionPct:
			s.totalSets > 0 ? Math.round((Number(s.completedSets) / Number(s.totalSets)) * 1000) / 10 : 0
	}));

	// Today's local date in the user's zone, and the 14 local days ending
	// today. Each window below starts at the UTC wall time of one of these
	// local midnights, so the strip and the 7/28-day counts share one clock.
	const todayUtc = Date.parse(`${dayKeyIn(new Date(), timeZone)}T00:00:00Z`);
	const localDayAgo = (n: number) => new Date(todayUtc - n * DAY_MS).toISOString().slice(0, 10);
	const startOfLocalDayAgo = (n: number) => utcWallOfLocal(`${localDayAgo(n)} 00:00:00`, timeZone);
	const consistency: Array<{ dateKey: string; count: number }> = [];
	for (let i = 13; i >= 0; i--) consistency.push({ dateKey: localDayAgo(i), count: 0 });
	const byDate = new Map(consistency.map((d) => [d.dateKey, d]));
	const consistencyRows = await db
		.select({
			dateKey: startedLocalDay,
			count: count(sessions.id)
		})
		.from(sessions)
		.where(
			and(
				eq(sessions.userId, userId),
				sessionIs.ended(),
				sql`${sessions.startedAt} >= ${startOfLocalDayAgo(13)}`
			)
		)
		// By position: the zone is a bound parameter, so the same expression
		// written twice is two parameters, and Postgres will not match them.
		.groupBy(sql`1`);
	for (const row of consistencyRows) {
		const bucket = byDate.get(row.dateKey);
		if (bucket) bucket.count = Number(row.count);
	}

	const topExercises = await topExerciseIdentities(db, userId);

	const [windowCounts] = await db
		.select({
			last7: count(sql`CASE WHEN ${sessions.startedAt} >= ${startOfLocalDayAgo(6)} THEN 1 END`),
			last28: count(sql`CASE WHEN ${sessions.startedAt} >= ${startOfLocalDayAgo(27)} THEN 1 END`)
		})
		.from(sessions)
		.where(and(eq(sessions.userId, userId), sessionIs.ended()));

	return {
		timeZone,
		overview: {
			totalSessions: sessionCounts.totalNotDeleted,
			endedSessions: sessionCounts.endedNotDeleted,
			openSessions: sessionCounts.openNotDeleted,
			totalEndedSetRows,
			completedEndedSetRows: completed,
			completionRatePct,
			last7Sessions: windowCounts.last7,
			last28Sessions: windowCounts.last28
		},
		consistency,
		recentTrend,
		topExercises
	};
}
