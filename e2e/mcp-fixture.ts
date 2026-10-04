import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { expect } from 'vitest';
export const RESOURCE = 'https://doclifts-mcp.runthe.ai/mcp';
export async function oauthFixture(
	origin: string,
	cookie?: string,
	scopes = 'workouts:read programs:read equipment:read offline_access',
	includeResource = true,
	identity = {
		name: 'Test agent',
		redirects: ['https://client.invalid/callback'],
		callback: 'https://client.invalid/callback'
	}
) {
	const registration = await fetch(origin + '/api/auth/oauth2/register', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			client_name: identity.name,
			redirect_uris: identity.redirects,
			token_endpoint_auth_method: 'none',
			scope: scopes
		})
	});
	expect(registration.status).toBe(201);
	const client = await registration.json();
	const verifier = randomBytes(32).toString('base64url');
	const query = new URLSearchParams({
		client_id: client.client_id,
		redirect_uri: identity.callback,
		response_type: 'code',
		scope: scopes,
		resource: RESOURCE,
		code_challenge_method: 'S256',
		code_challenge: createHash('sha256').update(verifier).digest('base64url'),
		state: randomUUID()
	});
	if (!includeResource) query.delete('resource');
	const authorize = origin + '/api/auth/oauth2/authorize?' + query;
	const response = cookie
		? await fetch(authorize, {
				headers: { cookie, origin, accept: 'text/html' },
				redirect: 'manual'
			})
		: null;
	let consent = response?.headers.get('location');
	if (response && !consent) {
		const result = await response.json().catch(() => ({}));
		if (response.ok && result.redirect === true && typeof result.url === 'string') {
			consent = result.url;
		} else {
			throw new Error(`Authorization fixture returned ${response.status}: no consent redirect`);
		}
	}
	if (consent) {
		const destination = new URL(consent, origin);
		expect(destination.origin).toBe(origin);
		expect(destination.pathname).toBe('/account/connections/consent');
	}
	return { client, verifier, authorize, consent };
}
