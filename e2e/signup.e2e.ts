import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { eq } from 'drizzle-orm';
import { setupTestDb, resetTestDb } from '$lib/server/test-db';
import { startTestServer, TEST_AUTH_SECRET } from '$lib/server/test-auth-helpers';
import { createAuth } from '$lib/server/auth-core';
import { authUsers, signupAdmissions } from '$lib/server/db/schema';

let h: Awaited<ReturnType<typeof setupTestDb>>;
let server: Awaited<ReturnType<typeof startTestServer>>;
let browser: Browser;
const code = 'test-only-pilot-invite';
const password = 'test-only-long-password';
beforeAll(async () => {
	h = await setupTestDb();
	await resetTestDb(h.client);
	server = await startTestServer({
		SIGNUP_ENABLED: '1',
		SIGNUP_INVITE_CODE: code,
		SIGNUP_MAX_ACCOUNTS: '2',
		MAIL_PROVIDER: 'log',
		CLIENT_IP_HEADER: 'cf-connecting-ip'
	});
	browser = await chromium.launch({ executablePath: process.env.PW_EXECUTABLE_PATH });
}, 60000);
afterAll(async () => {
	await browser?.close();
	await server?.stop();
	await h?.end();
});

describe('public pilot signup on a phone', () => {
	it('renders the active form, verifies email, then signs in without sideways scrolling or CSP failures', async () => {
		const context = await browser.newContext({
			viewport: { width: 390, height: 844 },
			extraHTTPHeaders: { 'cf-connecting-ip': '192.0.2.111' }
		});
		const page = await context.newPage();
		page.setDefaultTimeout(5000);
		await page.addInitScript(() => {
			(window as unknown as { csp: string[] }).csp = [];
			document.addEventListener('securitypolicyviolation', (e) => {
				if (e.violatedDirective !== 'style-src-attr')
					(window as unknown as { csp: string[] }).csp.push(e.violatedDirective);
			});
		});
		await page.goto(server.origin + '/login');
		await page.getByRole('link', { name: 'Create an account', exact: true }).click();
		await page.getByLabel('Name', { exact: true }).fill('Phone Pilot');
		await page.getByLabel('Email', { exact: true }).fill('phone-pilot@example.test');
		await page.getByLabel('Invite code', { exact: true }).fill(code);
		await page.getByLabel('Password', { exact: true }).fill(password);
		await page.getByLabel('Confirm password', { exact: true }).fill(password);
		await page.getByRole('checkbox').check();
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
			390
		);
		expect(
			await page.evaluate(
				() =>
					[...document.querySelectorAll('[style]')].filter((e) => e.id !== 'svelte-announcer')
						.length
			)
		).toBe(0);
		expect(await page.evaluate(() => (window as unknown as { csp: string[] }).csp)).toEqual([]);
		await page.getByRole('button', { name: 'Create account', exact: true }).click();
		await page.getByRole('status').filter({ hasText: 'verification email' }).waitFor();
		const [user] = await h.db
			.select()
			.from(authUsers)
			.where(eq(authUsers.email, 'phone-pilot@example.test'));
		expect(user.emailVerified).toBe(false);
		expect(await h.db.select().from(signupAdmissions)).toHaveLength(1);
		await page.goto(server.origin + '/login');
		await page.locator('input[name=email]').fill(user.email);
		await page.locator('#password').fill(password);
		await page.locator('form:has(#password) button[type=submit]').click();
		await page.getByRole('alert').filter({ hasText: 'Verify your email' }).waitFor();
		let verificationUrl = '';
		// Issue a real library link using the same test secret as the served build;
		// no production outbox or debug route exists to retrieve live credentials.
		const issuer = createAuth(h.db, {
			secret: TEST_AUTH_SECRET,
			baseURL: server.origin,
			openSignup: false,
			rateLimitStorage: 'memory',
			sendVerificationEmail: async ({ url }) => {
				verificationUrl = url;
			}
		});
		await issuer.api.sendVerificationEmail({
			body: { email: user.email, callbackURL: server.origin + '/verify' }
		});
		expect(verificationUrl).toContain('/api/auth/verify-email?');
		const result = await page.goto(verificationUrl);
		expect(result?.headers()['referrer-policy']).toBe('strict-origin-when-cross-origin');
		const tokenResponse = await fetch(verificationUrl, { redirect: 'manual' });
		expect(tokenResponse.headers.get('referrer-policy')).toBe('no-referrer');
		expect(page.url()).toBe(server.origin + '/verify');
		await page.getByRole('link', { name: 'Sign in', exact: true }).click();
		await page.waitForURL(server.origin + '/login');
		await page.getByRole('button', { name: 'Show password', exact: true }).waitFor();
		await page.waitForLoadState('networkidle');
		await page.locator('input[name=email]').fill(user.email);
		await page.locator('#password').fill(password);
		await page.locator('form:has(#password) button[type=submit]').click();
		await page.waitForURL(server.origin + '/');
		expect(server.log()).not.toContain(new URL(verificationUrl).searchParams.get('token'));
		await context.close();
	}, 30000);

	it('rejects cross-origin creation and native API bypasses while permitting existing sign-in', async () => {
		const cross = await fetch(server.origin + '/signup', {
			method: 'POST',
			redirect: 'manual',
			headers: {
				origin: 'https://attacker.invalid',
				'content-type': 'application/x-www-form-urlencoded'
			},
			body: new URLSearchParams({ email: 'other@example.test' })
		});
		expect(cross.status).toBe(403);
		const direct = await fetch(server.origin + '/api/auth/sign-up/email', {
			method: 'POST',
			headers: { origin: server.origin, 'content-type': 'application/json' },
			body: JSON.stringify({ name: 'Bypass', email: 'bypass@example.test', password })
		});
		expect(direct.ok).toBe(false);
		expect(
			await h.db.select().from(authUsers).where(eq(authUsers.email, 'bypass@example.test'))
		).toHaveLength(0);
	});

	it('disables browser registration without disturbing existing accounts', async () => {
		const closed = await startTestServer({ SIGNUP_ENABLED: '0' });
		try {
			const html = await (await fetch(closed.origin + '/signup')).text();
			expect(html).toContain('New accounts are paused');
			expect(html).not.toContain('name="password"');
		} finally {
			await closed.stop();
		}
	});
});
