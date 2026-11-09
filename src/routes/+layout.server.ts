import { db } from '$lib/server/db';
import { userTimeZone } from '$lib/server/user-time-zone';

/**
 * Supplies page data only. The auth GUARD is in src/hooks.server.ts `handle`,
 * not here: a form action executes before any `load`, so a guard in the
 * layout runs after every write has already happened. See hooks.server.ts.
 *
 * `timeZone` is the stored zone (null until the phone has reported one), so
 * +layout.svelte posts the browser's zone only when it differs.
 */
export async function load({ locals }: { locals: App.Locals }) {
	const user = locals.user ?? null;
	return {
		user,
		timeZone: user ? await userTimeZone(db, user.id) : null
	};
}
