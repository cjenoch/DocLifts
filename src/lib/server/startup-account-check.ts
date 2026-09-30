/**
 * Startup warning when nothing can sign in.
 *
 * WHY THIS EXISTS
 * ---------------
 * Migration 0011 backfills every pre-existing row to one placeholder owner, the
 * sentinel. Until `pnpm user:bootstrap` claims it, the app boots, serves pages,
 * and shows a single sentinel-owned dataset — to nobody, because the sentinel
 * has no credential row and cannot sign in. Every other symptom is healthy:
 * healthcheck green, no error in the logs, /login rendering fine.
 *
 * That is a genuinely bad failure mode: the deploy looks successful and the data
 * is invisible, with nothing in the logs to say so. This function is the log
 * line that says it.
 *
 * WHEN IT FIRES
 * -------------
 * When no `auth.account` row exists with provider_id 'credential' — that is,
 * no account can perform a password sign-in. An account with a credential row
 * that is merely unverified still counts, because `createUser` marks
 * operator-created accounts verified and the sentinel is the one case that has
 * no row at all.
 *
 * It runs once at boot, not per request: the answer changes only when an
 * operator runs a CLI, and the next restart re-reads it.
 */
import { sql } from 'drizzle-orm';
import type { Database } from './progression';
import { SENTINEL_EMAIL, SENTINEL_USER_ID } from './bootstrap';

export async function warnIfNoLoginCapableAccount(db: Database): Promise<boolean> {
	const [row] = await db.execute<{ present: boolean }>(sql`
		select exists (
			select 1 from "auth"."account" where "provider_id" = 'credential'
		) as present
	`);
	const present = row?.present === true;
	if (present) return false;

	// No ::uuid cast. postgres-js binds this parameter as text, and Postgres has
	// no `text = uuid` operator, so the cast turns the query into an error rather
	// than a comparison. `id` is already uuid, so plain equality is correct.
	const [sentinel] = await db.execute<{ present: boolean }>(sql`
		select exists (
			select 1 from "auth"."user" where "id" = ${SENTINEL_USER_ID}
		) as present
	`);

	console.warn(
		[
			'',
			'  ┌──────────────────────────────────────────────────────────────┐',
			'  │  NO LOGIN-CAPABLE ACCOUNT                                     │',
			'  └──────────────────────────────────────────────────────────────┘',
			'',
			'  No account can sign in. The app is serving, but every user is',
			'  redirected to /login and no credentials will work.',
			'',
			...(sentinel?.present
				? [
						`  Migration 0011 created the sentinel (${SENTINEL_EMAIL}) and`,
						'  pointed every pre-existing row at it. The sentinel has no password',
						'  by design. To claim that data for a real account:',
						'',
						"      scripts/user-prod.sh bootstrap --email you@example.com --password '...'",
						'',
						'  Your existing workouts become visible the moment that runs.',
						''
					]
				: [
						'  No sentinel found either, so this is an empty installation.',
						'',
						"      scripts/user-prod.sh bootstrap --email you@example.com --password '...'",
						'',
						'  will create the first account.',
						''
					])
		].join('\n')
	);
	return true;
}
