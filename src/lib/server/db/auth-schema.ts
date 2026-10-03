/**
 * Better Auth tables, in the `auth` Postgres schema.
 *
 * WHY A SEPARATE PG SCHEMA (decision, 2026-09-29):
 *   Better Auth's default table names are `user`, `session`, `account`,
 *   `verification`. Two problems with taking them as-is:
 *     1. `session` sits one letter from `sessions` (the workout table, the
 *        most-queried table in the app). A generated Drizzle export named
 *        `session` next to `sessions` is a wrong-join waiting to happen.
 *     2. `user` is a Postgres reserved word, so every hand-written SQL
 *        reference needs quoting.
 *   `pgSchema('auth')` isolates all four into `auth.user`, `auth.session`, …
 *   — no collision with `public.sessions`, and `"auth"."user"` is
 *   schema-qualified. Model names are ALSO renamed (auth_user etc. via the
 *   `modelName` options in auth.ts) so the Drizzle exports are unambiguous
 *   in TypeScript, which the pgSchema alone does not solve.
 *
 * FIELD NAMING: column names come from each field's `fieldName`, written
 * out by hand below (`created_at`, `email_verified`, ...). Do NOT add
 * `camelCase` to the adapter config in auth.ts to "fix" the casing — it
 * does the opposite of what it looks like. In
 * @better-auth/drizzle-adapter/dist/generate-drizzle-schema-*.mjs:
 *   function convertToSnakeCase(str, camelCase) {
 *     if (camelCase) return str;      // ← true KEEPS camelCase
 *     return str.replace(...).toLowerCase();
 *   }
 * so the default (unset) is what produces snake_case. The option is read
 * by the schema GENERATOR and relations-v2 only — it appears nowhere in the
 * adapter's own index.mjs, so it does not affect runtime queries either
 * way. These `fieldName` values are the source of truth for column names.
 *
 * GENERATED, THEN HAND-MAINTAINED. Column shapes were derived from
 * Better Auth 1.7.6's own `getAuthTables()` (the same source @better-auth/cli
 * reads), not from memory. @better-auth/cli has no 1.7.6 tag, so the usual
 * `npx @better-auth/cli generate` path is unavailable for this version.
 *
 * After changing anything here: `pnpm db:generate`.
 */
import {
	index,
	pgSchema,
	text,
	timestamp,
	boolean,
	integer,
	jsonb,
	foreignKey,
	uniqueIndex
} from 'drizzle-orm/pg-core';

export const authSchema = pgSchema('auth');

/**
 * IDs are uuid to match every other table in this schema — DocLifts uses
 * `uuid().primaryKey()` throughout and Better Auth's `user.id` is the FK
 * target for all eight `user_id` columns in the ownership migration.
 */
export const authUsers = authSchema.table(
	'user',
	{
		id: text('id').primaryKey(),
		name: text('name').notNull(),
		email: text('email').notNull().unique(),
		emailVerified: boolean('email_verified').notNull().default(false),
		image: text('image'),
		createdAt: timestamp('created_at').notNull().defaultNow(),
		updatedAt: timestamp('updated_at').notNull().defaultNow()
	},
	(t) => [
		// Better Auth's own lookup paths: sign-in by email, session by token.
		index('auth_user_email_idx').on(t.email),
		index('auth_user_name_idx').on(t.name)
	]
);

export const authSessions = authSchema.table(
	'session',
	{
		id: text('id').primaryKey(),
		expiresAt: timestamp('expires_at').notNull(),
		token: text('token').notNull().unique(),
		createdAt: timestamp('created_at').notNull().defaultNow(),
		updatedAt: timestamp('updated_at').notNull().defaultNow(),
		ipAddress: text('ip_address'),
		userAgent: text('user_agent'),
		userId: text('user_id')
			.notNull()
			.references(() => authUsers.id, { onDelete: 'cascade' })
	},
	(t) => [
		// Every authenticated request resolves a session by token, then loads
		// the user. Both are hot; neither is covered by the unique constraints.
		index('auth_session_token_idx').on(t.token),
		index('auth_session_user_id_idx').on(t.userId)
	]
);

export const authAccounts = authSchema.table(
	'account',
	{
		id: text('id').primaryKey(),
		accountId: text('account_id').notNull(),
		providerId: text('provider_id').notNull(),
		userId: text('user_id')
			.notNull()
			.references(() => authUsers.id, { onDelete: 'cascade' }),
		accessToken: text('access_token'),
		refreshToken: text('refresh_token'),
		idToken: text('id_token'),
		accessTokenExpiresAt: timestamp('access_token_expires_at'),
		refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
		scope: text('scope'),
		/** scrypt hash; `returned: false` upstream, so never serialized. */
		password: text('password'),
		createdAt: timestamp('created_at').notNull().defaultNow(),
		updatedAt: timestamp('updated_at').notNull().defaultNow()
	},
	(t) => [
		// One credential row per (provider, account). Email/password uses
		// providerId 'credential', so this is also the sign-in lookup.
		index('auth_account_user_id_idx').on(t.userId),
		index('auth_account_provider_pair_idx').on(t.providerId, t.accountId)
	]
);

export const authVerifications = authSchema.table(
	'verification',
	{
		id: text('id').primaryKey(),
		identifier: text('identifier').notNull(),
		value: text('value').notNull(),
		expiresAt: timestamp('expires_at').notNull(),
		createdAt: timestamp('created_at').notNull().defaultNow(),
		updatedAt: timestamp('updated_at').notNull().defaultNow()
	},
	(t) => [index('auth_verification_identifier_idx').on(t.identifier)]
);

/**
 * The map Better Auth's adapter resolves models through. Keys are Better
 * Auth's model names; values are our renamed table objects. This is the
 * `schema` option in drizzleAdapter — see auth.ts.
 */
// Derived from @better-auth/oauth-provider 1.7.7 schema; regenerate migrations after edits.
export const oauthClient = authSchema.table(
	'oauth_client',
	{
		id: text('id').primaryKey(),
		clientId: text('client_id').notNull().unique('oauth_client_client_id_uq'),
		clientSecret: text('client_secret'),
		clientDiscoveryId: text('client_discovery_id'),
		disabled: boolean('disabled').default(false),
		skipConsent: boolean('skip_consent'),
		enableEndSession: boolean('enable_end_session'),
		subjectType: text('subject_type'),
		scopes: text('scopes').array(),
		clientCredentialsScopes: text('client_credentials_scopes').array().default([]),
		userId: text('user_id'),
		createdAt: timestamp('created_at'),
		updatedAt: timestamp('updated_at'),
		name: text('name'),
		uri: text('uri'),
		icon: text('icon'),
		contacts: text('contacts').array(),
		tos: text('tos'),
		policy: text('policy'),
		softwareId: text('software_id'),
		softwareVersion: text('software_version'),
		softwareStatement: text('software_statement'),
		redirectUris: text('redirect_uris').array().notNull(),
		postLogoutRedirectUris: text('post_logout_redirect_uris').array(),
		backchannelLogoutUri: text('backchannel_logout_uri'),
		backchannelLogoutSessionRequired: boolean('backchannel_logout_session_required'),
		tokenEndpointAuthMethod: text('token_endpoint_auth_method'),
		applicationType: text('application_type'),
		jwks: text('jwks'),
		jwksUri: text('jwks_uri'),
		grantTypes: text('grant_types').array(),
		responseTypes: text('response_types').array(),
		requirePKCE: boolean('require_p_k_c_e'),
		dpopBoundAccessTokens: boolean('dpop_bound_access_tokens').default(false),
		referenceId: text('reference_id'),
		metadata: jsonb('metadata')
	},
	(t) => [
		foreignKey({
			name: 'oauth_client_user_id_fk',
			columns: [t.userId],
			foreignColumns: [authUsers.id]
		}).onDelete('cascade'),
		index('oauth_client_user_id_idx').on(t.userId)
	]
);
export const oauthResource = authSchema.table(
	'oauth_resource',
	{
		id: text('id').primaryKey(),
		identifier: text('identifier').notNull().unique('oauth_resource_identifier_uq'),
		name: text('name').notNull(),
		accessTokenTtl: integer('access_token_ttl'),
		refreshTokenTtl: integer('refresh_token_ttl'),
		signingAlgorithm: text('signing_algorithm'),
		signingKeyId: text('signing_key_id'),
		allowedScopes: text('allowed_scopes').array(),
		customClaims: jsonb('custom_claims'),
		dpopBoundAccessTokensRequired: boolean('dpop_bound_access_tokens_required').default(false),
		disabled: boolean('disabled').default(false),
		createdAt: timestamp('created_at'),
		updatedAt: timestamp('updated_at'),
		policyVersion: integer('policy_version').default(1),
		metadata: jsonb('metadata')
	},
	(t) => []
);
export const oauthClientResource = authSchema.table(
	'oauth_client_resource',
	{
		id: text('id').primaryKey(),
		clientId: text('client_id').notNull(),
		resourceId: text('resource_id').notNull(),
		metadata: jsonb('metadata'),
		createdAt: timestamp('created_at')
	},
	(t) => [
		foreignKey({
			name: 'oauth_client_resource_client_id_fk',
			columns: [t.clientId],
			foreignColumns: [oauthClient.clientId]
		}).onDelete('cascade'),
		index('oauth_client_resource_client_id_idx').on(t.clientId),
		foreignKey({
			name: 'oauth_client_resource_resource_id_fk',
			columns: [t.resourceId],
			foreignColumns: [oauthResource.identifier]
		}).onDelete('cascade'),
		index('oauth_client_resource_resource_id_idx').on(t.resourceId),
		uniqueIndex('oauth_client_resource_compound_0').on(t.clientId, t.resourceId)
	]
);
export const oauthRefreshToken = authSchema.table(
	'oauth_refresh_token',
	{
		id: text('id').primaryKey(),
		token: text('token').notNull().unique('oauth_refresh_token_token_uq'),
		clientId: text('client_id').notNull(),
		sessionId: text('session_id'),
		userId: text('user_id').notNull(),
		referenceId: text('reference_id'),
		authorizationCodeId: text('authorization_code_id'),
		resources: text('resources').array(),
		requestedUserInfoClaims: text('requested_user_info_claims').array(),
		expiresAt: timestamp('expires_at').notNull(),
		createdAt: timestamp('created_at').notNull(),
		revoked: timestamp('revoked'),
		rotatedAt: timestamp('rotated_at'),
		rotationReplayResponse: text('rotation_replay_response'),
		rotationReplayExpiresAt: timestamp('rotation_replay_expires_at'),
		authTime: timestamp('auth_time'),
		confirmation: jsonb('confirmation'),
		scopes: text('scopes').array().notNull()
	},
	(t) => [
		foreignKey({
			name: 'oauth_refresh_token_client_id_fk',
			columns: [t.clientId],
			foreignColumns: [oauthClient.clientId]
		}).onDelete('cascade'),
		index('oauth_refresh_token_client_id_idx').on(t.clientId),
		foreignKey({
			name: 'oauth_refresh_token_session_id_fk',
			columns: [t.sessionId],
			foreignColumns: [authSessions.id]
		}).onDelete('set null'),
		index('oauth_refresh_token_session_id_idx').on(t.sessionId),
		foreignKey({
			name: 'oauth_refresh_token_user_id_fk',
			columns: [t.userId],
			foreignColumns: [authUsers.id]
		}).onDelete('cascade'),
		index('oauth_refresh_token_user_id_idx').on(t.userId),
		index('oauth_refresh_token_authorization_code_id_idx').on(t.authorizationCodeId)
	]
);
export const oauthAccessToken = authSchema.table(
	'oauth_access_token',
	{
		id: text('id').primaryKey(),
		token: text('token').notNull().unique('oauth_access_token_token_uq'),
		clientId: text('client_id').notNull(),
		sessionId: text('session_id'),
		userId: text('user_id'),
		referenceId: text('reference_id'),
		authorizationCodeId: text('authorization_code_id'),
		resources: text('resources').array(),
		requestedUserInfoClaims: text('requested_user_info_claims').array(),
		refreshId: text('refresh_id'),
		expiresAt: timestamp('expires_at').notNull(),
		createdAt: timestamp('created_at').notNull(),
		revoked: timestamp('revoked'),
		confirmation: jsonb('confirmation'),
		scopes: text('scopes').array().notNull()
	},
	(t) => [
		foreignKey({
			name: 'oauth_access_token_client_id_fk',
			columns: [t.clientId],
			foreignColumns: [oauthClient.clientId]
		}).onDelete('cascade'),
		index('oauth_access_token_client_id_idx').on(t.clientId),
		foreignKey({
			name: 'oauth_access_token_session_id_fk',
			columns: [t.sessionId],
			foreignColumns: [authSessions.id]
		}).onDelete('set null'),
		index('oauth_access_token_session_id_idx').on(t.sessionId),
		foreignKey({
			name: 'oauth_access_token_user_id_fk',
			columns: [t.userId],
			foreignColumns: [authUsers.id]
		}).onDelete('cascade'),
		index('oauth_access_token_user_id_idx').on(t.userId),
		index('oauth_access_token_authorization_code_id_idx').on(t.authorizationCodeId),
		foreignKey({
			name: 'oauth_access_token_refresh_id_fk',
			columns: [t.refreshId],
			foreignColumns: [oauthRefreshToken.id]
		}).onDelete('cascade'),
		index('oauth_access_token_refresh_id_idx').on(t.refreshId)
	]
);
export const oauthConsent = authSchema.table(
	'oauth_consent',
	{
		id: text('id').primaryKey(),
		clientId: text('client_id').notNull(),
		userId: text('user_id'),
		referenceId: text('reference_id'),
		resources: text('resources').array(),
		requestedUserInfoClaims: text('requested_user_info_claims').array(),
		scopes: text('scopes').array().notNull(),
		createdAt: timestamp('created_at').notNull(),
		updatedAt: timestamp('updated_at').notNull()
	},
	(t) => [
		foreignKey({
			name: 'oauth_consent_client_id_fk',
			columns: [t.clientId],
			foreignColumns: [oauthClient.clientId]
		}).onDelete('cascade'),
		index('oauth_consent_client_id_idx').on(t.clientId),
		foreignKey({
			name: 'oauth_consent_user_id_fk',
			columns: [t.userId],
			foreignColumns: [authUsers.id]
		}).onDelete('cascade'),
		index('oauth_consent_user_id_idx').on(t.userId)
	]
);
export const oauthClientAssertion = authSchema.table(
	'oauth_client_assertion',
	{ id: text('id').primaryKey(), expiresAt: timestamp('expires_at').notNull() },
	(t) => []
);

export const authTables = {
	oauthClient,
	oauthResource,
	oauthClientResource,
	oauthRefreshToken,
	oauthAccessToken,
	oauthConsent,
	oauthClientAssertion,
	user: authUsers,
	session: authSessions,
	account: authAccounts,
	verification: authVerifications
};
