import type { Auth } from '$lib/server/auth';

/**
 * Resolved once per request in hooks.server.ts. `null` when the request is
 * unauthenticated. Phase 1 carries no roles or permissions — ownership is
 * enforced per-row via `user_id` (see the accounts work order), not by
 * comparing this object against an admin list.
 */
export type SessionUser = {
	id: string;
	email: string;
	name: string;
};

declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			auth: Auth;
			user: SessionUser | null;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
