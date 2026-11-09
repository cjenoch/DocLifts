import { homeState } from '$lib/server/home';
import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { db } from '$lib/server/db';
import { historyForLocalMonth } from '$lib/server/history';
import { dayKeyIn, userTimeZone, zoneOrUtc } from '$lib/server/user-time-zone';
import {
	hardDeleteSession,
	listDeletedSessionsForUser,
	restoreSoftDeletedSession
} from '$lib/server/sessions';
import { requireUser } from '$lib/server/request-user';
import type { Actions, PageServerLoad } from './$types';

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** 'YYYY-MM' shifted by `delta` months. */
function shiftMonth(month: string, delta: number): string {
	const [y, m] = month.split('-').map(Number);
	const d = new Date(Date.UTC(y, m - 1 + delta, 1));
	return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export const load: PageServerLoad = async ({ url, locals }) => {
	const userId = requireUser(locals).id;
	// Days and months are the user's own (owner decision, 2026-11-09): the zone
	// the phone's browser reported, or UTC until it has. On a phone at 8 pm in
	// Detroit, tonight's workout is listed under today, not tomorrow.
	const timeZone = zoneOrUtc(await userTimeZone(db, userId));
	const currentMonth = dayKeyIn(new Date(), timeZone).slice(0, 7);

	// Month pagination via ?month=YYYY-MM; default = the current local month.
	// The query itself lives in historyForLocalMonth, owner-scoped — this route
	// used to run it inline with no owner predicate and returned every user's
	// history.
	const monthParam = url.searchParams.get('month');
	const month = monthParam && MONTH.test(monthParam) ? monthParam : currentMonth;

	const [rows, trash, home] = await Promise.all([
		historyForLocalMonth(db, userId, month, timeZone),
		// Trash on History (0.5.2): every trashed workout of this user, quick or
		// program, whatever the month. The quick program has no page, so this
		// is the only place a trashed quick workout can be restored from.
		listDeletedSessionsForUser(db, userId),
		homeState(db, userId)
	]);

	// Month nav links (no future months).
	const next = shiftMonth(month, 1);
	return {
		sessions: rows,
		month,
		prevMonth: shiftMonth(month, -1),
		nextMonth: next <= currentMonth ? next : null,
		timeZone,
		trashSessions: trash.sessions,
		trashCount: trash.total,
		hasWorkouts: home.hasWorkouts
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
