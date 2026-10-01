/**
 * A stale /login page cannot cause a credential mismatch on its own — spec §2
 * item 5.
 *
 * WHY THIS TEST EXISTS
 * --------------------
 * During the 0.2.3 lockout the leading story was that a stale, cached login
 * page turned a correct password into "do not match". The spec rejected that
 * as an argument and asked for a test: a page fetched BEFORE the password
 * changed must still sign in with the NEW password, because the browser posts
 * what the user typed to the live server and nothing in the page alters it.
 * (The real cause turned out to be the origin check; see sign-in-origin.e2e.)
 *
 * So: fetch /login like a browser would, change the password out of band the
 * way the CLI does (`setPassword`), then submit THE FIELDS OF THAT FETCHED
 * FORM — parsed from its HTML, hidden inputs and all, to its own action — with
 * the new password.
 *
 * What would make it fail: anything that ties a sign-in to the page it came
 * from — a per-render hidden token the action validates, a credential or
 * version cached into the form, a field the action needs that only a fresh
 * render carries. None exists today; this pins that.
 *
 * Two controls keep it from passing vacuously: the out-of-band change must
 * really have happened (the old password, through the same stale form, is
 * refused), and the fields must really come from the fetched page.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { auth } from '$lib/server/auth';
import { setPassword } from '$lib/server/users';
import {
	freshTestDb,
	seedTestUser,
	startTestServer,
	TEST_PASSWORD,
	type TestDb
} from '$lib/server/test-auth-helpers';

const EMAIL = 'stale-page@test.local';
const NEW_PASSWORD = 'changed out of band';
const UNRELATED_COOKIE = 'theme=dark';

let stopServer = async () => {};
let origin: string;
let db: TestDb;
let userId: string;
let harness: Awaited<ReturnType<typeof freshTestDb>>;

beforeAll(async () => {
	harness = await freshTestDb();
	db = harness.db;
	({ id: userId } = await seedTestUser(db, EMAIL, 'Stale Page'));
	({ origin, stop: stopServer } = await startTestServer());
}, 120_000);

afterAll(async () => {
	await stopServer();
	await harness?.end();
});

const sessionRows = async (): Promise<number> =>
	(
		await db.execute<{ n: number }>(
			sql`select count(*)::int as n from "auth"."session" where user_id = ${userId}`
		)
	)[0].n;

/** The sign-in form as served: where it posts, and every input with its value. */
function parseLoginForm(html: string): { action: string; fields: Map<string, string> } {
	const form = html.match(/<form\b[^>]*method=["']POST["'][^>]*>([\s\S]*?)<\/form>/i);
	if (!form) throw new Error('no POST form on /login');
	const action = form[0].match(/\baction=["']([^"']*)["']/i)?.[1] || '/login';
	const fields = new Map<string, string>();
	for (const input of form[1].matchAll(/<input\b[^>]*>/gi)) {
		const name = input[0].match(/\bname=["']([^"']+)["']/i)?.[1];
		if (!name) continue;
		fields.set(name, input[0].match(/\bvalue=["']([^"']*)["']/i)?.[1] ?? '');
	}
	return { action, fields };
}

/** Submit the stale form exactly as fetched, with the user's typing filled in. */
function submitStale(
	stale: { action: string; fields: Map<string, string> },
	cookie: string,
	password: string
) {
	const body = new URLSearchParams();
	for (const [name, value] of stale.fields) {
		if (name === 'email') body.append(name, EMAIL);
		else if (name === 'password') body.append(name, password);
		else body.append(name, value); // anything else: exactly as the old page had it
	}
	return fetch(new URL(stale.action, origin), {
		method: 'POST',
		headers: {
			'content-type': 'application/x-www-form-urlencoded',
			accept: 'text/html',
			origin,
			cookie
		},
		body: body.toString(),
		redirect: 'manual'
	});
}

describe('a login page fetched before a password change', () => {
	it('still signs in with the new password, and refuses the old one', async () => {
		// 1. Fetch /login like a browser, keeping whatever cookies it sets.
		const page = await fetch(new URL('/login', origin), {
			headers: { cookie: UNRELATED_COOKIE }
		});
		expect(page.status).toBe(200);
		const cookie = [UNRELATED_COOKIE, ...page.headers.getSetCookie().map((c) => c.split(';')[0])]
			.filter(Boolean)
			.join('; ');
		const stale = parseLoginForm(await page.text());
		// The fields really come from the page — not a hard-coded body.
		expect([...stale.fields.keys()]).toEqual(expect.arrayContaining(['email', 'password']));

		// 2. Change the password out of band, as the CLI does.
		await setPassword(auth, db, { email: EMAIL, password: NEW_PASSWORD });

		// Control: the change really happened. The old password, through the
		// very same stale form, is refused and creates no session.
		const before = await sessionRows();
		const old = await submitStale(stale, cookie, TEST_PASSWORD);
		expect(old.status, 'the old password must be refused after the change').not.toBe(303);
		expect(await sessionRows()).toBe(before);

		// 3. The stale form with the NEW password signs in.
		const res = await submitStale(stale, cookie, NEW_PASSWORD);
		expect(res.status, (await res.clone().text()).slice(0, 300)).toBe(303);
		expect(await sessionRows(), 'the stale form must create a session').toBe(before + 1);
	});
});
