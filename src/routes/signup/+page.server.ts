import { fail } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { auth } from '$lib/server/auth';
import { passwordMinLength } from '$lib/server/auth-core';
import { signupConfig } from '$lib/server/signup-config';
import { registerPilot, signupMessage } from '$lib/server/signup';
import type { Actions } from './$types';

export function load() {
	return { enabled: signupConfig().enabled, minimum: passwordMinLength() };
}

export const actions: Actions = {
	default: async ({ request }) => {
		const form = await request.formData();
		try {
			const outcome = await registerPilot(db, auth, Object.fromEntries(form), request.headers);
			if (outcome === 'closed') return fail(403, { error: 'New accounts are paused.' });
			if (outcome === 'invalid')
				return fail(400, {
					error: `Check your details, match both passwords (at least ${passwordMinLength()} characters), and accept the test-system notice.`
				});
			return { message: signupMessage };
		} catch {
			console.error('[signup] registration failed');
			return fail(503, { error: 'We could not finish that request. Please try again shortly.' });
		}
	}
};
