import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { setupTestDb, resetTestDb } from './test-db';
import { createAuth, type Auth } from './auth-core';
import { registerPilot, resendVerification } from './signup';
import { inviteMatches, signupConfig } from './signup-config';
import { mailConfig, mailOutbox, sendVerificationMail } from './mail';
import {
	authUsers,
	authAccounts,
	signupAdmissions,
	signupAttempts,
	mailSends,
	exercises
} from './db/schema';

const env = {
	SIGNUP_ENABLED: '1',
	SIGNUP_INVITE_CODE: 'test-only-pilot-invite',
	SIGNUP_MAX_ACCOUNTS: '25',
	MAIL_PROVIDER: 'log',
	MAIL_DAILY_LIMIT: '100',
	BETTER_AUTH_SECRET: 'signup-test-secret-not-a-production-credential',
	PUBLIC_ORIGIN: 'http://127.0.0.1:3000'
};
const input = (email = 'new@example.test') => ({
	name: 'New Lifter',
	email,
	password: 'test-only-long-password',
	confirmation: 'test-only-long-password',
	inviteCode: env.SIGNUP_INVITE_CODE,
	consent: 'yes',
	website: ''
});
let testIp = 10;
const headers = (ip = '192.0.2.' + testIp) =>
	new Headers({ origin: env.PUBLIC_ORIGIN, 'x-forwarded-for': ip });
let h: Awaited<ReturnType<typeof setupTestDb>>;
let auth: Auth;
beforeAll(async () => {
	h = await setupTestDb();
});
beforeEach(async () => {
	testIp++;
	await resetTestDb(h.client);
	mailOutbox.length = 0;
	auth = createAuth(h.db, {
		secret: env.BETTER_AUTH_SECRET,
		baseURL: env.PUBLIC_ORIGIN,
		openSignup: false,
		rateLimitStorage: 'memory',
		requireEmailVerification: true,
		sendVerificationEmail: ({ user, url }) =>
			sendVerificationMail(h.db, { userId: user.id, to: user.email, url }, env)
	});
});
afterAll(async () => {
	await h?.end();
});

describe('pilot admission and email verification', () => {
	it('keeps an admitted account locked until its library-issued email link is verified', async () => {
		expect(await registerPilot(h.db, auth, input(), headers(), env)).toBe('accepted');
		const [user] = await h.db
			.select()
			.from(authUsers)
			.where(eq(authUsers.email, 'new@example.test'));
		expect(user.emailVerified).toBe(false);
		expect(await h.db.select().from(exercises).where(eq(exercises.userId, user.id))).toHaveLength(
			23
		);
		const signIn = () =>
			auth.handler(
				new Request(env.PUBLIC_ORIGIN + '/api/auth/sign-in/email', {
					method: 'POST',
					headers: { 'content-type': 'application/json', origin: env.PUBLIC_ORIGIN },
					body: JSON.stringify({ email: user.email, password: input().password })
				})
			);
		expect((await signIn()).status).toBe(403);
		expect(mailOutbox).toHaveLength(1);
		const url = mailOutbox[0].url;
		expect(new URL(url).origin).toBe(env.PUBLIC_ORIGIN);
		expect((await auth.handler(new Request(url))).status).toBe(302);
		expect((await signIn()).status).toBe(200);
		const records = await h.db.select().from(mailSends);
		expect(records[0]).toMatchObject({ status: 'sent', kind: 'verify-email' });
		expect(JSON.stringify(records)).not.toContain(new URL(url).searchParams.get('token'));
	});
	it('refuses missing consent, wrong codes, honeypots, and the native signup bypass', async () => {
		expect(await registerPilot(h.db, auth, { ...input(), consent: '' }, headers(), env)).toBe(
			'invalid'
		);
		expect(await registerPilot(h.db, auth, { ...input(), website: 'bot' }, headers(), env)).toBe(
			'invalid'
		);
		expect(
			await registerPilot(h.db, auth, { ...input(), inviteCode: 'wrong' }, headers(), env)
		).toBe('accepted');
		const r = await auth.handler(
			new Request(env.PUBLIC_ORIGIN + '/api/auth/sign-up/email', {
				method: 'POST',
				headers: { 'content-type': 'application/json', origin: env.PUBLIC_ORIGIN },
				body: JSON.stringify(input())
			})
		);
		expect(r.ok).toBe(false);
		expect(await h.db.select().from(signupAdmissions)).toHaveLength(0);
		expect(mailOutbox).toHaveLength(0);
	});
	it('reserves the last account atomically across concurrent requests', async () => {
		await Promise.all(
			['one', 'two', 'three'].map((name, i) =>
				registerPilot(h.db, auth, input(name + '@example.test'), headers('192.0.2.' + (20 + i)), {
					...env,
					SIGNUP_MAX_ACCOUNTS: '1'
				})
			)
		);
		expect(await h.db.select().from(signupAdmissions)).toHaveLength(1);
		expect(await h.db.select().from(authAccounts)).toHaveLength(1);
	});
	it('does not replace an existing password or reveal an existing address', async () => {
		await registerPilot(h.db, auth, input(), headers(), env);
		const [before] = await h.db.select().from(authAccounts);
		expect(
			await registerPilot(
				h.db,
				auth,
				{
					...input(),
					password: 'different-password-value',
					confirmation: 'different-password-value'
				},
				headers(),
				env
			)
		).toBe('accepted');
		const [after] = await h.db.select().from(authAccounts);
		expect(after.password).toBe(before.password);
		expect(mailOutbox).toHaveLength(1);
	});
	it('uses the trusted address and limits failures across different emails', async () => {
		const trusted = new Headers({
			origin: env.PUBLIC_ORIGIN,
			'cf-connecting-ip': '2001:db8:1:2::1'
		});
		for (let i = 0; i < 5; i++) {
			trusted.set('x-forwarded-for', '192.0.2.' + i);
			await registerPilot(
				h.db,
				auth,
				{ ...input(i + '@example.test'), inviteCode: 'wrong' },
				trusted,
				{ ...env, CLIENT_IP_HEADER: 'cf-connecting-ip' }
			);
		}
		trusted.set('cf-connecting-ip', '2001:db8:1:2::ffff');
		await registerPilot(h.db, auth, input(), trusted, {
			...env,
			CLIENT_IP_HEADER: 'cf-connecting-ip'
		});
		expect(await h.db.select().from(signupAdmissions)).toHaveLength(0);
		expect(await h.db.select().from(signupAttempts)).toHaveLength(5);
	});
	it('supports mail retries without exceeding three sends per account per hour', async () => {
		await registerPilot(h.db, auth, input(), headers(), env);
		const message = mailOutbox[0];
		await Promise.all(Array.from({ length: 5 }, () => sendVerificationMail(h.db, message, env)));
		expect(mailOutbox).toHaveLength(3);
		expect(await h.db.select().from(mailSends)).toHaveLength(3);
	});
	it('reserves a site-wide mail budget and records sanitized delivery failures', async () => {
		await registerPilot(h.db, auth, input(), headers(), env);
		const message = mailOutbox[0];
		await sendVerificationMail(h.db, message, { ...env, MAIL_DAILY_LIMIT: '1' });
		expect(mailOutbox).toHaveLength(1);
		await sendVerificationMail(
			h.db,
			message,
			{ ...env, MAIL_PROVIDER: 'resend', MAIL_API_KEY: 'test-only' },
			async () => {
				throw new Error('secret URL should never be recorded ' + message.url);
			}
		);
		const rows = await h.db.select().from(mailSends);
		expect(rows.find((r) => r.status === 'failed')?.error).toBe('delivery_failed');
		expect(JSON.stringify(rows)).not.toContain(message.url);
	});
	it('ignores unknown resend addresses, rejects tampering and expired verification tokens', async () => {
		await resendVerification(auth, 'absent@example.test', headers(), env.PUBLIC_ORIGIN);
		expect(mailOutbox).toHaveLength(0);
		await registerPilot(h.db, auth, input(), headers(), env);
		const bad = new URL(mailOutbox[0].url);
		bad.searchParams.set('token', 'tampered');
		const response = await auth.handler(new Request(bad));
		expect(response.headers.get('location')).toContain('error=');
		const expired = createAuth(h.db, {
			secret: env.BETTER_AUTH_SECRET,
			baseURL: env.PUBLIC_ORIGIN,
			openSignup: false,
			rateLimitStorage: 'memory'
		});
		// The real library checks signed JWT expiry; set its lifetime below zero for this fixture.
		expired.options.emailVerification!.expiresIn = -1;
		expired.options.emailVerification!.sendVerificationEmail = async ({ user, url }) => {
			await sendVerificationMail(h.db, { userId: user.id, to: user.email, url }, env);
		};
		await resendVerification(expired, input().email, headers(), env.PUBLIC_ORIGIN);
		const old = await auth.handler(new Request(mailOutbox.at(-1)!.url));
		expect(old.headers.get('location')).toContain('error=TOKEN_EXPIRED');
		expect(
			(await h.db.select().from(authUsers).where(eq(authUsers.email, input().email)))[0]
				.emailVerified
		).toBe(false);
	});
	it('fails closed for disabled signup or absent trusted identity', async () => {
		expect(
			await registerPilot(h.db, auth, input(), headers(), { ...env, SIGNUP_ENABLED: '0' })
		).toBe('closed');
		await registerPilot(h.db, auth, input(), headers(), {
			...env,
			CLIENT_IP_HEADER: 'cf-connecting-ip'
		});
		expect(await h.db.select().from(signupAdmissions)).toHaveLength(0);
	});
	it('validates boot settings and compares invite codes without length leaks', () => {
		expect(() => signupConfig({ ...env, SIGNUP_INVITE_CODE: '' })).toThrow();
		expect(() => signupConfig({ ...env, MAIL_PROVIDER: 'off' })).toThrow();
		expect(() => mailConfig({ MAIL_PROVIDER: 'resend' })).toThrow();
		expect(inviteMatches('wrong', env.SIGNUP_INVITE_CODE)).toBe(false);
		expect(inviteMatches(env.SIGNUP_INVITE_CODE, env.SIGNUP_INVITE_CODE)).toBe(true);
	});
});
