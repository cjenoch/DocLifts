import { verifyOAuthQueryParams } from '@better-auth/oauth-provider';
import { auth } from '$lib/server/auth';
import { db } from '$lib/server/db';
import { oauthClient } from '$lib/server/db/auth-schema';
import { eq } from 'drizzle-orm';
import { error } from '@sveltejs/kit';
import { requireUser } from '$lib/server/request-user';
import { MCP_SCOPES, MCP_SCOPE_LABELS, mcpResource } from '$lib/server/mcp/config';
import type { Actions, PageServerLoad } from './$types';
async function consentRequest(url: URL) {
	const signed = url.search.slice(1);
	if (!(await verifyOAuthQueryParams(signed, (await auth.$context).secret)))
		error(400, 'Connection request expired. Start again from your agent.');
	const scopes = (url.searchParams.get('scope') || '').split(' ').filter(Boolean);
	if (scopes.some((s) => ![...MCP_SCOPES, 'offline_access'].includes(s)))
		error(400, 'Unsupported access requested.');
	const resource = url.searchParams.getAll('resource');
	if (resource.length !== 1 || resource[0] !== mcpResource())
		error(400, 'Invalid connection resource.');
	const [client] = await db
		.select({ name: oauthClient.name, id: oauthClient.clientId, disabled: oauthClient.disabled })
		.from(oauthClient)
		.where(eq(oauthClient.clientId, url.searchParams.get('client_id') || ''))
		.limit(1);
	if (!client || client.disabled) error(400, 'Connection unavailable.');
	return { client, scopes, signed };
}
export const load: PageServerLoad = async ({ locals, url }) => {
	const user = requireUser(locals);
	const data = await consentRequest(url);
	return {
		email: user.email,
		client: data.client,
		scopes: data.scopes.map((s) => ({
			id: s,
			label: MCP_SCOPE_LABELS[s] || 'Stay connected for up to 30 days'
		}))
	};
};
export const actions: Actions = {
	default: async ({ locals, url, request }) => {
		requireUser(locals);
		const data = await consentRequest(url);
		const form = await request.formData();
		const response = await auth.handler(
			new Request(new URL('/api/auth/oauth2/consent', url), {
				method: 'POST',
				headers: {
					cookie: request.headers.get('cookie') || '',
					origin: url.origin,
					'content-type': 'application/json'
				},
				body: JSON.stringify({ accept: form.get('decision') === 'allow', oauth_query: data.signed })
			})
		);
		if (!response.ok) error(400, 'Could not finish connection. Start again from your agent.');
		const result = await response.json();
		// The library verifies the registered redirect URI and signed request before returning this URL.
		if (!result.url) error(400, 'Could not finish connection.');
		// A cross-origin redirect after form POST is blocked by form-action self.
		// Return a same-origin completion page; its bundled script navigates,
		// with a normal link as the no-JavaScript fallback. Never weaken CSP.
		return { redirectUrl: result.url as string };
	}
};
