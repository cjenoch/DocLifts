/**
 * The Better Auth configuration as a FUNCTION, with no SvelteKit imports.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `pnpm user:bootstrap` / `user:create` / `user:set-password` have to run
 * outside a SvelteKit build, under bare `tsx`. They cannot import `auth.ts`,
 * because that module reaches `$env/dynamic/private` and `$app/environment` —
 * specifiers that only exist inside SvelteKit's Vite pipeline. Under bare tsx
 * the CLI died with:
 *
 *   Cannot find package '$env' imported from src/lib/server/db/index.ts
 *
 * There were two ways out. One is a loader hook that re-implements those
 * virtual modules; that drifts from SvelteKit, needs another entry every time
 * a server module reaches for another virtual, and makes the CLI depend on the
 * app's module graph in a way nothing else in the repo does. Rejected.
 *
 * The way taken instead is the one `db/seed.ts` already uses: build the pieces
 * from `process.env` outside the framework. seedDemo sidestepped this only
 * because it imports just the schema; it needs `createUser`, which needs auth,
 * so there was no sidestep available.
 *
 * So the configuration lives here as `createAuth(db, opts)`, and `auth.ts`
 * becomes the SvelteKit singleton that supplies the two values this file cannot
 * know: the secret and whether we are mid-build.
 *
 * WHAT DELIBERATELY STAYS HERE
 * ----------------------------
 * Every behaviour decision — adapter, schema map, session lifetime, sign-up
 * policy, rate limiting, cookie attributes, and the starter-exercise hook — so
 * there is exactly ONE place any of it is defined. A CLI auth instance and the
 * server auth instance must be the same configuration, or bootstrap could
 * create an account that the running server cannot authenticate.
 */
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { exercises } from './db/schema';
import { authTables } from './db/auth-schema';
import { STARTER_EXERCISES } from './starter-exercises';
import type { Database } from './progression';

export type CreateAuthOptions = {
	/** Better Auth's signing secret. Never the build-time placeholder here. */
	secret: string;
	/**
	 * Same origin the app is served from. Also drives cookie domain and the
	 * Secure flag: an `http://` baseURL means non-Secure cookies, which is the
	 * current tailnet deployment. See WORKORDER T6 — the public deployment must
	 * be https or sign-in silently fails to persist.
	 */
	baseURL: string;
	/** D2: sign-up is closed by default. Accounts come from the T5 CLI. */
	openSignup: boolean;
	/**
	 * Rate-limit storage. `database` is required for multi-instance
	 * deployments — the default in-memory limiter keeps state per-process.
	 */
	rateLimitStorage: 'memory' | 'database';
};

/**
 * Session lifetime in days, from SESSION_EXPIRES_DAYS.
 *
 * Read from `process.env` rather than `$env/dynamic/private` on purpose: this
 * module must keep working outside a SvelteKit build, because the account CLI
 * builds its own auth instance from here. A malformed or absent value falls
 * back to 30 with a warning — never to zero, which would mean every session
 * expires the instant it is created and nobody can ever sign in.
 */
function sessionExpiresDays(): number {
	const raw = process.env.SESSION_EXPIRES_DAYS;
	if (raw === undefined || raw.trim() === '') return 30;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		console.warn(`[auth] SESSION_EXPIRES_DAYS="${raw}" is not a positive number; using 30`);
		return 30;
	}
	return parsed;
}

/** The code default, and the floor below which a configured value is refused. */
export const PASSWORD_MIN_LENGTH_DEFAULT = 12;
export const PASSWORD_MIN_LENGTH_FLOOR = 8;
/** Better Auth's own default maximum (create-context.mjs), which we do not change. */
export const PASSWORD_MAX_LENGTH = 128;

/**
 * Minimum password length, from PASSWORD_MIN_LENGTH. LENGTH IS THE WHOLE POLICY.
 *
 * Spec §2 item 4, after NIST SP 800-63B: no composition rules (no required
 * symbol, digit or case) at any length. The code ships 12; the owner sets the
 * number he will actually type, in the env file.
 *
 * 8 is a floor, not a suggestion — NIST's minimum for a user-chosen password.
 * Below it, or anything that is not a whole number, THROWS. createAuth runs at
 * module load of auth.ts, which hooks.server.ts imports, so a bad value stops
 * the server at boot instead of quietly running the default. Above Better
 * Auth's maximum of 128 also throws: every password would be impossible.
 *
 * Read from `process.env` for the same reason as SESSION_EXPIRES_DAYS: the
 * account CLI builds its own auth instance from here, outside SvelteKit, and
 * the two must enforce the same number. Sign-in never checks this — Better
 * Auth applies it to setting a password, not to verifying one — so raising it
 * cannot lock out a password that already exists. password-policy.e2e.ts
 * proves that rather than trusting it.
 */
export function passwordMinLength(env: Record<string, string | undefined> = process.env): number {
	const raw = env.PASSWORD_MIN_LENGTH;
	if (raw === undefined || raw.trim() === '') return PASSWORD_MIN_LENGTH_DEFAULT;
	const parsed = Number(raw);
	if (
		!Number.isInteger(parsed) ||
		parsed < PASSWORD_MIN_LENGTH_FLOOR ||
		parsed > PASSWORD_MAX_LENGTH
	) {
		throw new Error(
			`[auth] PASSWORD_MIN_LENGTH="${raw}" must be a whole number from ` +
				`${PASSWORD_MIN_LENGTH_FLOOR} to ${PASSWORD_MAX_LENGTH}. ` +
				`Fix it in the env file, or unset it to use ${PASSWORD_MIN_LENGTH_DEFAULT}.`
		);
	}
	return parsed;
}

export function createAuth(db: Database, opts: CreateAuthOptions) {
	return betterAuth({
		baseURL: opts.baseURL,
		secret: opts.secret,

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
			 * each field's `fieldName`, set by hand in db/auth-schema.ts. T1b's
			 * real sign-in is what proves the mapping end to end.
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
		/**
		 * 30 days, sliding. Env-driven as SESSION_EXPIRES_DAYS.
		 *
		 * 30 rather than Better Auth's 7-day default because this is a gym log
		 * someone uses several times a week: a week off is a holiday, a week
		 * without noticing the app is a lockout, and being logged out of your
		 * own training log is a worse outcome than a session living a month.
		 *
		 * updateAge 1 day keeps it sliding without a write per request.
		 */
		session: {
			expiresIn: 60 * 60 * 24 * sessionExpiresDays(),
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
			disableSignUp: !opts.openSignup,
			// Length only. See passwordMinLength.
			minPasswordLength: passwordMinLength()
		},

		/**
		 * T5: every new account gets the starter exercise list.
		 *
		 * `databaseHooks.user.create.after` rather than a call inside
		 * `createUser`, because createUser is not the only way an account comes
		 * into being: this hook fires for `pnpm user:bootstrap`,
		 * `pnpm user:create`, seedDemo's demo user, and any future open
		 * sign-up, with no path able to forget it. A call inside createUser
		 * would be one more place to remember.
		 *
		 * Confirmed for 1.7.6 that `internalAdapter.createUser` runs these
		 * hooks — users.ts's createUser goes through that adapter, which is
		 * the point: users.ts never has to know this hook exists.
		 *
		 * onConflictDoNothing on (user_id, name), the unique index created by
		 * 0010 (`exercises_user_id_name_unique`), so re-running is a no-op
		 * rather than a duplicate. seedDemo depends on that too: the demo
		 * user's nine exercises arrive from HERE, and its own inserts collide
		 * by design.
		 *
		 * A failure here must not roll back the account: `user.create.after`
		 * runs after the user exists, so throwing would leave a user with no
		 * starter list AND an error the operator sees as "user creation
		 * failed". Log and continue — `pnpm user:bootstrap` reports the gap
		 * explicitly, and an empty exercise list is recoverable while a
		 * half-created account is not.
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
										isLowerBody: e.isLowerBody ?? false,
										bodyRegion: e.bodyRegion
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

		/**
		 * T1 requirement. Rate limiting is on the auth endpoints (sign-in,
		 * sign-up, password). Enabled for both storage modes: the default
		 * in-memory limiter, and the database one for multi-instance.
		 */
		rateLimit: {
			enabled: true,
			...(opts.rateLimitStorage === 'database' ? { storage: 'database' as const } : {}),

			/**
			 * VOLUME BACKSTOP ONLY. This counter charges successes, so it must
			 * stay far above anything a human does. The control is
			 * login-throttle.ts, which counts failures only.
			 *
			 * 60 per 60s rather than the library's default 3 per 10s: at 3/10s
			 * a person signing out and back in, or double-tapping submit on a
			 * slow phone, exhausted their own attempts with a correct
			 * password. Measured on 0.2.0. Left enabled so the other auth
			 * endpoints keep their defaults, and set far enough above human
			 * rate that it only fires on genuine volume.
			 */
			customRules: {
				'/sign-in/email': { window: 60, max: 60 }
			}
		},

		advanced: {
			defaultCookieAttributes: {
				sameSite: 'lax'
			},

			/**
			 * PINNED, so CSRF protection never depends on the environment.
			 *
			 * Left unset, better-auth 1.7.6 derives it from NODE_ENV/TEST
			 * (dist/context/create-context.mjs:211):
			 *
			 *   skipOriginCheck: options.advanced?.disableOriginCheck !== void 0
			 *     ? options.advanced.disableOriginCheck
			 *     : isTest() ? true : false,
			 *
			 * and isTest() is `NODE_ENV === "test" || TEST`. So any process that
			 * inherited a test runner's environment served auth with the origin
			 * check OFF. That is how every e2e ran until 0.2.4, and why none of
			 * them could reproduce the 0.2.3 lockout. Production was protected
			 * only because the container happens to set NODE_ENV=production.
			 *
			 * `false` here, not `true`: the check stays ON everywhere, including
			 * in-process tests. auth-origin-check.db.test.ts fails without it.
			 * (`disableCSRFCheck` already defaults to false outright — it is
			 * `!!options.advanced?.disableCSRFCheck` — and is left alone.)
			 */
			disableOriginCheck: false
		}
	});
}

export type Auth = ReturnType<typeof createAuth>;
