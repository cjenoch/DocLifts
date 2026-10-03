import { and, eq, gt, isNull, or } from 'drizzle-orm';
import type { Database } from '../progression';
import {
	authSessions,
	oauthAccessToken,
	oauthClient,
	oauthConsent,
	oauthRefreshToken
} from '../db/auth-schema';
import { MCP_SCOPES, mcpResource, tokenHash } from './config';
export type McpPrincipal = { userId: string; clientId: string; scopes: string[] };
/** Only OAuth access tokens: browser cookies, API keys and refresh tokens are never accepted. */
export async function authenticateMcp(
	db: Database,
	header: string | null
): Promise<McpPrincipal | null> {
	const match = /^Bearer ([A-Za-z0-9._~+/-]{16,512})$/.exec(header || '');
	if (!match) return null;
	const [row] = await db
		.select({ token: oauthAccessToken, session: authSessions, client: oauthClient })
		.from(oauthAccessToken)
		.innerJoin(authSessions, eq(authSessions.id, oauthAccessToken.sessionId))
		.innerJoin(oauthClient, eq(oauthClient.clientId, oauthAccessToken.clientId))
		.where(
			and(
				eq(oauthAccessToken.token, tokenHash(match[1])),
				gt(oauthAccessToken.expiresAt, new Date()),
				isNull(oauthAccessToken.revoked),
				gt(authSessions.expiresAt, new Date()),
				eq(authSessions.userId, oauthAccessToken.userId),
				or(eq(oauthClient.disabled, false), isNull(oauthClient.disabled))
			)
		)
		.limit(1);
	if (
		!row ||
		!row.token.userId ||
		row.token.confirmation ||
		!row.token.resources?.includes(mcpResource())
	)
		return null;
	const [consent] = await db
		.select()
		.from(oauthConsent)
		.where(
			and(eq(oauthConsent.userId, row.token.userId), eq(oauthConsent.clientId, row.token.clientId))
		)
		.limit(1);
	if (!consent || !consent.resources?.includes(mcpResource())) return null;
	const scopes = row.token.scopes.filter(
		(s) => consent.scopes.includes(s) && (MCP_SCOPES as readonly string[]).includes(s)
	);
	if (!scopes.length) return null;
	return { userId: row.token.userId, clientId: row.token.clientId, scopes };
}
export async function connectionsForUser(db: Database, userId: string) {
	return db
		.select({
			id: oauthConsent.id,
			clientId: oauthConsent.clientId,
			name: oauthClient.name,
			scopes: oauthConsent.scopes,
			createdAt: oauthConsent.createdAt
		})
		.from(oauthConsent)
		.innerJoin(oauthClient, eq(oauthClient.clientId, oauthConsent.clientId))
		.where(eq(oauthConsent.userId, userId))
		.limit(100);
}
export async function revokeConnection(db: Database, userId: string, clientId: string) {
	await db.transaction(async (tx) => {
		await tx
			.delete(oauthAccessToken)
			.where(and(eq(oauthAccessToken.userId, userId), eq(oauthAccessToken.clientId, clientId)));
		await tx
			.delete(oauthRefreshToken)
			.where(and(eq(oauthRefreshToken.userId, userId), eq(oauthRefreshToken.clientId, clientId)));
		await tx
			.delete(oauthConsent)
			.where(and(eq(oauthConsent.userId, userId), eq(oauthConsent.clientId, clientId)));
	});
}
