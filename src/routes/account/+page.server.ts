import { fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import { requireUser } from '$lib/server/request-user';
import { db } from '$lib/server/db';
import { auth } from '$lib/server/auth';
import { verifyPasswordViaHandler } from '$lib/server/auth-proxy';
import { deletionEnabled, durableLedger } from '$lib/server/privacy/ledger';
import { requestAccountDeletion } from '$lib/server/privacy/lifecycle';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => ({
	photoRemoved: url.searchParams.get('photoRemoved') === '1',
	email: requireUser(locals).email,
	deletionEnabled: deletionEnabled()
});
const deletionForm = z.object({
	password: z.string().min(1).max(128),
	confirmation: z.literal('DELETE'),
	understand: z.literal('yes')
});
export const actions: Actions = {
	deleteAccount: async ({ request, locals, cookies }) => {
		const user = requireUser(locals);
		if (!deletionEnabled())
			return fail(503, {
				error: 'Self-service deletion is not enabled. Contact support@runthe.ai.'
			});
		const parsed = deletionForm.safeParse(Object.fromEntries(await request.formData()));
		if (!parsed.success)
			return fail(400, {
				error: 'Enter your current password, type DELETE and acknowledge the permanent removal.'
			});
		const verified = await verifyPasswordViaHandler(request.headers, parsed.data.password);
		if (!verified.ok)
			return fail(verified.status === 429 ? 429 : 400, {
				error:
					verified.status === 429
						? 'Too many attempts. Wait a minute and try again.'
						: 'Your password could not be verified. Sign in again or check your current password.'
			});
		// Resolve after password verification; never use a posted account/session ID.
		const session = await auth.api.getSession({ headers: request.headers });
		if (!session || session.user.id !== user.id)
			return fail(401, { error: 'Your session ended. Sign in again.' });
		let job;
		try {
			job = await requestAccountDeletion(db, user.id, session.session.id, durableLedger());
		} catch {
			return fail(503, {
				error:
					'The request could not finish. It may have been recorded; contact support before retrying.'
			});
		}
		if (!job) return fail(401, { error: 'Your session ended or deletion is already pending.' });
		cookies.set('doclifts.deletion', job.id, {
			path: '/privacy',
			httpOnly: true,
			sameSite: 'strict',
			secure: request.url.startsWith('https:'),
			maxAge: 60 * 60 * 24 * 30
		});
		redirect(303, '/privacy');
	}
};
