/**
 * Local days, shared by server and page code (no DB imports). A day shown to
 * the user is the day in their stored time zone (`auth.user.time_zone`, owner
 * decision 2026-11-09); a null zone is UTC. The SQL spelling is `localDayKey`
 * in `src/lib/server/user-time-zone.ts`; this is the JS spelling and matches it.
 */

/** 'YYYY-MM-DD' of an instant in `timeZone`. */
export function dayKeyIn(date: Date, timeZone: string): string {
	// en-CA formats as YYYY-MM-DD.
	return new Intl.DateTimeFormat('en-CA', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	}).format(date);
}

/** The zone to format in: the stored one, or UTC when none is stored. */
export function displayZone(timeZone: string | null | undefined): string {
	return timeZone || 'UTC';
}

/**
 * The last `count` local days ending today in `timeZone`, oldest first, with a
 * short "M/D" label. Days are stepped on UTC noon of each local date, so a
 * daylight-saving change never skips or repeats a day.
 */
export function lastLocalDays(
	count: number,
	timeZone: string,
	now: Date = new Date()
): Array<{ dateKey: string; label: string }> {
	const today = dayKeyIn(now, timeZone);
	const noon = Date.parse(`${today}T12:00:00Z`);
	const out: Array<{ dateKey: string; label: string }> = [];
	for (let i = count - 1; i >= 0; i--) {
		const dateKey = new Date(noon - i * 86_400_000).toISOString().slice(0, 10);
		out.push({ dateKey, label: `${Number(dateKey.slice(5, 7))}/${Number(dateKey.slice(8, 10))}` });
	}
	return out;
}
