/**
 * /account/password on the served build — spec §2 item 1.
 *
 * The spec's three assertions, each stated as STATE rather than response
 * shape (a redirect proves the action ran, not that it worked):
 *
 *   - wrong current password -> refused with the reason, nothing changed;
 *   - success -> the previous cookie 303s, the new one works;
 *   - the page is on the guarded list.
 *
 * Plus the ones that make "success" mean something: every session row for the
 * user is deleted, another device's cookie dies too, the old password stops
 * working and the new one starts. And it is reached from a rendered control,
 * not by POSTing to a URL nothing links to.
 *
 * Every request carries an unrelated cookie, per CLAUDE.md: the origin check
 * only runs when a cookie is present, so a cookie-free fixture would test the
 * one condition production never has.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
	freshTestDb,
	seedTestUser,
	signInAs,
	startTestServer,
	TEST_PASSWORD,
	type TestDb
} from '$lib/server/test-auth-helpers';

const EMAIL = 'change-password@test.local';
const NEW_PASSWORD = 'a brand new passphrase';
const UNRELATED_COOKIE = 'theme=dark';

let stopServer = async () => {};
let origin: string;
let db: TestDb;
let userId: string;
let harness: Awaited<ReturnType<typeof freshTestDb>>;

beforeAll(async () => {
	harness = await freshTestDb();
	db = harness.db;
	({ id: userId } = await seedTestUser(db, EMAIL, 'Change Password'));
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

const get = (path: string, session?: string) =>
	fetch(new URL(path, origin), {
		headers: { cookie: [UNRELATED_COOKIE, session].filter(Boolean).join('; ') },
		redirect: 'manual'
	});

const postChange = (
	session: string | undefined,
	fields: { currentPassword: string; newPassword: string; confirmPassword: string }
) =>
	fetch(new URL('/account/password', origin), {
		method: 'POST',
		headers: {
			'content-type': 'application/x-www-form-urlencoded',
			accept: 'text/html',
			origin,
			cookie: [UNRELATED_COOKIE, session].filter(Boolean).join('; ')
		},
		body: new URLSearchParams(fields).toString(),
		redirect: 'manual'
	});

/** Does this password currently sign in? Uses the real /login path. */
const signsIn = async (password: string): Promise<boolean> =>
	signInAs(origin, { email: EMAIL, password }).then(
		() => true,
		() => false
	);

describe('/account/password', () => {
	it('is guarded: an anonymous GET 303s to /login and an anonymous POST changes nothing', async () => {
		const page = await get('/account/password');
		expect(page.status).toBe(303);
		expect(page.headers.get('location')).toMatch(/^\/login/);

		const post = await postChange(undefined, {
			currentPassword: TEST_PASSWORD,
			newPassword: NEW_PASSWORD,
			confirmPassword: NEW_PASSWORD
		});
		expect(post.status).toBe(303);
		expect(await signsIn(TEST_PASSWORD), 'the password must be unchanged').toBe(true);
		expect(await signsIn(NEW_PASSWORD)).toBe(false);
	});

	it('is reached from a rendered control, and renders the form with the minimum', async () => {
		const session = await signInAs(origin, { email: EMAIL });
		// Home -> the account button -> Change password (0.5.5).
		const home = await (await get('/', session)).text();
		expect(home, 'no account button').toMatch(/href=["']\/account["']/);
		const account = await (await get('/account', session)).text();
		expect(account, 'no control links to the change-password page').toMatch(
			/href=["']\/account\/password["']/
		);

		const page = await get('/account/password', session);
		expect(page.status).toBe(200);
		const html = await page.text();
		for (const name of ['currentPassword', 'newPassword', 'confirmPassword']) {
			expect(html).toMatch(new RegExp(`name=["']${name}["']`));
		}
		expect(html).toContain('At least 12 characters');
	});

	it('refuses a wrong current password with the reason, and changes nothing', async () => {
		const session = await signInAs(origin, { email: EMAIL });
		const before = await sessionRows();

		const res = await postChange(session, {
			currentPassword: 'not-the-current-password',
			newPassword: NEW_PASSWORD,
			confirmPassword: NEW_PASSWORD
		});
		expect(res.status).toBe(400);
		const html = await res.text();
		expect(html).toContain('Your current password is not correct');
		expect(html).toContain('data-reason="wrong_current"');

		expect(await sessionRows(), 'a refused change must not touch sessions').toBe(before);
		expect((await get('/history', session)).status, 'this device stays signed in').toBe(200);
		expect(await signsIn(TEST_PASSWORD)).toBe(true);
		expect(await signsIn(NEW_PASSWORD)).toBe(false);
	});

	it('refuses new passwords that do not match, or are under the minimum', async () => {
		const session = await signInAs(origin, { email: EMAIL });

		const mismatch = await postChange(session, {
			currentPassword: TEST_PASSWORD,
			newPassword: NEW_PASSWORD,
			confirmPassword: NEW_PASSWORD + 'x'
		});
		expect(mismatch.status).toBe(400);
		expect(await mismatch.text()).toContain('The two new passwords do not match');

		const short = await postChange(session, {
			currentPassword: TEST_PASSWORD,
			newPassword: 'elevenchars',
			confirmPassword: 'elevenchars'
		});
		expect(short.status).toBe(400);
		expect(await short.text()).toContain('at least 12 characters');

		expect(await signsIn(TEST_PASSWORD)).toBe(true);
	});

	it('on success, deletes every session, keeps this device signed in, and swaps the password', async () => {
		const thisDevice = await signInAs(origin, { email: EMAIL });
		const otherDevice = await signInAs(origin, { email: EMAIL });
		expect(await sessionRows()).toBeGreaterThanOrEqual(2);

		const res = await postChange(thisDevice, {
			currentPassword: TEST_PASSWORD,
			newPassword: NEW_PASSWORD,
			confirmPassword: NEW_PASSWORD
		});
		expect(res.status, (await res.clone().text()).slice(0, 300)).toBe(303);
		expect(res.headers.get('location')).toBe('/account/password?changed=1');

		const fresh = res.headers
			.getSetCookie()
			.find((c) => c.startsWith('better-auth.session_token='))
			?.split(';')[0];
		expect(fresh, 'this device must be handed a new session cookie').toBeDefined();
		expect(fresh).not.toBe(thisDevice);

		// Every previous row deleted; exactly the new one remains.
		expect(await sessionRows(), 'every old session row must be deleted').toBe(1);

		// The previous cookie — this device's and another device's — 303s.
		expect((await get('/history', thisDevice)).status, 'old cookie on this device').toBe(303);
		expect((await get('/history', otherDevice)).status, 'other device').toBe(303);

		// The new one works, and lands on the confirmation.
		expect((await get('/history', fresh)).status).toBe(200);
		expect(await (await get('/account/password?changed=1', fresh)).text()).toContain(
			'Password changed'
		);

		expect(await signsIn(TEST_PASSWORD), 'the old password must stop working').toBe(false);
		expect(await signsIn(NEW_PASSWORD), 'the new password must work').toBe(true);
	});
});
