/**
 * Server-side user creation. The single path the T5 CLI (`pnpm user:create`,
 * `pnpm user:bootstrap`) and the T2 e2e fixture both call, so a change to
 * Better Auth's account shape breaks the CLI and the e2e together.
 *
 * WHY NOT auth.api.signUpEmail()
 * -----------------------------
 * With `emailAndPassword.disableSignUp` set (which it is, by default — D2),
 * that endpoint throws before doing any work. better-auth 1.7.6,
 * dist/api/routes/sign-up.mjs:
 *
 *   if (!ctx.context.options.emailAndPassword?.enabled ||
 *       ctx.context.options.emailAndPassword?.disableSignUp)
 *     throw APIError.from("BAD_REQUEST", { code: "EMAIL_PASSWORD_SIGN_UP_DISABLED" })
 *
 * A server-side `auth.api.signUpEmail` call runs the same handler through the
 * same context, so it hits the same throw. Flipping DOCLIFTS_OPEN_SIGNUP to
 * work around this would open the public sign-up endpoint, which is exactly
 * what D2 forbids. So we do the three things that endpoint does, in the same
 * order, using the same context.
 *
 * The mechanism, from the same file:
 *
 *   const hash = await ctx.context.password.hash(password);
 *   createdUser = await ctx.context.internalAdapter.createUser(
 *     { email: normalizedEmail, name, emailVerified: false },
 *     { method: "email-password" });
 *   await ctx.context.internalAdapter.linkAccount({
 *     userId: createdUser.id, providerId: "credential",
 *     accountId: createdUser.id, password: hash });
 *
 * `ctx.context` is reached through `auth.$context` — a public export, not an
 * internal. better-auth 1.7.6 dist/auth/base.mjs returns `$context: authContext`
 * from `createBetterAuth`, and better-auth's own test-utils plugin documents
 * `await testAuth.$context` as the supported way in. The admin plugin's
 * create-user was the other candidate; that plugin is not installed, and
 * adding it for this would be a larger surface than three adapter calls.
 */
import { z } from 'zod';
import { auth } from './auth';
import type { Database } from './progression';
import { eq } from 'drizzle-orm';

/** The 0011 sentinel's placeholder email. Duplicated from bootstrap.ts on purpose:
 *  bootstrap.ts imports this file, so importing back would be a cycle. */
const SENTINEL_EMAIL = 'owner@localhost';
import { authUsers } from './db/auth-schema';

/** Better Auth lowercases emails itself; do it first so a duplicate check
 *  and the insert agree on the stored form. */
const emailSchema = z
	.string()
	.trim()
	.email()
	.max(320)
	.transform((v) => v.toLowerCase());

/**
 * Password limits, read from Better Auth's own resolved config.
 *
 * The earlier version hard-coded 12 to match auth.ts, which meant the CLI and
 * the sign-up endpoint could drift apart silently — raise the config value and
 * `createUser` keeps accepting passwords the endpoint would reject.
 *
 * The values come from `ctx.password.config`, not from `auth.options`. That is
 * where the validators read them too, so this cannot drift from what
 * sign-up/sign-in actually enforce:
 *
 *   dist/context/create-context.mjs
 *     password: { config: {
 *       minPasswordLength: options.emailAndPassword?.minPasswordLength || 8,
 *       maxPasswordLength: options.emailAndPassword?.maxPasswordLength || 128
 *     }}
 *
 *   dist/utils/password.mjs
 *     assertPasswordNotTooLong: password.length > ctx.context.password.config.maxPasswordLength
 *
 * `maxPasswordLength` is absent from the `emailAndPassword` options TYPE even
 * though the runtime honours it, which is why this reads the resolved context.
 * Resolved lazily: it is async because `auth.$context` is, and because an
 * import-time call would break the secret-free build.
 */
async function passwordLimits(): Promise<{ min: number; max: number }> {
	const { minPasswordLength, maxPasswordLength } = (await auth.$context).password.config;
	return { min: minPasswordLength, max: maxPasswordLength };
}

export type CreatedUser = { id: string; email: string; name: string };

export async function createUser(
	db: Database,
	input: { email: string; password: string; name: string }
): Promise<CreatedUser> {
	const limits = await passwordLimits();
	const value = z
		.object({
			email: emailSchema,
			password: z
				.string()
				.min(limits.min, `Password must be at least ${limits.min} characters`)
				.max(limits.max, `Password must be at most ${limits.max} characters`),
			name: z.string().trim().min(1).max(120)
		})
		.parse(input);

	// Reject a duplicate up front so the caller gets a clear error rather
	// than a partially-written user plus a unique-violation from the adapter.
	// This is a convenience check, not the integrity boundary — the unique
	// index on auth.user.email is.
	const [existing] = await db
		.select({ id: authUsers.id })
		.from(authUsers)
		.where(eq(authUsers.email, value.email));
	if (existing) throw new Error(`A user with email ${value.email} already exists`);

	const ctx = await auth.$context;

	// The adapter's own createUser lowercases the email, but only after we
	// have already checked for a duplicate, so normalize before both.
	const user = await ctx.internalAdapter.createUser(
		{
			email: value.email,
			name: value.name,
			// True, not false. Every account made here is operator-created
			// (the bootstrap CLI, `pnpm user:create`, the e2e fixture) and
			// there is no email flow to complete: no verification mail is
			// sent and no address is confirmed by anyone. Marking them
			// unverified bought nothing and would lock every one of them out
			// the moment `requireEmailVerification` is ever switched on.
			emailVerified: true
		},
		{ method: 'email-password' }
	);

	if (!user) throw new Error('Better Auth failed to create the user');

	// providerId "credential" + accountId = user.id is what sign-up/email
	// does; without this account row there is no password to sign in with.
	await ctx.internalAdapter.linkAccount({
		userId: user.id,
		providerId: 'credential',
		accountId: user.id,
		password: await ctx.password.hash(value.password)
	});

	return { id: user.id, email: value.email, name: value.name };
}

/** Did the fixture just created actually end up in our database? */
export async function findUserByEmail(db: Database, email: string): Promise<string | null> {
	const [row] = await db
		.select({ id: authUsers.id })
		.from(authUsers)
		.where(eq(authUsers.email, email.toLowerCase()));
	return row?.id ?? null;
}

/**
 * Replace an account's password. T5's `pnpm user:set-password`.
 *
 * WHY updatePassword AND NOT linkAccount AGAIN
 * -------------------------------------------
 * `internalAdapter.updatePassword(userId, password)` matches the account row on
 * (userId, providerId 'credential', accountId === userId) and SETS the column.
 * linkAccount, which createUser uses, is an INSERT: calling it a second time
 * for the same account would violate the account table's unique constraint
 * rather than change anything. Reading better-auth 1.7.6's
 * dist/db/internal-adapter.mjs:627 rather than guessing the method name —
 * updatePassword is not in the .d.mts surface, so it is only discoverable in
 * the implementation.
 *
 * IT DOES NOT HASH — YOU MUST
 * ---------------------------
 * This is the trap that cost an hour, and the test is what caught it.
 * `internal-adapter.mjs:627` reads
 *
 *   updatePassword: async (userId, password) => {
 *     await updateManyWithHooks({ password }, [ ... ], "account", void 0);
 *   }
 *
 * and `updateManyWithHooks` in db/with-hooks.mjs writes `actualData` verbatim
 * to the column. There is no hashing anywhere in that path, despite the name.
 * So the caller MUST hash, exactly as linkAccount callers do — a raw password
 * lands in the column as plain text and every later sign-in fails with
 * "Invalid password hash".
 *
 * Assumed the opposite on the first pass because the method is named
 * `updatePassword` rather than `setPasswordHash`. Verified against
 * signInEmail (not against the database) so the assertion is "this account can
 * sign in", not "this column looks like a hash".
 *
 * Password limits are checked first, through the same resolved-config path as
 * createUser, so the CLI cannot set a password that sign-in would reject.
 */
export async function setPassword(db: Database, input: { email: string; password: string }) {
	const limits = await passwordLimits();
	// The unclaimed 0011 sentinel's email is `owner@localhost`, which fails zod's
	// email regex (it requires a dot and a TLD). Without this branch an operator
	// who tries to reset the sentinel's password before bootstrapping gets an
	// opaque Zod error instead of the one instruction that helps. Matched on the
	// literal placeholder so it stays correct if either side is renamed.
	if (input.email.trim().toLowerCase() === SENTINEL_EMAIL) {
		throw new Error(
			`${SENTINEL_EMAIL} is the 0011 sentinel, which has no password to reset. ` +
				`Run pnpm user:bootstrap to claim it with a real email and password.`
		);
	}
	const email = z
		.string()
		.trim()
		.email()
		.max(320)
		.transform((v) => v.toLowerCase())
		.parse(input.email);
	const password = z
		.string()
		.min(limits.min, `Password must be at least ${limits.min} characters`)
		.max(limits.max, `Password must be at most ${limits.max} characters`)
		.parse(input.password);

	const [row] = await db
		.select({ id: authUsers.id })
		.from(authUsers)
		.where(eq(authUsers.email, email));
	if (!row) throw new Error(`No user with email ${email}`);

	// An account with no credential row cannot be given a password by update:
	// it matches on the credential provider and would silently update nothing.
	const ctx = await auth.$context;
	const accounts = await ctx.internalAdapter.findAccounts(row.id);
	const credential = accounts.find((a) => a.providerId === 'credential');
	if (!credential) {
		throw new Error(
			`User ${email} has no credential account, so there is no password to replace. ` +
				`If this is the 0011 sentinel, use pnpm user:bootstrap to claim it.`
		);
	}

	await ctx.internalAdapter.updatePassword(row.id, await ctx.password.hash(password));
	return { id: row.id, email };
}
