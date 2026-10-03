/**
 * The SvelteKit auth singleton.
 *
 * This module is now ONLY the glue: it resolves the two values that cannot be
 * known outside a SvelteKit build — whether we are mid-`vite build`, and what
 * the secret is — and hands them to `createAuth`. Every behaviour decision
 * lives in auth-core.ts, so the CLI (which builds its own instance from
 * process.env, under bare tsx) and the server share one configuration by
 * construction rather than by two copies that must be kept in sync.
 *
 * Do not move configuration back into this file. The reason it is a separate
 * module is that `$env/dynamic/private` and `$app/environment` do not resolve
 * outside SvelteKit's Vite pipeline; putting config here again is what made
 * `pnpm user:bootstrap` unrunnable.
 *
 * Read the installed library's own types before changing anything here — the
 * option names were verified against better-auth 1.7.6's `BetterAuthOptions`
 * and `DrizzleAdapterConfig`, not from memory. See db/auth-schema.ts for the
 * table-naming rationale and auth-core.ts for the configuration itself.
 */
import { building } from '$app/environment';
import { createAuth, type Auth } from './auth-core';
import { db } from './db';
import { sendVerificationMail } from './mail';

/**
 * The secret, with a placeholder during `vite build`.
 *
 * `createAuth(...)` is called at MODULE SCOPE, so whatever this returns is
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
 * from T1a onward. It stayed unexposed only because no route imported the auth
 * module until T2 added the first one, at which point `pnpm build` started
 * requiring a secret it should never have needed.
 */
/**
 * Read a server-side variable from `process.env`, not from `$env/dynamic/private`.
 *
 * WHY NOT `$env/dynamic/private`
 * -----------------------------
 * `env` is populated by SvelteKit's `Server.init()`, which runs at SERVER
 * STARTUP. This module builds the auth instance at MODULE SCOPE — it has to,
 * because `hooks.server.ts` and every route import `auth` as a binding.
 *
 * Module scope is evaluated when the module is first imported, which for the
 * server entry happens BEFORE `Server.init()`. So `$env/dynamic/private` is
 * still `{}` at the moment this line runs, and every read of `env.X` here
 * returns undefined — silently, and for every variable, not just this one.
 *
 * That is not theoretical. It is why `baseURL` was `http://127.0.0.1:3000` in a
 * live container: `PUBLIC_ORIGIN` was correctly present in the environment, but
 * `env.PUBLIC_ORIGIN` was undefined, the `??` fallback engaged, and Better
 * Auth's `isAuthPath` then matched no /api/auth request against that origin —
 * so the entire auth endpoint tree 404'd while the healthcheck stayed green.
 *
 * `process.env` is correct here and is what the CLI already uses. A server-only
 * module reading process.env is not a smell; the rule that matters is that
 * CLIENT code must not, and nothing in `src/lib/server/` is ever bundled to the
 * client.
 */
function serverEnv(name: string): string | undefined {
	return process.env[name];
}

function requireSecret(): string {
	const secret = serverEnv('BETTER_AUTH_SECRET');
	if (!secret) {
		throw new Error(
			'BETTER_AUTH_SECRET not set — check .env (generate with: openssl rand -base64 32)'
		);
	}
	return secret;
}

/**
 * The origin Better Auth builds its baseURL and cookies from.
 *
 * WHY THIS FALLS LOUDLY OUTSIDE DEV AND TEST
 * -----------------------------------------
 * This used to be `env.PUBLIC_ORIGIN ?? 'http://127.0.0.1:3000'` at every call
 * site, and that silent fallback hid a real deployment bug for an entire round.
 *
 * In production the variable arrives as `ORIGIN` in the container (adapter-node
 * reads that for its own CSRF check), while `$env/dynamic/private` is populated
 * only from variables present under their REAL names. So `env.PUBLIC_ORIGIN`
 * was undefined, the fallback engaged, and Better Auth's baseURL became
 * `http://127.0.0.1:3000` — an origin no request ever has. `isAuthPath` then
 * compared every /api/auth request against it, matched nothing, and SvelteKit
 * answered 404 for the entire auth endpoint tree. The healthcheck was green the
 * whole time.
 *
 * A fallback that produces a plausible-looking wrong value is worse than no
 * fallback: it converts a missing-variable error into a silent misconfiguration.
 * Outside dev and test this throws at module load — which adapter-node turns
 * into a non-zero exit before the listener opens, so the failure is a container
 * that refuses to start rather than an app that serves 404s.
 */
function resolveBaseURL(value: string | undefined): string {
	if (value) return value;
	if (building || process.env.NODE_ENV !== 'production') return 'http://127.0.0.1:3000';
	throw new Error(
		'PUBLIC_ORIGIN not set — it must be the origin the browser uses ' +
			'(e.g. https://enochnvps.tail29bbdb.ts.net). It is required in production; ' +
			'without it Better Auth cannot match /api/auth requests and every one 404s.'
	);
}

export const auth: Auth = createAuth(db, {
	secret: building ? 'build-time-placeholder-never-used-at-runtime' : requireSecret(),
	baseURL: resolveBaseURL(serverEnv('PUBLIC_ORIGIN')),
	// Native signup stays closed: all browser creation passes the admission service.
	openSignup: false,
	requireEmailVerification: true,
	sendVerificationEmail: async ({ user, url }) => {
		// Do not make response timing depend on whether this email exists or sends.
		void sendVerificationMail(db, { userId: user.id, to: user.email, url }).catch(() =>
			console.error('[mail] delivery bookkeeping failed')
		);
	},
	rateLimitStorage: serverEnv('DOCLIFTS_RATE_LIMIT_STORAGE') === 'database' ? 'database' : 'memory'
});

export type { Auth };
