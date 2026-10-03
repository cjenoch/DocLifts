import { mcpResource, MCP_SCOPES } from '$lib/server/mcp/config';
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = ({ params }) => {
	if (params.path && params.path !== 'mcp') error(404, 'Not found');
	return json(
		{
			resource: mcpResource(),
			authorization_servers: [`${process.env.PUBLIC_ORIGIN}/api/auth`],
			scopes_supported: [...MCP_SCOPES],
			bearer_methods_supported: ['header']
		},
		{ headers: { 'cache-control': 'no-store' } }
	);
};
