import { z } from 'zod';
import { auth } from '$lib/server/auth';
import { mailConfig } from '$lib/server/mail';
import { resendVerification } from '$lib/server/signup';
import type { Actions } from './$types';

export function load({ url }: { url: URL }) {
	return { error: url.searchParams.has('error'), mailEnabled: mailConfig().provider !== 'off' };
}

export const actions: Actions = {
	default: async ({ request }) => {
		const form = await request.formData();
		const email = z.string().trim().email().max(320).safeParse(form.get('email'));
		if (email.success && mailConfig().provider !== 'off') {
			try {
				await resendVerification(auth, email.data, request.headers, process.env.PUBLIC_ORIGIN!);
			} catch {
				console.error('[mail] verification request failed');
			}
		}
		return {
			message:
				'If that address is waiting for verification, an email is on its way. You can request up to three emails per hour.'
		};
	}
};
