import { auth } from '$lib/server/auth';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = ({ request }) => auth.handler(request);
