/**
 * `pnpm user:set-password` — replace an existing account's password.
 *
 * Operator recovery tool. There is no "forgot password" email flow (DocLifts
 * sends no mail at all), so this is how a locked-out account is fixed.
 *
 * Note the sentinel: 0011 creates it with deliberately NO credential row, so
 * `setPassword` refuses on it and points at `pnpm user:bootstrap`. That refusal
 * is the point — the sentinel is not an account anyone can sign in as until it
 * is claimed.
 */
import { setPassword } from '../src/lib/server/users';
import { arg, readPasswordFromStdin, runCli } from './user-cli-context';

const USAGE =
	'Usage: pnpm user:set-password --email <address> (--password <new password> | --password-stdin)\n' +
	'\n' +
	"Password rules come from Better Auth's own resolved config (min 12 characters).\n" +
	'Passwords are never echoed back or logged.\n' +
	'\n' +
	'Prefer --password-stdin: a command-line password is visible in the process\n' +
	'list and is written to shell history.\n' +
	'  printf %s "$(pass show doclifts)" | pnpm user:set-password --email you@example.com --password-stdin';

runCli(async ({ auth, db }) => {
	const email = arg('--email');
	if (!email || (!arg('--password') && !process.argv.includes('--password-stdin'))) {
		console.error(USAGE);
		return 1;
	}
	// --password-stdin wins if both are given, so a stray --password in a
	// shell history line cannot take precedence over the piped value.
	const password = process.argv.includes('--password-stdin')
		? await readPasswordFromStdin()
		: arg('--password');
	if (!password) {
		console.error(USAGE);
		return 1;
	}
	const result = await setPassword(auth, db, { email, password });
	console.log(`Password updated for ${result.email} (${result.id}).`);
	return 0;
});
