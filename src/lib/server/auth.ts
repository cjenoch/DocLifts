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
import { env } from '$env/dynamic/private';
import { building } from '$app/environment';
import { createAuth, type Auth } from './auth-core';
import { db } from './db';

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
function requireSecret(): string {
	const secret = env.BETTER_AUTH_SECRET;
	if (!secret) {
		throw new Error(
			'BETTER_AUTH_SECRET not set — check .env (generate with: openssl rand -base64 32)'
		);
	}
	return secret;
}

export const auth: Auth = createAuth(db, {
	secret: building ? 'build-time-placeholder-never-used-at-runtime' : requireSecret(),
	baseURL: env.PUBLIC_ORIGIN ?? 'http://127.0.0.1:3000',
	openSignup: env.DOCLIFTS_OPEN_SIGNUP === '1',
	rateLimitStorage: env.DOCLIFTS_RATE_LIMIT_STORAGE === 'database' ? 'database' : 'memory'
});

export type { Auth };
