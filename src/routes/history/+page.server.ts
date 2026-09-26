import { and, desc, eq, gte, isNull, lt } from 'drizzle-orm';
import { db, days, programs, sessions } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url }) => {
	// Cross-program workout history. Includes sessions from INACTIVE programs
	// (old versions after duplicate-on-edit) so no session becomes unreachable
	// from the UI — audit finding 2026-09-26. Trash is excluded. Month
	// pagination via ?month=YYYY-MM; default = current month.
	const monthParam = url.searchParams.get('month');
	let rangeStart: Date;
	let rangeEnd: Date;
	if (monthParam && /^\d{4}-\d{2}$/.test(monthParam)) {
		const [y, m] = monthParam.split('-').map(Number);
		rangeStart = new Date(Date.UTC(y, m - 1, 1));
		rangeEnd = new Date(Date.UTC(y, m, 1));
	} else {
		const now = new Date();
		rangeStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
		rangeEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
	}

	const rows = await db
		.select({
			id: sessions.id,
			startedAt: sessions.startedAt,
			endedAt: sessions.endedAt,
			dayName: days.name,
			programName: programs.name,
			programIsActive: programs.isActive
		})
		.from(sessions)
		.innerJoin(days, eq(days.id, sessions.dayId))
		.innerJoin(programs, eq(programs.id, sessions.programId))
		.where(
			and(
				isNull(sessions.deletedAt),
				gte(sessions.startedAt, rangeStart),
				lt(sessions.startedAt, rangeEnd)
			)
		)
		.orderBy(desc(sessions.startedAt));

	// Month nav links (no future months).
	const prev = new Date(rangeStart);
	prev.setUTCMonth(prev.getUTCMonth() - 1);
	const fmt = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

	return {
		sessions: rows,
		month: fmt(rangeStart),
		prevMonth: fmt(prev),
		nextMonth: rangeEnd <= new Date() ? fmt(rangeEnd) : null
	};
};
