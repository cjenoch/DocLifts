/**
 * `pnpm user:create` — add an account to a database that is already in use.
 *
 * Operator-only. There is no email flow in DocLifts, so this is how a second
 * person gets an account; `pnpm user:bootstrap` is the first-run step and will
 * refuse once real users exist.
 *
 * The account is created through `createUser`, which uses Better Auth's own
 * internalAdapter for both the user row and the credential row. The starter
 * exercise list arrives from the auth create hook, so this script does not
 * insert exercises itself.
 */
import { createUser } from '../src/lib/server/users';
import { arg, readPasswordFromStdin, runCli } from './user-cli-context';

const USAGE =
	'Usage: pnpm user:create --email <address> (--password <password> | --password-stdin) --name "Display Name"\n' +
	'\n' +
	'Prefer --password-stdin so the password is not in the process list or shell history.\n' +
	'  printf \'%s\' "$(pass show doclifts)" | pnpm user:create --email you@example.com --password-stdin --name "Your Name"\n' +
	'\n' +
	"Password rules come from Better Auth's own resolved config (min 12 characters).\n" +
	"To change an existing account's password instead, use pnpm user:set-password.";

runCli(async ({ auth, db }) => {
	const email = arg('--email');
	const name = arg('--name');
	// --password-stdin exists here for the same reason it does on the other two
	// commands: an account's password must not sit in the process list. Creating
	// a SCRATCH account to exercise the throttle is a routine operation, and
	// that makes this a secret worth not leaking.
	const password = process.argv.includes('--password-stdin')
		? await readPasswordFromStdin()
		: arg('--password');
	if (!email || !password || !name) {
		console.error(USAGE);
		return 1;
	}
	const created = await createUser(auth, db, { email, password, name });
	console.log(
		`Created ${created.email}.\n` +
			`  user id   ${created.id}\n` +
			`  name      ${created.name}\n` +
			`\nThey can sign in at /login. Their starter exercise list was added automatically.`
	);
	return 0;
});
