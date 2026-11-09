import { gt, isNull, type SQL } from 'drizzle-orm';
import { authSessions, authUsers } from './db/schema';

/**
 * Login-session and account liveness, spelled once. Neutral ground: MCP
 * (`mcp/grant-validity.ts`), the account export (`exports/data.ts`) and the
 * deletion request (`privacy/lifecycle.ts`) all import from here, and none of
 * them imports from another's module for it. `session-liveness-seam.test.ts`
 * fails the server project if `authSessions.expiresAt` is spelled anywhere else.
 */

/** The one spelling of "this login session is still live": unexpired. A deleted
 * session has no row, so callers that join or test existence also refuse it. */
export function sessionIsLive(now: Date = new Date()): SQL {
	return gt(authSessions.expiresAt, now);
}

/** The account is not fenced for deletion. Code that must act on a fenced
 * account (erasure, purge, reconciliation) reads `deletionRequestedAt` itself,
 * because it branches on both answers rather than refusing one. */
export function userIsActive(): SQL {
	return isNull(authUsers.deletionRequestedAt);
}
