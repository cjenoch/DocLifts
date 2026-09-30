/**
 * One way to obtain a session against a served build, shared by
 * `auth-hook-guard.test.ts` and `e2e/csp.e2e.ts`.
 *
 * Two implementations of "sign in" will drift, and the one that drifts will be
 * the one that silently stops testing authentication — a fixture that
 * "authenticates" and then actually 303s still passes a naive assertion. So
 * the sequence below lives here exactly once.
 *
 * Every step is load-bearing, and each was found the hard way:
 *
 *  - `createUser` is the operator path (the CLI and any future signup share
 *    it), NOT Better Auth's sign-up endpoint. Sign-up is disabled by
 *    `DOCLIFTS_OPEN_SIGNUP`, and enabling it to make a test pass is not an
 *    option.
 *  - `origin` header: SvelteKit's CSRF check compares it to the request's own
 *    origin. Without it every form POST is a 403.
 *  - `accept: text/html`: without it SvelteKit answers a form POST with a JSON
 *    envelope (`{"type":"redirect","status":303,...}`) at HTTP **200** instead
 *    of a real 303. Browsers send this; a bare `fetch` does not.
 *  - The cookie is read from the response and re-sent as a `Cookie` header.
 *
 * The session cookie is set without `Secure` because these run over
 * `http://127.0.0.1`. That is correct for tests and wrong for production; see
 * the HTTPS item in the T6 handoff rather than "fixing" it here.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { setupTestDb, resetTestDb } from '$lib/server/test-db';
import { createUser } from '$lib/server/users';
import { auth } from './auth';

export const BUILD_ENTRY = 'build/index.js';
export const TEST_PASSWORD = 'correct-horse-battery-staple';

/**
 * The secret the spawned production build signs sessions with.
 *
 * Set EXPLICITLY in the spawn env rather than left to `...process.env`. The
 * spawn already pins DATABASE_URL the same way — the build must not depend on
 * what the invoking shell happened to export. Betting on the default in
 * vite.config.ts would work only because the vitest process set it, and that
 * is exactly the kind of implicit coupling that breaks when the helper is used
 * from somewhere the config did not load.
 *
 * Test-only and worthless outside a test database: a build launched with this
 * secret can only reach doclifts_test.
 */
export const TEST_AUTH_SECRET = 'doclifts-e2e-test-secret-not-a-real-credential';

export const testDatabaseUrl = (): string =>
	process.env.TEST_DATABASE_URL ?? 'postgresql://localhost/doclifts_test';

/**
 * Claim a port by BINDING it, then verify it is still free immediately before
 * the spawn.
 *
 * The lesson of the stale-server blocker: a helper that opened a socket on port
 * 0, read the number, and closed it left a window in which a leftover
 * `node build/index.js` could take the port, and the test would silently assert
 * against THAT process instead of the one it spawned. A green-looking test
 * measuring an unknown binary.
 *
 * So: pick the port, and confirm nothing answers there. If something does, fail
 * loudly rather than test someone else's server.
 */
export async function claimPort(): Promise<number> {
	const srv = createServer();
	await new Promise<void>((resolve, reject) => {
		srv.listen(0, '127.0.0.1', () => resolve());
		srv.on('error', reject);
	});
	const port = (srv.address() as { port: number }).port;
	await new Promise<void>((resolve) => srv.close(() => resolve()));

	const probe = createServer();
	try {
		await new Promise<void>((resolve, reject) => {
			probe.once('error', reject);
			probe.listen(port, '127.0.0.1', () => resolve());
		});
	} catch {
		throw new Error(
			`port ${port} was taken between selection and spawn — another server is running. ` +
				`Kill it (ss -ltnp | grep ${port}) and re-run; these tests must never assert ` +
				`against a process they did not spawn.`
		);
	} finally {
		await new Promise<void>((resolve) => probe.close(() => resolve()));
	}
	return port;
}

export async function waitForServer(origin: string, child: ChildProcess): Promise<void> {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode})`);
		try {
			const res = await fetch(origin + '/login');
			if (res.status < 500) return;
		} catch {
			/* not up yet */
		}
		await new Promise((r) => setTimeout(r, 200));
	}
	throw new Error('server did not come up within 30s');
}

/**
 * Start the production build against the test database on a claimed port.
 * Returns the origin and the child's captured log accessor.
 */
export async function startTestServer(): Promise<{
	origin: string;
	server: ChildProcess;
	log: () => string;
}> {
	if (!existsSync(BUILD_ENTRY)) {
		throw new Error('build/index.js missing — run `pnpm build` first');
	}
	const port = await claimPort();
	const origin = `http://127.0.0.1:${port}`;
	const server = spawn(process.execPath, [BUILD_ENTRY], {
		env: {
			...process.env,
			HOST: '127.0.0.1',
			PORT: String(port),
			ORIGIN: origin,
			DATABASE_URL: testDatabaseUrl(),
			BETTER_AUTH_SECRET: TEST_AUTH_SECRET
		},
		stdio: ['ignore', 'pipe', 'pipe']
	});
	let log = '';
	server.stdout?.on('data', (d) => (log += d));
	server.stderr?.on('data', (d) => (log += d));

	await waitForServer(origin, server);
	return { origin, server, log: () => log };
}

export type TestDb = Awaited<ReturnType<typeof setupTestDb>>['db'];

/** A `createUser`-backed fixture, with the doclifts_test guard applied. */
export async function seedTestUser(
	db: TestDb,
	email = 'guardtest@test.local',
	name = 'Guard Test'
): Promise<{ id: string; email: string }> {
	// Returns the user because callers that build fixtures need the owner id:
	// from T3 on, a program or exercise created without a user_id is invisible
	// to every scoped query, so a fixture that forgets it produces a page that
	// correctly 404s.
	return createUser(auth, db, { email, password: TEST_PASSWORD, name });
}

/**
 * Sign in through the real /login endpoint and return the session cookie as a
 * `Cookie` header value.
 *
 * Goes through the served build, not `auth.api` directly: the point is to prove
 * the whole path, including the `asResponse: true` / Set-Cookie forwarding that
 * a direct API call would skip.
 */
export async function signInAs(
	origin: string,
	{ email = 'guardtest@test.local', password = TEST_PASSWORD } = {}
): Promise<string> {
	const login = await fetch(new URL('/login', origin), {
		method: 'POST',
		headers: {
			'content-type': 'application/x-www-form-urlencoded',
			origin,
			accept: 'text/html'
		},
		body: new URLSearchParams({ email, password }).toString(),
		redirect: 'manual'
	});

	if (login.status !== 303) {
		throw new Error(
			`sign-in for ${email} returned ${login.status}, expected 303. ` +
				`body: ${(await login.text()).slice(0, 400)}`
		);
	}

	// getSetCookie(), not get(): Better Auth can emit several Set-Cookie
	// headers and only one of them is the session.
	const setCookies = login.headers.getSetCookie();
	const session = setCookies.find((c) => c.startsWith('better-auth.session_token='));
	if (!session) {
		throw new Error(
			`sign-in for ${email} set no better-auth.session_token. Saw: ${JSON.stringify(setCookies)}`
		);
	}
	return session.split(';')[0];
}

/** Reset the test DB and return the harness, for callers that need the client. */
export async function freshTestDb(): Promise<Awaited<ReturnType<typeof setupTestDb>>> {
	const harness = await setupTestDb();
	await resetTestDb(harness.client);
	return harness;
}
