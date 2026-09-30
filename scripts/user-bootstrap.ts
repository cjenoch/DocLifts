/**
 * `pnpm user:bootstrap` — the required first-run step after migration 0011.
 *
 * Claims the 0011 sentinel (or creates a fresh account on a genuinely empty
 * database) so the existing data becomes visible to its real owner. See
 * src/lib/server/bootstrap.ts for why the sentinel is claimed rather than
 * migrated, and why bootstrap refuses when real users already exist.
 *
 * Runs outside SvelteKit — see scripts/user-cli-context.ts.
 */
import { bootstrap, SENTINEL_USER_ID } from '../src/lib/server/bootstrap';
import { arg, readPasswordFromStdin, runCli } from './user-cli-context';

const USAGE =
	'Usage: pnpm user:bootstrap --email <you@example.com> (--password <password> | --password-stdin) [--name "Your Name"]\n' +
	'\n' +
	'Run after `pnpm db:migrate` on a database that has had 0011 applied.\n' +
	`It claims the ${SENTINEL_USER_ID} sentinel, giving every row backfilled by 0011 a real owner.\n` +
	'\n' +
	'Prefer --password-stdin so the password is not in the process list or shell history.\n' +
	'  printf %s "$(pass show doclifts)" | pnpm user:bootstrap --email you@example.com --password-stdin';

runCli(async ({ auth, db }) => {
	const email = arg('--email');
	const name = arg('--name') ?? 'Owner';
	if (!email || (!arg('--password') && !process.argv.includes('--password-stdin'))) {
		console.error(USAGE);
		return 1;
	}
	const password = process.argv.includes('--password-stdin')
		? await readPasswordFromStdin()
		: arg('--password');
	if (!password) {
		console.error(USAGE);
		return 1;
	}

	const result = await bootstrap(auth, db, { email, password, name });
	switch (result.kind) {
		case 'claimed-sentinel':
			console.log(
				`Claimed the 0011 sentinel as ${result.email}.\n` +
					`  user id      ${result.userId}\n` +
					`  exercises    ${result.starterExercises} starter exercises available\n` +
					`\nYour existing workouts, programs, and sets are now visible at /history.`
			);
			return 0;
		case 'created-fresh':
			console.log(
				`Created ${result.email} (no sentinel present, so this database had no data to claim).\n` +
					`  user id      ${result.userId}\n` +
					`  exercises    ${result.starterExercises} starter exercises`
			);
			return 0;
		case 'already-provisioned':
			console.log(`${result.email} is already provisioned (${result.userId}). Nothing to do.`);
			return 0;
	}
});
