import { APIError } from 'better-auth/api';
import { and, eq, sql } from 'drizzle-orm';
import { oauthAccessToken, oauthRefreshToken } from '../db/schema';
import type { Database } from '../progression';
import { tokenHash } from './config';
import { grantIsLive } from './grant-validity';

/** This issuer uses opaque, unprefixed refresh tokens (auth-core storeTokens).
 * Require the same live authorization as MCP access (`grantIsLive`: live owned
 * browser session, active account, enabled client, consent present) before
 * rotation and before returning its result. Hooks cover HTTP and auth.api,
 * including tokens already orphaned before this policy was installed; no
 * process-local state. Refresh-token expiry, `revoked` (rotation-reuse
 * detection) and resource subsetting stay with the provider.
 */
export async function requireRefreshSession(db: Database, token: string) {
	const [found] = await db
		.select({
			grant: oauthRefreshToken,
			live: sql<boolean>`${grantIsLive(oauthRefreshToken)}`.mapWith(Boolean)
		})
		.from(oauthRefreshToken)
		.where(eq(oauthRefreshToken.token, tokenHash(token)))
		.limit(1);
	if (found?.live) return;
	const grant = found?.grant;
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
