import { db } from '$lib/server/db';
import { requireUser } from '$lib/server/request-user';
import { connectionsForUser, revokeConnection } from '$lib/server/mcp/access';
import { mcpResource } from '$lib/server/mcp/config';
import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
export const load: PageServerLoad = async ({ locals }) => ({
	connections: await connectionsForUser(db, requireUser(locals).id),
	endpoint: mcpResource()
});
export const actions: Actions = {
	revoke: async ({ locals, request }) => {
		const id = (await request.formData()).get('clientId');
		if (typeof id !== 'string' || id.length > 2048)
			return fail(400, { message: 'Invalid connection.' });
		await revokeConnection(db, requireUser(locals).id, id);
		return { message: 'Access revoked. Previously downloaded data stays with that client.' };
	}
};
