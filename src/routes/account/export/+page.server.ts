import { requireUser } from '$lib/server/request-user';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = ({ locals }) => {
	requireUser(locals);
	return {};
};
