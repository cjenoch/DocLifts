import { and, count, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { db, exercises, sessions, sets } from '$lib/server/db';
import type { PageServerLoad } from './$types';

const DAY_MS = 86_400_000;

export const load: PageServerLoad = async () => {
	const [sessionCounts] = await db
		.select({
			totalNotDeleted: count(sessions.id),
			endedNotDeleted: count(sql`CASE WHEN ${sessions.endedAt} IS NOT NULL THEN 1 END`),
			openNotDeleted: count(sql`CASE WHEN ${sessions.endedAt} IS NULL THEN 1 END`),
		})
		.from(sessions)
		.where(isNull(sessions.deletedAt));

	const [setCounts] = await db
		.select({
			totalInEndedSessions: count(sets.id),
			completedInEndedSessions: count(
				sql`CASE WHEN ${sets.executedLoad} IS NOT NULL AND ${sets.executedReps} IS NOT NULL THEN 1 END`
			),
		})
		.from(sets)
		.innerJoin(sessions, eq(sessions.id, sets.sessionId))
		.where(and(isNull(sessions.deletedAt), isNotNull(sessions.endedAt)));

	const completed = setCounts.completedInEndedSessions ?? 0;
	const totalEndedSetRows = setCounts.totalInEndedSessions ?? 0;
	const completionRatePct =
		totalEndedSetRows > 0 ? Math.round((completed / totalEndedSetRows) * 1000) / 10 : 0;

	const recentSessions = await db
		.select({
			id: sessions.id,
			startedAt: sessions.startedAt,
			endedAt: sessions.endedAt,
			totalSets: count(sets.id),
			completedSets: count(
				sql`CASE WHEN ${sets.executedLoad} IS NOT NULL AND ${sets.executedReps} IS NOT NULL THEN 1 END`
			),
		})
		.from(sessions)
		.leftJoin(sets, eq(sets.sessionId, sessions.id))
		.where(and(isNull(sessions.deletedAt), isNotNull(sessions.endedAt)))
		.groupBy(sessions.id)
		.orderBy(desc(sessions.startedAt))
		.limit(10);

	const recentTrend = recentSessions.map((s) => ({
		sessionId: s.id,
		startedAt: s.startedAt,
		totalSets: s.totalSets,
		completedSets: s.completedSets,
		completionPct:
			s.totalSets > 0 ? Math.round((Number(s.completedSets) / Number(s.totalSets)) * 1000) / 10 : 0,
	}));

	const now = new Date();
	const consistency: Array<{ dateKey: string; count: number }> = [];
	for (let i = 13; i >= 0; i--) {
		const d = new Date(now.getTime() - i * DAY_MS);
		consistency.push({ dateKey: d.toISOString().slice(0, 10), count: 0 });
	}
	const byDate = new Map(consistency.map((d) => [d.dateKey, d]));
	const consistencyRows = await db
		.select({
			dateKey: sql<string>`to_char(${sessions.startedAt} at time zone 'UTC', 'YYYY-MM-DD')`,
			count: count(sessions.id),
		})
		.from(sessions)
		.where(
			and(
				isNull(sessions.deletedAt),
				isNotNull(sessions.endedAt),
				sql`${sessions.startedAt} >= now() - interval '14 days'`
			)
		)
		.groupBy(sql`to_char(${sessions.startedAt} at time zone 'UTC', 'YYYY-MM-DD')`);
	for (const row of consistencyRows) {
		const bucket = byDate.get(row.dateKey);
		if (bucket) bucket.count = Number(row.count);
	}

	const topExercises = await db
		.select({
			exerciseName: exercises.name,
			completedSetRows: count(sets.id),
		})
		.from(sets)
		.innerJoin(sessions, eq(sessions.id, sets.sessionId))
		.innerJoin(exercises, eq(exercises.id, sets.exerciseId))
		.where(
			and(
				isNull(sessions.deletedAt),
				isNotNull(sessions.endedAt),
				isNotNull(sets.executedLoad),
				isNotNull(sets.executedReps)
			)
		)
		.groupBy(exercises.name)
		.orderBy(desc(count(sets.id)))
		.limit(10);

	const [windowCounts] = await db
		.select({
			last7: count(sql`CASE WHEN ${sessions.startedAt} >= now() - interval '7 days' THEN 1 END`),
			last28: count(sql`CASE WHEN ${sessions.startedAt} >= now() - interval '28 days' THEN 1 END`),
		})
		.from(sessions)
		.where(and(isNull(sessions.deletedAt), isNotNull(sessions.endedAt)));

	return {
		overview: {
			totalSessions: sessionCounts.totalNotDeleted,
			endedSessions: sessionCounts.endedNotDeleted,
			openSessions: sessionCounts.openNotDeleted,
			totalEndedSetRows,
			completedEndedSetRows: completed,
			completionRatePct,
			last7Sessions: windowCounts.last7,
			last28Sessions: windowCounts.last28,
		},
		consistency,
		recentTrend,
		topExercises,
	};
};
