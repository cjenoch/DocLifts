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
import { arg, runCli } from './user-cli-context';

const USAGE =
	'Usage: pnpm user:set-password --email <address> --password <new password>\n' +
	'\n' +
	"Password rules come from Better Auth's own resolved config (min 12 characters).\n" +
	'Passwords are never echoed back or logged.';

runCli(async ({ auth, db }) => {
	const email = arg('--email');
	const password = arg('--password');
	if (!email || !password) {
		console.error(USAGE);
		return 1;
	}
	const result = await setPassword(auth, db, { email, password });
	console.log(`Password updated for ${result.email} (${result.id}).`);
	return 0;
});
