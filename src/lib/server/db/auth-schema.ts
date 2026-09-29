/**
 * Better Auth tables, in the `auth` Postgres schema.
 *
 * WHY A SEPARATE PG SCHEMA (decision, 2026-09-29):
 *   Better Auth's default table names are `user`, `session`, `account`,
 *   `verification`. Two problems with taking them as-is:
 *     1. `session` sits one letter from `sessions` (the workout table, the
 *        most-queried table in the app). A generated Drizzle export named
 *        `session` next to `sessions` is a wrong-join waiting to happen.
 *     2. `user` is a Postgres reserved word, so every hand-written SQL
 *        reference needs quoting.
 *   `pgSchema('auth')` isolates all four into `auth.user`, `auth.session`, …
 *   — no collision with `public.sessions`, and `"auth"."user"` is
 *   schema-qualified. Model names are ALSO renamed (auth_user etc. via the
 *   `modelName` options in auth.ts) so the Drizzle exports are unambiguous
 *   in TypeScript, which the pgSchema alone does not solve.
 *
 * FIELD NAMING: column names come from each field's `fieldName`, written
 * out by hand below (`created_at`, `email_verified`, ...). Do NOT add
 * `camelCase` to the adapter config in auth.ts to "fix" the casing — it
 * does the opposite of what it looks like. In
 * @better-auth/drizzle-adapter/dist/generate-drizzle-schema-*.mjs:
 *   function convertToSnakeCase(str, camelCase) {
 *     if (camelCase) return str;      // ← true KEEPS camelCase
 *     return str.replace(...).toLowerCase();
 *   }
 * so the default (unset) is what produces snake_case. The option is read
 * by the schema GENERATOR and relations-v2 only — it appears nowhere in the
 * adapter's own index.mjs, so it does not affect runtime queries either
 * way. These `fieldName` values are the source of truth for column names.
 *
 * GENERATED, THEN HAND-MAINTAINED. Column shapes were derived from
 * Better Auth 1.7.6's own `getAuthTables()` (the same source @better-auth/cli
 * reads), not from memory. @better-auth/cli has no 1.7.6 tag, so the usual
 * `npx @better-auth/cli generate` path is unavailable for this version.
 *
 * After changing anything here: `pnpm db:generate`.
 */
import { index, pgSchema, text, timestamp, boolean } from 'drizzle-orm/pg-core';

export const authSchema = pgSchema('auth');

/**
 * IDs are uuid to match every other table in this schema — DocLifts uses
 * `uuid().primaryKey()` throughout and Better Auth's `user.id` is the FK
 * target for all eight `user_id` columns in the ownership migration.
 */
export const authUsers = authSchema.table(
	'user',
	{
		id: text('id').primaryKey(),
		name: text('name').notNull(),
		email: text('email').notNull().unique(),
		emailVerified: boolean('email_verified').notNull().default(false),
		image: text('image'),
		createdAt: timestamp('created_at').notNull().defaultNow(),
		updatedAt: timestamp('updated_at').notNull().defaultNow()
	},
	(t) => [
		// Better Auth's own lookup paths: sign-in by email, session by token.
		index('auth_user_email_idx').on(t.email),
		index('auth_user_name_idx').on(t.name)
	]
);

export const authSessions = authSchema.table(
	'session',
	{
		id: text('id').primaryKey(),
		expiresAt: timestamp('expires_at').notNull(),
		token: text('token').notNull().unique(),
		createdAt: timestamp('created_at').notNull().defaultNow(),
		updatedAt: timestamp('updated_at').notNull().defaultNow(),
		ipAddress: text('ip_address'),
		userAgent: text('user_agent'),
		userId: text('user_id')
			.notNull()
			.references(() => authUsers.id, { onDelete: 'cascade' })
	},
	(t) => [
		// Every authenticated request resolves a session by token, then loads
		// the user. Both are hot; neither is covered by the unique constraints.
		index('auth_session_token_idx').on(t.token),
		index('auth_session_user_id_idx').on(t.userId)
	]
);

export const authAccounts = authSchema.table(
	'account',
	{
		id: text('id').primaryKey(),
		accountId: text('account_id').notNull(),
		providerId: text('provider_id').notNull(),
		userId: text('user_id')
			.notNull()
			.references(() => authUsers.id, { onDelete: 'cascade' }),
		accessToken: text('access_token'),
		refreshToken: text('refresh_token'),
		idToken: text('id_token'),
		accessTokenExpiresAt: timestamp('access_token_expires_at'),
		refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
		scope: text('scope'),
		/** scrypt hash; `returned: false` upstream, so never serialized. */
		password: text('password'),
		createdAt: timestamp('created_at').notNull().defaultNow(),
		updatedAt: timestamp('updated_at').notNull().defaultNow()
	},
	(t) => [
		// One credential row per (provider, account). Email/password uses
		// providerId 'credential', so this is also the sign-in lookup.
		index('auth_account_user_id_idx').on(t.userId),
		index('auth_account_provider_pair_idx').on(t.providerId, t.accountId)
	]
);

export const authVerifications = authSchema.table(
	'verification',
	{
		id: text('id').primaryKey(),
		identifier: text('identifier').notNull(),
		value: text('value').notNull(),
		expiresAt: timestamp('expires_at').notNull(),
		createdAt: timestamp('created_at').notNull().defaultNow(),
		updatedAt: timestamp('updated_at').notNull().defaultNow()
	},
	(t) => [index('auth_verification_identifier_idx').on(t.identifier)]
);

/**
 * The map Better Auth's adapter resolves models through. Keys are Better
 * Auth's model names; values are our renamed table objects. This is the
 * `schema` option in drizzleAdapter — see auth.ts.
 */
export const authTables = {
	user: authUsers,
	session: authSessions,
	account: authAccounts,
	verification: authVerifications
};
