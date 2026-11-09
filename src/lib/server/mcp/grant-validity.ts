import { and, eq, exists, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { authSessions, authUsers, oauthClient, oauthConsent } from '../db/schema';
import { sessionIsLive, userIsActive } from '../session-liveness';

/** The OAuth client has not been disabled (NULL is the provider's "enabled"). */
export function clientIsUsable(): SQL {
	return or(eq(oauthClient.disabled, false), isNull(oauthClient.disabled))!;
}

/** The columns of an access- or refresh-token row that bind it to an authorization. */
export type GrantColumns = {
	sessionId: AnyPgColumn;
	userId: AnyPgColumn;
	clientId: AnyPgColumn;
};

/**
 * Whether the authorization behind a token is still live: its login session
 * exists, belongs to the token's user and is unexpired; that user is not fenced;
 * the client is not disabled; and the user's consent for the client still
 * exists. Access (`authenticateMcp`) and refresh (`requireRefreshSession`) both
 * apply exactly this, so a refresh is refused for every reason an access is.
 *
 * Token-level checks stay with their caller, because they mean different things
 * per token kind: access-token expiry, `revoked` and audience are checked in
 * `access.ts`; refresh-token expiry, `revoked` (the provider's rotation-reuse
 * signal) and resource subsetting are the provider's.
 */
export function grantIsLive(grant: GrantColumns, now: Date = new Date()): SQL {
	return and(
		exists(
			sql`(select 1 from ${authSessions} inner join ${authUsers} on ${eq(authUsers.id, authSessions.userId)} where ${and(
				eq(authSessions.id, grant.sessionId),
				eq(authSessions.userId, grant.userId),
				sessionIsLive(now),
				userIsActive()
			)})`
		),
		exists(
			sql`(select 1 from ${oauthClient} where ${and(eq(oauthClient.clientId, grant.clientId), clientIsUsable())})`
		),
		exists(
			sql`(select 1 from ${oauthConsent} where ${and(
				eq(oauthConsent.userId, grant.userId),
				eq(oauthConsent.clientId, grant.clientId)
			)})`
		)
	)!;
}
