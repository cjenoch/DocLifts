import { and, eq, gte, sql } from 'drizzle-orm';
import type { Database } from '../progression';
import { mailSends } from '../db/schema';

export type VerificationMessage = { userId: string; to: string; url: string };
/** Only used by development/in-process tests; no HTTP endpoint exposes this. */
export const mailOutbox: VerificationMessage[] = [];

export function mailConfig(env: Record<string, string | undefined> = process.env) {
	const provider = env.MAIL_PROVIDER || 'off';
	if (!['off', 'log', 'resend'].includes(provider)) throw new Error('Invalid MAIL_PROVIDER');
	const dailyLimit = Number(env.MAIL_DAILY_LIMIT || 100);
	if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 10000)
		throw new Error('MAIL_DAILY_LIMIT must be an integer from 1 to 10000');
	const key = env.MAIL_API_KEY || '';
	const from = env.MAIL_FROM || 'DocLifts <no-reply@mail.runthe.ai>';
	const replyTo = env.MAIL_REPLY_TO || 'support@runthe.ai';
	if (provider === 'resend' && !key) throw new Error('MAIL_API_KEY is required for mail');
	return { provider, dailyLimit, key, from, replyTo };
}

export async function sendVerificationMail(
	db: Database,
	message: VerificationMessage,
	env: Record<string, string | undefined> = process.env,
	transport: typeof fetch = fetch
): Promise<void> {
	const config = mailConfig(env);
	if (config.provider === 'off') return;
	// Reserve under a database lock before contacting the provider. Concurrent sends
	// and process restarts cannot exceed the daily or per-account allowance.
	const id = await db.transaction(async (tx) => {
		await tx.execute(sql`select pg_advisory_xact_lock(730142)`);
		const [{ count: daily }] = await tx
			.select({ count: sql<number>`count(*)::int` })
			.from(mailSends)
			.where(gte(mailSends.createdAt, sql`date_trunc('day', now() at time zone 'UTC')`));
		const [{ count: hourly }] = await tx
			.select({ count: sql<number>`count(*)::int` })
			.from(mailSends)
			.where(
				and(
					eq(mailSends.userId, message.userId),
					gte(mailSends.createdAt, sql`now() - interval '1 hour'`)
				)
			);
		if (daily >= config.dailyLimit || hourly >= 3) return null;
		const [row] = await tx
			.insert(mailSends)
			.values({ userId: message.userId, kind: 'verify-email', status: 'pending' })
			.returning({ id: mailSends.id });
		return row.id;
	});
	if (!id) {
		console.warn('[mail] send allowance reached');
		return;
	}
	try {
		let providerId: string | null = null;
		if (config.provider === 'log') {
			// Bounded and deliberately not logged to stdout: the URL is a credential.
			if (mailOutbox.length >= 100) mailOutbox.shift();
			mailOutbox.push({ ...message });
		} else {
			const url = new URL(message.url);
			if (url.origin !== new URL(env.PUBLIC_ORIGIN!).origin) throw new Error('Invalid mail origin');
			const escape = (s: string) =>
				s.replace(
					/[&<>"']/g,
					(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
				);
			const response = await transport('https://api.resend.com/emails', {
				method: 'POST',
				signal: AbortSignal.timeout(10000),
				headers: {
					Authorization: `Bearer ${config.key}`,
					'Content-Type': 'application/json',
					'Idempotency-Key': id
				},
				body: JSON.stringify({
					from: config.from,
					to: message.to,
					reply_to: config.replyTo,
					subject: 'Verify your email for DocLifts',
					text: `DocLifts helps you record your workouts. Verify your email to activate your account:\n\n${message.url}\n\nThis link expires in 30 minutes. DocLifts is a test system and changes often. If you did not request this, ignore this email.`,
					html: `<p>DocLifts helps you record your workouts.</p><p><a href="${escape(message.url)}">Verify your email and activate your account</a></p><p>This link expires in 30 minutes. DocLifts is a test system and changes often.</p><p>If you did not request this, ignore this email.</p>`
				})
			});
			if (!response.ok) throw new Error('Provider refused mail');
			const result = (await response.json()) as { id?: string };
			if (typeof result.id !== 'string') throw new Error('Invalid provider response');
			providerId = result.id;
		}
		await db.update(mailSends).set({ status: 'sent', providerId }).where(eq(mailSends.id, id));
	} catch {
		// Provider errors can echo the message or authorization. Never persist them.
		await db
			.update(mailSends)
			.set({ status: 'failed', error: 'delivery_failed' })
			.where(eq(mailSends.id, id));
	}
}
