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
 * createUser writes the same two rows, but in ONE transaction through Better
 * Auth's own drizzle adapter bound to it (see `insertCredentialAccount`), so a
 * failure between them cannot leave a user with no password.
 *
 * `ctx.context` is reached through `auth.$context` — a public export, not an
 * internal. better-auth 1.7.6 dist/auth/base.mjs returns `$context: authContext`
 * from `createBetterAuth`, and better-auth's own test-utils plugin documents
 * `await testAuth.$context` as the supported way in. The admin plugin's
 * create-user was the other candidate; that plugin is not installed, and
 * adding it for this would be a larger surface than three adapter calls.
 */
import { z } from 'zod';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { authAdapterOptions, type Auth } from './auth-core';
import type { Database } from './progression';
import { eq } from 'drizzle-orm';
import { authUsers } from './db/auth-schema';

/** The 0011 sentinel's placeholder email. Defined here and re-exported by
 *  bootstrap.ts: bootstrap imports this file, so this is the end with no cycle. */
export const SENTINEL_EMAIL = 'owner@localhost';

type AuthContext = Awaited<Auth['$context']>;
/** A drizzle transaction handle, as `db.transaction` passes it. */
export type AuthTx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Refuse when Better Auth is configured with a hook that the transactional
 * writes below would skip.
 *
 * `createUser` and `insertCredentialAccount` write through Better
 * Auth's drizzle adapter bound to OUR transaction, not through
 * `internalAdapter` (which is bound to the pool: the drizzle adapter's
 * `transaction` option is off, and the CLI's pool has ONE connection, so a pool
 * write inside our transaction would wait for itself forever). The adapter
 * call is the write `internalAdapter` makes, minus `databaseHooks`.
 *
 * Today the only configured database hook is auth-core.ts's
 * `user.create.after` (the starter list), which createUser runs itself after
 * commit, as Better Auth does for a write inside its own transaction
 * (`queueAfterTransactionHook`). Any `user.create.before` or `account.create`
 * hook would be silently skipped, so it is refused instead. Plugin hooks are
 * not visible on the context (better-auth 1.7.7 context/helpers.mjs passes them
 * straight into the internal adapter); oauth-provider registers only
 * `session.delete`. A new plugin with a user or account create hook must be
 * checked here by hand.
 */
export function refuseSkippedCreateHooks(ctx: AuthContext, what: string): void {
	const hooks = ctx.options.databaseHooks as
		| { user?: { create?: { before?: unknown } }; account?: { create?: unknown } }
		| undefined;
	if (hooks?.account?.create || hooks?.user?.create?.before) {
		throw new Error(
			`Refusing to ${what}: an auth user.create.before or account.create hook is configured, ` +
				`and the transactional write skips it. Teach users.ts about the hook first.`
		);
	}
}

/** Better Auth's own adapter, with auth-core.ts's options and the resolved
 *  config (`ctx.options`: id generation, field names), bound to `tx`. */
function txAuthAdapter(tx: AuthTx, ctx: AuthContext) {
	return drizzleAdapter(tx, authAdapterOptions)(ctx.options);
}

/**
 * The credential row, inside the caller's transaction. The payload is exactly
 * what `internalAdapter.linkAccount` sends (better-auth 1.7.7
 * dist/db/internal-adapter.mjs:594): createdAt, updatedAt, userId, providerId
 * 'credential', accountId === userId, the password hash. Since 0025 the
 * database refuses a second row for the same (provider_id, account_id)
 * (`auth_account_provider_account_unique`). Call `refuseSkippedCreateHooks`
 * first. The ONE writer of credential rows for createUser and the bootstrap
 * claim.
 */
export async function insertCredentialAccount(
	tx: AuthTx,
	ctx: AuthContext,
	userId: string,
	passwordHash: string
): Promise<void> {
	await txAuthAdapter(tx, ctx).create({
		model: 'account',
		data: {
			createdAt: new Date(),
			updatedAt: new Date(),
			userId,
			providerId: 'credential',
			accountId: userId,
			password: passwordHash
		}
	});
}

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
async function passwordLimits(auth: Auth): Promise<{ min: number; max: number }> {
	const { minPasswordLength, maxPasswordLength } = (await auth.$context).password.config;
	return { min: minPasswordLength, max: maxPasswordLength };
}

export type CreatedUser = { id: string; email: string; name: string };

/**
 * `auth` is an EXPLICIT argument, not an import.
 *
 * The T5 CLI needs these primitives outside SvelteKit, and `./auth` imports
 * `$env`/`$app`, which do not resolve under bare tsx. The server passes the
 * singleton; a CLI passes its own instance built from process.env. Explicit
 * beats a module-level import here because the two instances must be built
 * the same way, and an argument makes that visible at every call site.
 */
export async function createUser(
	auth: Auth,
	db: Database,
	input: { email: string; password: string; name: string }
): Promise<CreatedUser> {
	const limits = await passwordLimits(auth);
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
	refuseSkippedCreateHooks(ctx, 'create the user');
	// Hash before the transaction: scrypt is slow and needs no lock.
	const hash = await ctx.password.hash(value.password);

	// ONE transaction: the user row and its credential row, or neither. The two
	// used to be separate pool writes (internalAdapter.createUser, then
	// linkAccount), so a failure between them left a user with no password —
	// an email that could never sign in and that a re-run refused as a
	// duplicate.
	const user = await db.transaction(async (tx) => {
		// The data internalAdapter.createUser sends (internal-adapter.mjs:140).
		// The adapter's own createUser lowercases the email, but only after we
		// have already checked for a duplicate, so it is normalized before both.
		const created = await txAuthAdapter(tx, ctx).create<Record<string, unknown>>({
			model: 'user',
			data: {
				createdAt: new Date(),
				updatedAt: new Date(),
				email: value.email,
				name: value.name,
				// True, not false. Every account made here is operator-created
				// (the bootstrap CLI, `pnpm user:create`, the e2e fixture) and
				// there is no email flow to complete: no verification mail is
				// sent and no address is confirmed by anyone. Marking them
				// unverified bought nothing and would lock every one of them out
				// the moment `requireEmailVerification` is ever switched on.
				emailVerified: true
			}
		});
		const id = typeof created?.id === 'string' ? created.id : null;
		if (!id) throw new Error('Better Auth failed to create the user');
		// providerId "credential" + accountId = user.id is what sign-up/email
		// does; without this account row there is no password to sign in with.
		await insertCredentialAccount(tx, ctx, id, hash);
		return { ...created, id };
	});

	// After commit, the configured `user.create.after` hook: auth-core.ts's
	// starter exercise list, still defined in that ONE place. Better Auth runs
	// an after hook for a write inside its own transaction after the commit
	// too, and this hook catches and logs its own failure, so the account
	// stands either way (an empty list is recoverable; a half account is not).
	const after = ctx.options.databaseHooks?.user?.create?.after;
	await after?.(user as Parameters<typeof after>[0]);

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
 * WHY updatePassword AND NOT ANOTHER INSERT
 * ----------------------------------------
 * `internalAdapter.updatePassword(userId, password)` matches the account row on
 * (userId, providerId 'credential', accountId === userId) and SETS the column.
 * The credential write createUser makes is an INSERT: a second one for the
 * same account is refused by `auth_account_provider_account_unique` (the
 * unique index on (provider_id, account_id), migration 0025) rather than
 * changing anything. Before 0025 it was silently accepted as a second row.
 * Reading better-auth 1.7.6's
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
export async function setPassword(
	auth: Auth,
	db: Database,
	input: { email: string; password: string }
) {
	const limits = await passwordLimits(auth);
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
