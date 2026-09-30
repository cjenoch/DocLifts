/**
 * Better Auth configuration. Phase 1: email + password only, no OAuth, no
 * passkeys, no social login.
 *
 * Read the installed library's own types before changing this — the option
 * names below were verified against better-auth 1.7.6's
 * `BetterAuthOptions` and `DrizzleAdapterConfig`, not from memory. See
 * db/auth-schema.ts for the table-naming rationale.
 */
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { env } from '$env/dynamic/private';
import { exercises } from './db/schema';
import { STARTER_EXERCISES } from './starter-exercises';
import { building } from '$app/environment';
import { db } from './db';
import { authTables } from './db/auth-schema';

/**
 * The secret, with a placeholder during `vite build`.
 *
 * `betterAuth(...)` is called at MODULE SCOPE, so whatever this returns is
 * evaluated at module load, not on first use. The requirement is split by
 * phase, because a build and a running server genuinely need different things:
 *
 *   - A BUILD needs no secret. SvelteKit's postbuild analysis, the Dockerfile
 *     builder stage, and the CI build step all import the server graph with a
 *     placeholder DATABASE_URL and no secret. A throw here breaks all three.
 *   - A RUNNING SERVER needs a real one, and must not serve without it.
 *     adapter-node loads this graph at BOOT, so a missing secret exits
 *     non-zero before the listener opens: the failure is in the logs and the
 *     healthcheck, and no request is ever served on a broken auth config.
 *
 * `building` is true only during vite build and prerender analysis, so the
 * placeholder is unreachable at runtime. It is never a working credential.
 *
 * HISTORY: this comment previously claimed the resolution was "lazy, not at
 * module import" and justified it on the grounds that a build must not need a
 * secret. The function was lazy; the CALL was not, and the claim was wrong
 * from T1a onward. It stayed unexposed only because no route imported this
 * module until T2 added the first one, at which point `pnpm build` started
 * requiring a secret it should never have needed.
 */
function requireSecret(): string {
	const secret = env.BETTER_AUTH_SECRET;
	if (!secret) {
		throw new Error(
			'BETTER_AUTH_SECRET not set — check .env (generate with: openssl rand -base64 32)'
		);
	}
	return secret;
}

export const auth = betterAuth({
	/**
	 * Same origin the app is served from. Also drives cookie domain and
	 * the Secure flag: an http:// baseURL means non-Secure cookies, which is
	 * the current tailnet deployment. See WORKORDER T6 — the public
	 * deployment must be https or sign-in silently fails to persist.
	 */
	baseURL: env.PUBLIC_ORIGIN ?? 'http://127.0.0.1:3000',

	secret: building ? 'build-time-placeholder-never-used-at-runtime' : requireSecret(),

	database: drizzleAdapter(db, {
		provider: 'pg',
		/**
		 * Postgres schema, not a table prefix. Produces `auth.user` etc.,
		 * isolating Better Auth's tables from `public.sessions` (workout).
		 */
		schemaName: 'auth',
		/** Resolve models by key against our renamed exports. */
		schema: authTables
		/**
		 * COLUMN NAMING — read the generator, not the option name.
		 *
		 * @better-auth/drizzle-adapter/dist/generate-drizzle-schema-*.mjs:
		 *   function convertToSnakeCase(str, camelCase) {
		 *     if (camelCase) return str;        // ← true KEEPS camelCase
		 *     return str.replace(...).toLowerCase();
		 *   }
		 *
		 * So the DEFAULT (camelCase unset/false) is what emits snake_case
		 * columns. `camelCase: true` would keep camelCase. We want
		 * snake_case — every other table in this database is snake_case —
		 * so the option is deliberately left UNSET.
		 *
		 * The option is read by the schema generator and relations-v2, not
		 * by the runtime query builder (`camelCase` does not appear in the
		 * adapter's own index.mjs). At runtime the column names come from
		 * each field's `fieldName`, set by hand above. T1b's real sign-in
		 * is what proves the mapping end to end.
		 */
		// (deliberately unset — see above)
	}),

	/**
	 * NO modelName renames, deliberately.
	 *
	 * An earlier draft set user/session/account/verification to
	 * `auth_user` etc. That was the Path 1 mechanism (a table PREFIX).
	 * Path 2 replaced it with a Postgres SCHEMA — `pgSchema('auth')` — and
	 * the two compose into a table with three different names: model
	 * `auth_user`, schema-map key `auth_user`, physical `auth.user`. It
	 * works, but it is indirection with no purpose, and changing one of
	 * the three independently would be a very confusing bug.
	 *
	 * So: model name = physical table name = the Better Auth defaults,
	 * living in the `auth` schema. The only place these tables carry a
	 * different name is the TypeScript export (`authUsers`), which is the
	 * only place it ever mattered. See db/auth-schema.ts.
	 *
	 * (For the record, `modelName` is read off the TOP-LEVEL options, not
	 * the adapter: @better-auth/core 1.7.6 get-tables.mjs has
	 * `modelName: options.user?.modelName || "user"`.)
	 */
	session: {
		expiresIn: 60 * 60 * 24 * 30,
		updateAge: 60 * 60 * 24
	},

	emailAndPassword: {
		enabled: true,
		/**
		 * D2: sign-up is closed by default. Accounts are created by
		 * `pnpm user:bootstrap` / `pnpm user:create`, or by /signup when
		 * DOCLIFTS_OPEN_SIGNUP=1. This is a policy toggle, not an
		 * auth-off toggle — there is no auth-off mode.
		 */
		disableSignUp: env.DOCLIFTS_OPEN_SIGNUP !== '1',
		minPasswordLength: 12
	},

	/**
	 * T1 requirement. Rate limiting is on the auth endpoints (sign-in,
	 * sign-up, password). Enabled for both storage modes: the default
	 * in-memory limiter, and the database one if DOCLIFTS_RATE_LIMIT_STORAGE
	 * is set (multi-instance deployments need it — in-memory state is
	 * per-process).
	 */
	/**
	 * T5: every new account gets the starter exercise list.
	 *
	 * `databaseHooks.user.create.after` rather than a call inside `createUser`,
	 * because createUser is not the only way an account comes into being: this
	 * hook fires for `pnpm user:bootstrap`, `pnpm user:create`, and any future
	 * open sign-up, with no path able to forget it. A call inside createUser
	 * would be one more place to remember.
	 *
	 * Confirmed for 1.7.6 that `internalAdapter.createUser` runs these hooks —
	 * users.ts's createUser goes through that adapter, which is the point:
	 * users.ts never has to know this hook exists.
	 *
	 * onConflictDoNothing on (user_id, name), the unique index created by 0010
	 * (`exercises_user_id_name_unique`), so re-running is a no-op rather than a
	 * duplicate. seedDemo depends on that too: the demo user's nine exercises
	 * arrive from HERE, and its own inserts collide by design.
	 *
	 * A failure here must not roll back the account: `user.create.after` runs
	 * after the user exists, so throwing would leave a user with no starter
	 * list AND an error the operator sees as "user creation failed". Log and
	 * continue — `pnpm user:bootstrap` reports the gap explicitly, and an empty
	 * exercise list is recoverable while a half-created account is not.
	 */
	databaseHooks: {
		user: {
			create: {
				after: async (user) => {
					try {
						await db
							.insert(exercises)
							.values(
								STARTER_EXERCISES.map((e) => ({
									userId: user.id,
									name: e.name,
									equipmentType: e.equipmentType,
									isLowerBody: e.isLowerBody ?? false
								}))
							)
							.onConflictDoNothing({
								target: [exercises.userId, exercises.name]
							});
					} catch (cause) {
						console.error(`[auth] starter exercise list failed for user ${user.id}:`, cause);
					}
				}
			}
		}
	},

	rateLimit: {
		enabled: true,
		...(env.DOCLIFTS_RATE_LIMIT_STORAGE === 'database' ? { storage: 'database' as const } : {})
	},

	advanced: {
		defaultCookieAttributes: {
			sameSite: 'lax'
		}
	}
});

export type Auth = typeof auth;
