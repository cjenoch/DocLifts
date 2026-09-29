import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as s from '$lib/server/db/schema';
import { count, eq } from 'drizzle-orm';
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

	it('sign-out clears the session and the next request is 303 again', async () => {
		const out = await fetch(new URL('/logout', origin), {
			method: 'POST',
			headers: {
				cookie,
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
		expect(out.headers.get('location')).toContain('/login');

		const after = await fetch(new URL('/history', origin), {
			headers: { cookie },
			redirect: 'manual'
		});
		expect(after.status).toBe(303);
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
