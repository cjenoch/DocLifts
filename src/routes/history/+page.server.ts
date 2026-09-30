import { db } from '$lib/server/db';
import { historyForMonth } from '$lib/server/history';
import { requireUser } from '$lib/server/request-user';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url, locals }) => {
	// Month pagination via ?month=YYYY-MM; default = current month. The query
	// itself lives in historyForMonth, owner-scoped — this route used to run it
	// inline with no owner predicate and returned every user's history.
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

	const rows = await historyForMonth(db, requireUser(locals).id, rangeStart, rangeEnd);

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
