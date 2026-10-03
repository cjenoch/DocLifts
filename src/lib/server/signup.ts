import { createHmac } from 'node:crypto';
import { and, eq, gte, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from './progression';
import { createAuth, passwordMinLength, type Auth } from './auth-core';
import { createUser } from './users';
import { authUsers, signupAdmissions, signupAttempts } from './db/schema';
import { clientIpFrom } from './client-ip';
import { inviteMatches, signupConfig } from './signup-config';
import { forwardedHeaders } from './auth-proxy';

export const signupMessage =
	'If your details qualify, a verification email is on its way. Open it to activate your account. Already registered? Sign in instead.';

export async function registerPilot(
	db: Database,
	auth: Auth,
	input: Record<string, unknown>,
	headers: Headers,
	env: Record<string, string | undefined> = process.env
): Promise<'accepted' | 'invalid' | 'closed'> {
	const config = signupConfig(env);
	if (!config.enabled) return 'closed';
	const parsed = z
		.object({
			name: z.string().trim().min(1).max(120),
			email: z
				.string()
				.trim()
				.email()
				.max(320)
				.transform((v) => v.toLowerCase()),
			password: z.string().min(passwordMinLength(env)).max(128),
			confirmation: z.string(),
			inviteCode: z.string().max(256),
			consent: z.literal('yes'),
			website: z.literal('')
		})
		.refine((v) => v.password === v.confirmation)
		.safeParse(input);
	if (!parsed.success) return 'invalid';
	const value = parsed.data;
	const ip = clientIpFrom(headers, env);
	if (!ip) return 'accepted'; // Fail closed when the trusted address is unavailable.
	const secret = env.BETTER_AUTH_SECRET;
	if (!secret) throw new Error('BETTER_AUTH_SECRET is required');
	const hash = (s: string) => createHmac('sha256', secret).update(s).digest('hex');
	const ipHash = hash('ip:' + ip),
		emailHash = hash('email:' + value.email);
	const created = await db.transaction(async (tx) => {
		// Serializes rate reservation + admission count + account creation across workers.
		await tx.execute(sql`select pg_advisory_xact_lock(730141)`);
		await tx
			.delete(signupAttempts)
			.where(sql`${signupAttempts.createdAt} < now() - interval '1 day'`);
		const recent = gte(signupAttempts.createdAt, sql`now() - interval '1 hour'`);
		const [{ count: byIp }] = await tx
			.select({ count: sql<number>`count(*)::int` })
			.from(signupAttempts)
			.where(and(recent, eq(signupAttempts.ipHash, ipHash)));
		const [{ count: byEmail }] = await tx
			.select({ count: sql<number>`count(*)::int` })
			.from(signupAttempts)
			.where(and(recent, eq(signupAttempts.emailHash, emailHash)));
		const [{ count: global }] = await tx
			.select({ count: sql<number>`count(*)::int` })
			.from(signupAttempts)
			.where(recent);
		if (byIp >= 5 || byEmail >= 3 || global >= 30) return false;
		await tx.insert(signupAttempts).values({ ipHash, emailHash });
		if (!inviteMatches(value.inviteCode, config.inviteCode)) return false;
		const [existing] = await tx
			.select({ id: authUsers.id })
			.from(authUsers)
			.where(eq(authUsers.email, value.email));
		if (existing) return false;
		const [{ count }] = await tx
			.select({ count: sql<number>`count(*)::int` })
			.from(signupAdmissions);
		if (count >= config.maxAccounts) return false;
		const transactionalAuth = createAuth(tx, {
			secret,
			baseURL: env.PUBLIC_ORIGIN!,
			openSignup: false,
			rateLimitStorage: 'memory',
			requireEmailVerification: true
		});
		const user = await createUser(transactionalAuth, tx, value, { emailVerified: false });
		await tx.insert(signupAdmissions).values({ userId: user.id });
		return true;
	});
	if (created) await resendVerification(auth, value.email, headers, env.PUBLIC_ORIGIN!);
	return 'accepted';
}

export async function resendVerification(
	auth: Auth,
	email: string,
	incoming: Headers,
	origin: string
) {
	return auth.handler(
		new Request(new URL('/api/auth/send-verification-email', origin), {
			method: 'POST',
			headers: forwardedHeaders(incoming, { contentType: 'application/json' }),
			body: JSON.stringify({ email, callbackURL: new URL('/verify', origin).href })
		})
	);
}
