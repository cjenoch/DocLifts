import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { db } from '$lib/server/db';
import { historyForMonth } from '$lib/server/history';
import {
	hardDeleteSession,
	listDeletedSessionsForUser,
	restoreSoftDeletedSession
} from '$lib/server/sessions';
import { requireUser } from '$lib/server/request-user';
import type { Actions, PageServerLoad } from './$types';

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

	const userId = requireUser(locals).id;
	const [rows, trash] = await Promise.all([
		historyForMonth(db, userId, rangeStart, rangeEnd),
		// Trash on History (0.5.2): every trashed workout of this user, quick or
		// program, whatever the month. The quick program has no page, so this
		// is the only place a trashed quick workout can be restored from.
		listDeletedSessionsForUser(db, userId)
	]);

	// Month nav links (no future months).
	const prev = new Date(rangeStart);
	prev.setUTCMonth(prev.getUTCMonth() - 1);
	const fmt = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

	return {
		sessions: rows,
		month: fmt(rangeStart),
		prevMonth: fmt(prev),
		nextMonth: rangeEnd <= new Date() ? fmt(rangeEnd) : null,
		trashSessions: trash.sessions,
		trashCount: trash.total
	};
};

// The same schemas as the program page's restoreSession and
// permanentDeleteSession, so both Trash lists confirm the same way.
const restoreSessionSchema = z.object({
	sessionId: z.string().uuid()
});

const permanentDeleteSchema = z.object({
	sessionId: z.string().uuid(),
	confirmDelete: z.preprocess((v) => (typeof v === 'string' ? v.toLowerCase() : v), z.literal('d'))
});

export const actions: Actions = {
	// Both actions call the owner-scoped by-id functions the program page
	// calls. They need no program here: the owner predicate is inside each
	// function, and another user's session is a 404 with nothing written (D6).
	restoreSession: async ({ request, locals }) => {
		const form = await request.formData();
		const parsed = restoreSessionSchema.safeParse({ sessionId: form.get('sessionId') });
		if (!parsed.success) {
			return fail(400, { message: 'Invalid session id' });
		}
		const result = await restoreSoftDeletedSession(
			db,
			requireUser(locals).id,
			parsed.data.sessionId
		);
		if (!result.ok) {
			return fail(result.status, { message: result.message });
		}
		return { ok: true };
	},

	permanentDeleteSession: async ({ request, locals }) => {
		const form = await request.formData();
		const parsed = permanentDeleteSchema.safeParse({
			sessionId: form.get('sessionId'),
			confirmDelete: form.get('confirmDelete')
		});
		if (!parsed.success) {
			return fail(400, { message: 'Press d in the permanent delete box to confirm' });
		}
		const result = await hardDeleteSession(db, requireUser(locals).id, parsed.data.sessionId);
		if (!result.ok) {
			return fail(result.status, { message: result.message });
		}
		return { ok: true };
	}
};
