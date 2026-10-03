import { db } from '$lib/server/db';
import { handleMcp } from '$lib/server/mcp/handler';
import type { RequestHandler } from './$types';
export const POST: RequestHandler = ({ request }) => handleMcp(db, request);
export const GET: RequestHandler = ({ request }) => handleMcp(db, request);
export const DELETE: RequestHandler = ({ request }) => handleMcp(db, request);
