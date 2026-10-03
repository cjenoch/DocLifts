import { createHash, timingSafeEqual } from 'node:crypto';

export function signupConfig(env: Record<string, string | undefined> = process.env) {
	const enabled = env.SIGNUP_ENABLED === '1';
	const inviteCode = env.SIGNUP_INVITE_CODE?.trim() ?? '';
	const maxAccounts = Number(env.SIGNUP_MAX_ACCOUNTS || 25);
	if (!Number.isInteger(maxAccounts) || maxAccounts < 1 || maxAccounts > 1000)
		throw new Error('SIGNUP_MAX_ACCOUNTS must be an integer from 1 to 1000');
	if (enabled && inviteCode.length < 16)
		throw new Error('SIGNUP_INVITE_CODE must have at least 16 characters when signup is enabled');
	if (enabled && !['resend', 'log'].includes(env.MAIL_PROVIDER ?? 'off'))
		throw new Error('Signup requires a configured mail provider');
	return { enabled, inviteCode, maxAccounts };
}

export function inviteMatches(actual: string, expected: string): boolean {
	const hash = (value: string) => createHash('sha256').update(value).digest();
	return !!expected && timingSafeEqual(hash(actual.trim()), hash(expected));
}
