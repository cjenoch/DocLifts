import { APIError } from 'better-auth/api';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { authSessions, authUsers, oauthAccessToken, oauthRefreshToken } from '../db/schema';
import type { Database } from '../progression';
import { tokenHash } from './config';

/** This issuer uses opaque, unprefixed refresh tokens (auth-core storeTokens).
 * Require the same live browser-session ownership as MCP before rotation and
 * before returning its result. Hooks cover HTTP and auth.api, including tokens
 * already orphaned before this policy was installed; no process-local state.
 */
export async function requireRefreshSession(db: Database, token: string) {
	const [grant] = await db
		.select()
		.from(oauthRefreshToken)
		.where(eq(oauthRefreshToken.token, tokenHash(token)))
		.limit(1);
	if (grant?.sessionId) {
		const [session] = await db
			.select({ id: authSessions.id })
			.from(authSessions)
			.innerJoin(authUsers, eq(authUsers.id, authSessions.userId))
			.where(
				and(
					eq(authSessions.id, grant.sessionId),
					eq(authSessions.userId, grant.userId),
					gt(authSessions.expiresAt, new Date()),
					isNull(authUsers.deletionRequestedAt)
				)
			)
			.limit(1);
		if (session) return;
	}
	if (grant) {
		// Clean only this authorization's family, never another login's grant.
		// Legacy rows without a code binding can only be cleaned individually.
		await db.transaction(async (tx) => {
			await tx
				.delete(oauthAccessToken)
				.where(
					and(
						eq(oauthAccessToken.clientId, grant.clientId),
						eq(oauthAccessToken.userId, grant.userId),
						grant.authorizationCodeId
							? eq(oauthAccessToken.authorizationCodeId, grant.authorizationCodeId)
							: eq(oauthAccessToken.refreshId, grant.id)
					)
				);
			await tx
				.delete(oauthRefreshToken)
				.where(
					and(
						eq(oauthRefreshToken.clientId, grant.clientId),
						eq(oauthRefreshToken.userId, grant.userId),
						grant.authorizationCodeId
							? eq(oauthRefreshToken.authorizationCodeId, grant.authorizationCodeId)
							: eq(oauthRefreshToken.id, grant.id)
					)
				);
		});
	}
	throw new APIError('BAD_REQUEST', {
		error: 'invalid_grant',
		error_description: 'Refresh authorization is no longer active'
	});
}
