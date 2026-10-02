import { requireUser } from '$lib/server/request-user';
import type { PageServerLoad } from './$types';

/**
 * The account page (0.5.5, Part E): the signed-in email, change password, and
 * sign out. Guarded like every non-public route; `requireUser` per T4.
 */
export const load: PageServerLoad = async ({ locals }) => ({
	email: requireUser(locals).email
});
