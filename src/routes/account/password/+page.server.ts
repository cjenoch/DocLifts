import { fail, redirect } from '@sveltejs/kit';
import { parseSetCookieHeader, toCookieOptions } from 'better-auth/cookies';
import { z } from 'zod';
import { auth } from '$lib/server/auth';
import { changePasswordViaHandler } from '$lib/server/auth-proxy';
import { errorCodeFrom } from '$lib/server/login-attempt-log';
import { requireUser } from '$lib/server/request-user';
import type { Actions, PageServerLoad } from './$types';

/**
 * Change password — spec §2 item 1.
 *
 * Guarded like every non-public route: the hook 303s an anonymous request to
 * /login before `load` or the action runs. `requireUser` is still called in
 * both, per T4, so a guard regression is a 401 here rather than a write.
 *
 * On success Better Auth deletes EVERY session row for the user and issues a
 * new one for this device (see `changePasswordViaHandler`), so the person
 * changing their password stays signed in here and is signed out everywhere
 * else. No CLI in the loop.
 */

/**
 * The minimum Better Auth will actually enforce, read from its resolved
 * context — the same source `users.ts` uses — so the page can never advertise
 * a different number from the one the endpoint applies.
 */
async function minLength(): Promise<number> {
	return (await auth.$context).password.config.minPasswordLength;
}

export const load: PageServerLoad = async ({ locals, url }) => {
	requireUser(locals);
	return {
		minLength: await minLength(),
		changed: url.searchParams.get('changed') === '1'
	};
};

const formSchema = z.object({
	currentPassword: z.string().min(1),
	newPassword: z.string().min(1),
	confirmPassword: z.string().min(1)
});

/** Why a change was refused. Each status gets its own reason, never a catch-all. */
type ChangeReason =
	| 'missing'
	| 'mismatch'
	| 'too_short'
	| 'too_long'
	| 'wrong_current'
	| 'origin_rejected'
	| 'throttled'
	| 'error';

/** One structured line per attempt, like `login_attempt`. Never a password. */
function logChange(entry: {
	ok: boolean;
	status: number;
	reason: ChangeReason | 'ok';
	errorCode?: string;
}): void {
	console.log(JSON.stringify({ event: 'password_change', ...entry }));
}

const refuse = (status: number, reason: ChangeReason, error: string) => {
	logChange({ ok: false, status, reason });
	return fail(status, { reason, error });
};

export const actions: Actions = {
	default: async ({ request, locals, cookies }) => {
		requireUser(locals);

		const parsed = formSchema.safeParse(Object.fromEntries(await request.formData()));
		if (!parsed.success) {
			return refuse(400, 'missing', 'Fill in your current password and the new one twice.');
		}
		const { currentPassword, newPassword, confirmPassword } = parsed.data;

		// Checked here so the message is specific. Better Auth re-checks the
		// length itself; that is the authority, this is the explanation.
		if (newPassword !== confirmPassword) {
			return refuse(400, 'mismatch', 'The two new passwords do not match.');
		}
		const min = await minLength();
		if (newPassword.length < min) {
			return refuse(400, 'too_short', `The new password must be at least ${min} characters.`);
		}

		const result = await changePasswordViaHandler(request.headers, {
			currentPassword,
			newPassword
		});

		if (result.ok) {
			// The NEW session's cookie. Every old session row, including the one
			// that made this request, is already gone. Parsed and re-set for the
			// same reason as in the login action: cookies.set takes a name.
			for (const raw of result.headers.getSetCookie()) {
				for (const [name, attrs] of parseSetCookieHeader(raw)) {
					cookies.set(name, attrs.value, { path: attrs.path || '/', ...toCookieOptions(attrs) });
				}
			}
			logChange({ ok: true, status: result.status, reason: 'ok' });
			redirect(303, '/account/password?changed=1');
		}

		const errorCode = await errorCodeFrom(result);
		const log = (reason: ChangeReason) =>
			logChange({ ok: false, status: result.status, reason, errorCode });

		// The session vanished between the guard and the handler (expired, or
		// revoked from another device). Nothing changed; sign in again.
		if (result.status === 401) {
			log('error');
			redirect(303, '/login');
		}
		if (result.status === 403) {
			log('origin_rejected');
			return fail(403, {
				reason: 'origin_rejected' as const,
				error:
					'The change was blocked by a security check before your password was checked. This is a bug, not a wrong password.'
			});
		}
		if (result.status === 429) {
			log('throttled');
			return fail(429, {
				reason: 'throttled' as const,
				error: 'Too many attempts. Wait a few seconds and try again.'
			});
		}
		if (errorCode === 'INVALID_PASSWORD') {
			log('wrong_current');
			return fail(400, {
				reason: 'wrong_current' as const,
				error: 'Your current password is not correct. Nothing was changed.'
			});
		}
		if (errorCode === 'PASSWORD_TOO_SHORT') {
			log('too_short');
			return fail(400, {
				reason: 'too_short' as const,
				error: `The new password must be at least ${min} characters.`
			});
		}
		if (errorCode === 'PASSWORD_TOO_LONG') {
			log('too_long');
			return fail(400, { reason: 'too_long' as const, error: 'The new password is too long.' });
		}
		log('error');
		return fail(500, {
			reason: 'error' as const,
			error: `The password could not be changed (status ${result.status}). Nothing was changed.`
		});
	}
};
