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
 * Mirrors auth.ts's `minPasswordLength: 12`. Duplicated deliberately: this
 * is a server-side guard for a server-only path, and reading the value out of
 * the auth config object would mean reaching through `auth.options` for a
 * number that has to stay in sync by review anyway. Keep the two in step.
 */
const MIN_PASSWORD_LENGTH = 12;

export type CreatedUser = { id: string; email: string; name: string };

export async function createUser(
	db: Database,
	input: { email: string; password: string; name: string }
): Promise<CreatedUser> {
	const value = z
		.object({
			email: emailSchema,
			password: z
				.string()
				.min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`),
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
			// Never email-verified. The bootstrap account is created this way
			// and must not be able to receive mail.
			emailVerified: false
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
