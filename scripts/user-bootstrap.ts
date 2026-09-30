/**
 * `pnpm user:bootstrap` — the required first-run step after migration 0011.
 *
 * Claims the 0011 sentinel (or creates a fresh account on a genuinely empty
 * database) so the existing data becomes visible to its real owner. See
 * src/lib/server/bootstrap.ts for why the sentinel is claimed rather than
 * migrated, and why bootstrap refuses when real users already exist.
 *
 * Runs through tsx with --env-file, so DATABASE_URL and BETTER_AUTH_SECRET come
 * from .env the same way the app reads them. It imports the real app modules, so
 * it talks to the same database the app does — no separate connection string to
 * keep in sync.
 */
import { bootstrap, SENTINEL_USER_ID } from '../src/lib/server/bootstrap';
import { db } from '../src/lib/server/db';

function arg(flag: string): string | undefined {
	const i = process.argv.indexOf(flag);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

const USAGE =
	'Usage: pnpm user:bootstrap --email <you@example.com> --password <password> [--name "Your Name"]\n' +
	'\n' +
	'Run after `pnpm db:migrate` on a database that has had 0011 applied.\n' +
	`It claims the ${SENTINEL_USER_ID} sentinel, giving every row backfilled by 0011 a real owner.`;

async function main(): Promise<number> {
	const email = arg('--email');
	const password = arg('--password');
	const name = arg('--name') ?? 'Owner';
	if (!email || !password) {
		console.error(USAGE);
		return 1;
	}
	const result = await bootstrap(db, { email, password, name });
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
}

main()
	.then((code) => process.exit(code))
	.catch((cause: unknown) => {
		console.error(
			`\nBootstrap refused: ${cause instanceof Error ? cause.message : String(cause)}\n`
		);
		process.exit(1);
	});
