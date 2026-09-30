/**
 * Shared bootstrap for the `pnpm user:*` CLIs.
 *
 * These scripts run OUTSIDE SvelteKit, under bare `tsx`. Two consequences,
 * both deliberate:
 *
 *  1. No import of `db/index.ts` or `auth.ts`. Both reach `$env/dynamic/private`
 *     and `$app/environment`, which exist only inside SvelteKit's Vite
 *     pipeline. Importing them under bare tsx fails with
 *     `Cannot find package '$env'`.
 *
 *  2. So the client and the auth instance are built here from process.env,
 *     exactly as `src/lib/server/db/seed.ts` does — the pattern that was
 *     already in the repo and the reason this file looks familiar.
 *
 * The configuration is still NOT duplicated: `createAuth` from auth-core.ts
 * holds every decision, and this only supplies the four values it needs. That
 * is the whole point of the factory — a CLI account and a server account are
 * configured by the same code, so bootstrap cannot create an account the
 * running server would refuse to authenticate.
 *
 * In production these run through scripts/user-prod.sh, which executes them on
 * the Compose network with the production env file, the same way
 * migrate-prod.sh runs migrations.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { createAuth, type Auth } from '../src/lib/server/auth-core';
import * as schema from '../src/lib/server/db/schema';
import { authSchema, authTables } from '../src/lib/server/db/auth-schema';

export type CliContext = {
	db: ReturnType<typeof drizzle<typeof schema>>;
	auth: Auth;
	end: () => Promise<void>;
};

export function createCliContext(): CliContext {
	const url = process.env.DATABASE_URL;
	if (!url) {
		throw new Error('DATABASE_URL is required. Pass --env-file=.env or export it.');
	}
	const secret = process.env.BETTER_AUTH_SECRET;
	if (!secret) {
		// Deliberately fatal and deliberately NOT the build-time placeholder: a
		// CLI creates a real credential hash, and a placeholder here would
		// produce an account that can never sign in.
		throw new Error('BETTER_AUTH_SECRET is required. Generate one with: openssl rand -base64 32');
	}

	const client = postgres(url, { max: 1 });
	const db = drizzle(client, { schema: { ...schema, ...authSchema } });

	return {
		db,
		auth: createAuth(db, {
			secret,
			baseURL: process.env.PUBLIC_ORIGIN ?? 'http://127.0.0.1:3000',
			// The CLI never wants a sign-up endpoint; it creates accounts
			// deliberately through createUser, so the toggle is irrelevant here.
			// Read it anyway so a CLI run and a server run never disagree about
			// the policy if this is ever reused.
			openSignup: process.env.DOCLIFTS_OPEN_SIGNUP === '1',
			rateLimitStorage:
				process.env.DOCLIFTS_RATE_LIMIT_STORAGE === 'database' ? 'database' : 'memory'
		}),
		end: () => client.end()
	};
}

/** `flag value` from argv. */
export function arg(flag: string): string | undefined {
	const i = process.argv.indexOf(flag);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

/**
 * Read a secret from stdin, for `--password-stdin`.
 *
 * A password on the command line is visible in the process list for the life
 * of the command, and lands in shell history. When the operator is rotating a
 * real password that has already been exposed once, neither is acceptable, so
 * the value is read from the first line of stdin instead.
 *
 * The trailing newline is trimmed (so `pass show` / `echo` piping works) but
 * nothing else: leading/trailing spaces are legal in a password and must not
 * be silently eaten. An empty read is refused rather than treated as an empty
 * password, because Better Auth's minimum length would reject it later with a
 * less useful message.
 */
export async function readPasswordFromStdin(): Promise<string | undefined> {
	if (process.stdin.isTTY) {
		console.error(
			'--password-stdin needs a pipe, e.g.\n' +
				'  printf \'%s\' "$(pass show doclifts)" | pnpm user:set-password --email you@example.com --password-stdin'
		);
		return undefined;
	}

	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
	const first = chunks.length ? chunks[0].toString('utf8') : '';
	const line = first.split('\n')[0].replace(/\r$/, '');

	if (!line) {
		console.error('--password-stdin was given an empty password.');
		return undefined;
	}
	return line;
}

/** Run `body`, always closing the client, and exit with the right code. */
export function runCli(body: (ctx: CliContext) => Promise<number>): void {
	const ctx = createCliContext();
	body(ctx)
		.then(async (code) => {
			await ctx.end();
			process.exit(code);
		})
		.catch(async (cause: unknown) => {
			console.error(`\n${cause instanceof Error ? cause.message : String(cause)}\n`);
			await ctx.end();
			process.exit(1);
		});
}

export { authTables };
