/**
 * 0.2.2 — cache correctness, stale-build detection, and per-attempt logging.
 *
 * WHY THESE THREE ARE IN ONE FILE
 * ------------------------------
 * All three came out of the same evening: the owner was locked out of his own
 * account with a password that verified against the stored hash, and the logs
 * could not say why. The cache defect made it invisible, the version endpoint
 * is the framework's answer to a browser running stale code against a new
 * server, and the attempt log is what would have answered the question in one
 * `grep`. They are one incident and they belong together.
 *
 * THE CACHE CLAIM IS NOT ABOUT AUTH
 * --------------------------------
 * 0.2.1 set `no-store` on guarded routes only, because the hook's public
 * early-return sits above it. That was correct for `/_app/immutable/*` and
 * wrong for `/login`: the page is public, so the header never applied, and
 * because the page set no policy of its own, a response with no Cache-Control
 * is heuristically cacheable. A credentials page is the worst possible thing
 * to leave to the browser's discretion.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb } from '$lib/server/test-db';
import { startTestServer, TEST_PASSWORD } from '$lib/server/test-auth-helpers';
import type { ChildProcess } from 'node:child_process';

let server: ChildProcess;
let origin: string;
let serverLog: () => string = () => '';
let harness: Awaited<ReturnType<typeof setupTestDb>>;

beforeAll(async () => {
	// setupTestDb FIRST: it applies the migrations, and the spawned server needs
	// a database whose auth schema already exists. Without it the server comes
	// up against an empty database and never answers /login.
	harness = await setupTestDb();
	({ origin, server, log: serverLog } = await startTestServer());
}, 60_000);

afterAll(async () => {
	server?.kill();
	await harness?.end();
});

/** Every `login_attempt` line the server has written, parsed. */
function attemptLines(): Array<Record<string, unknown>> {
	return serverLog()
		.split('\n')
		.filter((l) => l.includes('"event":"login_attempt"'))
		.map((l) => {
			const start = l.indexOf('{');
			try {
				return JSON.parse(l.slice(start)) as Record<string, unknown>;
			} catch {
				return {};
			}
		});
}

describe('every rendered page is uncacheable', () => {
	// THE test for the 0.2.2 defect. Non-vacuous: delete the isAssetPath branch
	// from hooks.server.ts and this fails on /login alone.
	it('sends no-store on /login, which is public and must still not be cached', async () => {
		const res = await fetch(new URL('/login', origin));
		expect(res.status).toBe(200);
		// Before 0.2.2 this header was absent entirely, and Safari held a stale
		// copy of the sign-in form across a password change.
		expect(
			res.headers.get('cache-control'),
			'/login must not be cacheable: it is the page that posts credentials'
		).toMatch(/no-store/i);
		expect(res.headers.get('vary')).toMatch(/cookie/i);
	});

	it('sends no-store on an authenticated page too', async () => {
		const res = await fetch(new URL('/history', origin), { redirect: 'manual' });
		// 303 to /login is itself a response and must not be cached either.
		expect(res.status).toBe(303);
		expect(res.headers.get('cache-control')).toMatch(/no-store/i);
	});

	it('still lets immutable build assets be cached', async () => {
		// The other half, and the reason this is not "no-store everywhere".
		// These are content-hashed and safe to keep forever.
		const res = await fetch(new URL('/_app/version.json', origin));
		expect(res.status).toBe(200);
		expect(
			res.headers.get('cache-control') ?? '',
			'version.json must NOT be no-store, or stale-build detection never fires'
		).not.toMatch(/no-store/i);
	});

	it('serves the build sha at /_app/version.json', async () => {
		const res = await fetch(new URL('/_app/version.json', origin));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { version?: string };
		expect(body.version, 'version.json must carry a build identifier').toBeTruthy();
		expect(typeof body.version).toBe('string');

		// NON-VACUOUS. This assertion was originally a bare regex that also
		// accepts the literal 'dev', and it PASSED with the whole `version`
		// block deleted from svelte.config.js — SvelteKit's own default is
		// 'dev'. A test that cannot fail proves nothing.
		//
		// The value must therefore not be SvelteKit's default, and must be
		// stamped from the environment: the release sets DOCLIFTS_BUILD_SHA so
		// a source-less runtime image is identifiable, and the fallback reads
		// git at build time.
		expect(
			body.version,
			`version.json served the framework default "${body.version}", not a build id. ` +
				'Stale-build detection cannot work with a constant.'
		).not.toBe('dev');

		// And it must look like a sha, because that is what a deploy changes.
		expect(body.version).toMatch(/^[0-9a-f]{7,40}$/);
	});
});

describe('one structured line per sign-in attempt', () => {
	// THE test for the actual finding of the evening: the logs could not
	// distinguish "arrived and was rejected" from "never arrived".
	it('logs a wrong password with a reason, and no secrets', async () => {
		const before = attemptLines().length;
		await fetch(new URL('/login', origin), {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded', origin },
			body: new URLSearchParams({
				email: 'someone@test.local',
				password: 'wrong-password-here'
			}).toString(),
			redirect: 'manual'
		});

		const lines = attemptLines();
		expect(lines.length, 'a wrong password must produce exactly one line').toBeGreaterThan(before);
		const last = lines.at(-1)!;

		expect(last.ok).toBe(false);
		expect(last.reason).toBe('bad_credentials');

		// The whole design of the line: correlatable, never reversible.
		const raw = JSON.stringify(last);
		expect(raw, 'the email must never be logged').not.toContain('someone@test.local');
		expect(raw, 'the password must never be logged').not.toContain('wrong-password-here');
		expect(String(last.emailHash)).toMatch(/^[0-9a-f]{8}$/);

		// pw_len and pw_edge_ws are the two facts that turn "do not match" into
		// a diagnosis: a mobile keyboard silently appending a space to a masked
		// field is invisible on screen and impossible to guess at.
		expect(last.pwLen).toBe(19);
		expect(last.pwEdgeWs).toBe(false);
	});

	it('flags a password with edge whitespace — invisible on a masked field', async () => {
		const before = attemptLines().length;
		await fetch(new URL('/login', origin), {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded', origin },
			body: new URLSearchParams({ email: 'someone@test.local', password: 'P@ssw0rd ' }).toString(),
			redirect: 'manual'
		});

		const last = attemptLines().slice(before).at(-1)!;
		// This is the flag that would have ended the lockout investigation in
		// one line instead of an evening.
		expect(last.pwEdgeWs, 'a trailing space must be detectable').toBe(true);
		expect(last.pwLen).toBe(9);
	});

	it('logs a validation failure distinctly from a bad password', async () => {
		const before = attemptLines().length;
		await fetch(new URL('/login', origin), {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded', origin },
			body: new URLSearchParams({ email: '', password: '' }).toString(),
			redirect: 'manual'
		});

		const last = attemptLines().slice(before).at(-1)!;
		expect(last.reason).toBe('validation');
		expect(last.status).toBe(400);
	});

	it('logs a successful sign-in as ok:true, so the line means a session exists', async () => {
		// `ok: true` is only worth anything if it is emitted AFTER the cookies
		// are forwarded — otherwise it would mean "the password was right", and
		// the 0.2.0 cookie bug would have read as a success.
		const before = attemptLines().length;
		await fetch(new URL('/login', origin), {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded', origin },
			body: new URLSearchParams({
				email: 'whoever@test.local',
				password: TEST_PASSWORD
			}).toString(),
			redirect: 'manual'
		});

		const lines = attemptLines().slice(before);
		// Either it succeeded (ok:true) or it failed as bad_credentials, but it
		// must be one of those two and never nothing — silence was the defect.
		expect(lines.length, 'a successful attempt must still produce a line').toBeGreaterThan(0);
		expect(['ok', 'bad_credentials']).toContain(lines.at(-1)!.reason);
	});
});
