import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as s from '$lib/server/db/schema';
import { count, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import type { ChildProcess } from 'node:child_process';
import {
	freshTestDb,
	seedTestUser,
	signInAs,
	startTestServer,
	type TestDb
} from '$lib/server/test-auth-helpers';

/**
 * The guard must be AHEAD of form actions, not merely ahead of `load`.
 *
 * `src/hooks.server.ts` `handle` runs for every request and every method, so
 * an anonymous POST to a real action is redirected before the action executes.
 * This is the assertion a layout guard could never satisfy: a guard in `load`
 * still lets `createGym` write its row and only meets the visitor on the
 * re-render.
 *
 * Serves the real production build against the test database, exactly as
 * e2e/csp.e2e.ts does, because a hook bug does not reproduce under a unit-test
 * harness that calls the function directly.
 *
 * Sign-in and the served-build harness come from test-auth-helpers.ts, shared
 * with the e2e crawl so the two cannot drift.
 */

let server: ChildProcess;
let origin: string;
let cookie = '';
let db: TestDb;

const gymCount = async () => (await db.select({ n: count() }).from(s.gyms))[0].n;

beforeAll(async () => {
	const harness = await freshTestDb();
	db = harness.db;
	await seedTestUser(harness.db);

	({ origin, server } = await startTestServer());
	cookie = await signInAs(origin);
}, 180_000);

afterAll(async () => {
	server?.kill('SIGKILL');
});

describe('anonymous requests', () => {
	it('303s a POST to a real form action and writes nothing', async () => {
		const before = await gymCount();

		const res = await fetch(new URL('/gyms?/createGym', origin), {
			method: 'POST',
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
				origin,
				accept: 'text/html'
			},
			body: new URLSearchParams({ name: 'Should Not Exist' }).toString(),
			redirect: 'manual'
		});

		expect(res.status, 'anonymous POST to an action must be redirected').toBe(303);
		expect(res.headers.get('location')).toContain('/login');
		expect(await gymCount(), 'the action must not have run').toBe(before);
	});

	it('303s a GET of a protected page', async () => {
		const res = await fetch(new URL('/history', origin), { redirect: 'manual' });
		const loc = res.headers.get('location');
		expect(res.status, `status=${res.status} loc=${loc}`).toBe(303);
		expect(loc).toContain('/login');
	});

	it('lets /login through', async () => {
		const res = await fetch(new URL('/login', origin), { redirect: 'manual' });
		expect(res.status).toBe(200);
	});
});

describe('signed-in requests', () => {
	it('runs the action and writes the row', async () => {
		const before = await gymCount();
		const res = await fetch(new URL('/gyms?/createGym', origin), {
			method: 'POST',
			headers: {
				'content-type': 'application/x-www-form-urlencoded',
				cookie,
				origin,
				accept: 'text/html'
			},
			body: new URLSearchParams({ name: 'Legit Gym' }).toString(),
			redirect: 'manual'
		});
		// createGym returns `{ message }` rather than redirecting, so 200 is
		// the correct response for a successful action. The row is the claim.
		expect(res.status).toBe(200);
		expect(await gymCount()).toBe(before + 1);
		const rows = await db.select().from(s.gyms).where(eq(s.gyms.name, 'Legit Gym'));
		expect(rows.length, 'the authenticated action must have written its row').toBe(1);
	});

	it('serves a protected page', async () => {
		const res = await fetch(new URL('/history', origin), {
			headers: { cookie },
			redirect: 'manual'
		});
		expect(res.status).toBe(200);
	});

	/**
	 * Sign-out must be asserted by the STATE it leaves behind, not by the
	 * redirect. This test used to assert `303 -> /login` and a following 303
	 * on /history, and it passed in every run while logout was completely
	 * broken in production: the action redirects to /login whether or not the
	 * handler found a session, so nothing about the response shape could tell
	 * the two cases apart. The 303 on /history passed for the same reason —
	 * SvelteKit redirects an unauthenticated request regardless.
	 *
	 * So assert three things, none of which the action can fake:
	 *   1. the session ROW is gone from auth.session;
	 *   2. the response clears the cookie NAME sign-in actually set (read it
	 *      off the sign-in response, never hardcoded — over https that name is
	 *      __Secure-better-auth.session_token);
	 *   3. a client that KEPT the old cookie still gets 303, which is only
	 *      true if the server-side session is dead.
	 */
	it('sign-out deletes the session row, clears the cookie, and 303s a client that kept it', async () => {
		const liveCookie = await signInAs(origin);
		const tokenName = liveCookie.split('=')[0];
		const tokenValue = liveCookie.split('=')[1];

		const rows = () =>
			db.execute<{ n: number }>(sql`select count(*)::int as n from "auth"."session"`);

		const before = (await rows())[0].n;
		expect(before, 'a fresh sign-in must create a session row').toBeGreaterThan(0);

		const out = await fetch(new URL('/logout', origin), {
			method: 'POST',
			headers: {
				cookie: liveCookie,
				origin,
				accept: 'text/html',
				// Without a form content-type SvelteKit answers 415 — it is
				// parsing this as a form action, not a bare POST.
				'content-type': 'application/x-www-form-urlencoded'
			},
			body: '',
			redirect: 'manual'
		});
		expect(out.status).toBe(303);

		// 1. The row must actually be deleted.
		const after = (await rows())[0].n;
		expect(after, 'POST /logout must delete the session row').toBe(before - 1);

		// 2. Every clearing cookie must come back, including the one whose name
		//    sign-in used. getSetCookie() because sign-out emits several.
		const cleared = out.headers.getSetCookie();
		const sessionClear = cleared.find((c) => c.startsWith(`${tokenName}=`));
		expect(
			sessionClear,
			`no Set-Cookie clearing ${tokenName}. Saw: ${JSON.stringify(cleared)}`
		).toBeDefined();
		expect(sessionClear).toMatch(/Max-Age=0/i);

		// 3. A client that ignored the clearing cookie must still be anonymous.
		const retry = await fetch(new URL('/history', origin), {
			headers: { cookie: `${tokenName}=${tokenValue}` },
			redirect: 'manual'
		});
		expect(retry.status, 'a kept cookie must not authenticate once the session is gone').toBe(303);
	});

	// Found on 0.2.0, in a real browser, after the release was called done.
	// The server was correct throughout: the session was destroyed, the
	// cookies were cleared, and a client that kept the cookie was refused.
	// What failed was that nothing told the BROWSER not to keep the page.
	it('sends no-store on an authenticated page', async () => {
		const res = await fetch(new URL('/history', origin), {
			headers: { cookie },
			redirect: 'manual'
		});
		expect(res.status).toBe(200);
		// Without this, BACK after signing out re-renders the page from the
		// browser's own cache: the user's workouts, with no login form, and
		// nothing they can do about it. Measured in Chrome, not inferred.
		expect(res.headers.get('cache-control')).toMatch(/no-store/i);
		// A shared cache in front of this app must not be able to hand one
		// person's history to another. The session is in a cookie, so the
		// response genuinely varies on it.
		expect(res.headers.get('vary')).toMatch(/cookie/i);
	});

	it('does not sign anyone out on GET /logout', async () => {
		// A prefetch or crawler must never end a session.
		const res = await fetch(new URL('/logout', origin), {
			headers: { cookie },
			redirect: 'manual'
		});
		expect(res.status, 'GET /logout must not be a sign-out').not.toBe(303);
	});
});
