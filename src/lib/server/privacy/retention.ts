import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import type { Database } from '../progression';
import * as s from '../db/schema';
import type { Ledger } from './ledger';
import { erasePhotoObject } from './lifecycle';
import type { PhotoStore } from '../photos/store';

export const RETENTION_DEFAULTS = {
	detailsDays: 30,
	recordsDays: 90,
	expiredAuthDays: 7,
	discardedDays: 30
};
export type RetentionPolicy = typeof RETENTION_DEFAULTS;
export function validateRetention(policy: RetentionPolicy) {
	for (const value of Object.values(policy))
		if (!Number.isInteger(value) || value < 1 || value > 3650)
			throw new Error('Retention days must be whole numbers from 1 to 3650');
	if (policy.recordsDays < policy.detailsDays)
		throw new Error('Usage retention cannot be shorter than detail retention');
	return policy;
}
/** Default dry-run; strict UTC cutoff (<, not <=), one fixed clock per pass.
 * Every category and account pass is bounded. No workout/import/history table
 * is age-purged, nor are confirmed or unconfirmed retained photos. */
export async function sweepRetention(
	db: Database,
	userId: string,
	options: {
		apply?: boolean;
		now?: Date;
		limit?: number;
		policy?: RetentionPolicy;
		store?: PhotoStore;
		ledger?: Ledger;
	} = {}
) {
	const now = options.now ?? new Date();
	if (!Number.isFinite(now.getTime()) || now.getTime() > Date.now() + 60000)
		throw new Error('Invalid or future retention clock');
	const policy = validateRetention(options.policy ?? RETENTION_DEFAULTS);
	const limit = options.limit ?? 25;
	if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid batch limit');
	const before = (days: number) => new Date(now.getTime() - days * 86400000);
	const [active] = await db
		.select({ id: s.authUsers.id })
		.from(s.authUsers)
		.where(and(eq(s.authUsers.id, userId), isNull(s.authUsers.deletionRequestedAt)));
	if (!active)
		return {
			details: 0,
			records: 0,
			sessions: 0,
			accessTokens: 0,
			refreshTokens: 0,
			verifications: 0,
			discarded: 0,
			failed: 0,
			applied: !!options.apply
		};
	const details = await db
		.select({ id: s.llmCalls.id })
		.from(s.llmCalls)
		.where(
			and(
				eq(s.llmCalls.userId, userId),
				lt(s.llmCalls.createdAt, before(policy.detailsDays)),
				sql`(${s.llmCalls.output} IS NOT NULL OR ${s.llmCalls.promptText} IS NOT NULL OR ${s.llmCalls.errorCode} IS NOT NULL)`
			)
		)
		.orderBy(s.llmCalls.createdAt, s.llmCalls.id)
		.limit(limit);
	const records = await db
		.select({ id: s.llmCalls.id })
		.from(s.llmCalls)
		.where(
			and(
				eq(s.llmCalls.userId, userId),
				lt(s.llmCalls.createdAt, before(policy.recordsDays)),
				sql`NOT EXISTS(SELECT 1 FROM equipment_photos WHERE llm_call_id=${s.llmCalls.id})`
			)
		)
		.orderBy(s.llmCalls.createdAt, s.llmCalls.id)
		.limit(limit);
	const counts = {
		details: details.length,
		records: records.length,
		sessions: 0,
		accessTokens: 0,
		refreshTokens: 0,
		verifications: 0,
		discarded: 0,
		failed: 0,
		applied: !!options.apply
	};
	if (options.apply) {
		for (const row of details)
			await db
				.update(s.llmCalls)
				.set({ output: null, promptText: null, errorCode: null })
				.where(and(eq(s.llmCalls.id, row.id), eq(s.llmCalls.userId, userId)));
		for (const row of records)
			await db
				.delete(s.llmCalls)
				.where(
					and(
						eq(s.llmCalls.id, row.id),
						eq(s.llmCalls.userId, userId),
						sql`NOT EXISTS(SELECT 1 FROM equipment_photos WHERE llm_call_id=${s.llmCalls.id})`
					)
				);
	}
	// Never let a parent cascade into another owner's token or an unexpired child.
	// Lock the parent before rechecking references: a concurrent FK insert then
	// waits and fails if we delete, rather than escaping the reference check.
	for (const [name, table] of [
		['accessTokens', s.oauthAccessToken],
		['refreshTokens', s.oauthRefreshToken],
		['sessions', s.authSessions]
	] as const) {
		const noChildren =
			name === 'refreshTokens'
				? sql`NOT EXISTS(SELECT 1 FROM auth.oauth_access_token WHERE refresh_id=${table.id})`
				: name === 'sessions'
					? sql`NOT EXISTS(SELECT 1 FROM auth.oauth_access_token WHERE session_id=${table.id}) AND NOT EXISTS(SELECT 1 FROM auth.oauth_refresh_token WHERE session_id=${table.id})`
					: sql`true`;
		const eligible = and(
			eq(table.userId, userId),
			lt(table.expiresAt, before(policy.expiredAuthDays)),
			noChildren
		);
		const rows = await db
			.select({ id: table.id })
			.from(table)
			.where(eligible)
			.orderBy(table.expiresAt, table.id)
			.limit(limit);
		counts[name] = rows.length;
		if (options.apply)
			for (const row of rows)
				await db.transaction(async (tx) => {
					await tx
						.select({ id: table.id })
						.from(table)
						.where(and(eq(table.id, row.id), eq(table.userId, userId)))
						.for('update');
					await tx.delete(table).where(and(eq(table.id, row.id), eligible));
				});
	}

	const verifications = await db
		.select({ id: s.authVerifications.id })
		.from(s.authVerifications)
		.where(
			and(
				lt(s.authVerifications.expiresAt, before(policy.expiredAuthDays)),
				sql`privacy_verification_owner(${s.authVerifications.value})=${userId}`
			)
		)
		.limit(limit);
	counts.verifications = verifications.length;
	if (options.apply)
		for (const row of verifications)
			await db
				.delete(s.authVerifications)
				.where(
					and(
						eq(s.authVerifications.id, row.id),
						lt(s.authVerifications.expiresAt, before(policy.expiredAuthDays)),
						sql`privacy_verification_owner(${s.authVerifications.value})=${userId}`
					)
				);
	const discarded = await db
		.select()
		.from(s.photoObjects)
		.where(
			and(
				eq(s.photoObjects.userId, userId),
				lt(s.photoObjects.createdAt, before(policy.discardedDays)),
				sql`${s.photoObjects.state} IN ('uploading','delete_pending')`
			)
		)
		.orderBy(s.photoObjects.createdAt, s.photoObjects.storageKey)
		.limit(limit);
	counts.discarded = discarded.length;
	if (options.apply)
		for (const row of discarded) {
			try {
				if (!options.store) throw new Error('Object store required');
				await erasePhotoObject(db, userId, row.storageKey, options.store, false, options.ledger);
			} catch {
				counts.failed++;
			}
		}
	return counts;
}

/** Verification/PKCE handshakes may have no account (or one already deleted).
 * This is a separate --all-only operator sweep; never run on an owner's behalf. */
export async function sweepExpiredHandshakes(
	db: Database,
	options: { apply?: boolean; now?: Date; limit?: number; graceDays?: number } = {}
) {
	const now = options.now ?? new Date(),
		limit = options.limit ?? 25,
		days = options.graceDays ?? 7;
	if (
		!Number.isFinite(now.getTime()) ||
		now.getTime() > Date.now() + 60000 ||
		!Number.isInteger(limit) ||
		limit < 1 ||
		limit > 100 ||
		!Number.isInteger(days) ||
		days < 1 ||
		days > 3650
	)
		throw new Error('Invalid handshake retention options');
	const cutoff = new Date(now.getTime() - days * 86400000);
	const counts = { verifications: 0, assertions: 0 };
	for (const [name, table] of [
		['verifications', s.authVerifications],
		['assertions', s.oauthClientAssertion]
	] as const) {
		const rows = await db
			.select({ id: table.id })
			.from(table)
			.where(lt(table.expiresAt, cutoff))
			.orderBy(table.expiresAt, table.id)
			.limit(limit);
		counts[name] = rows.length;
		if (options.apply)
			for (const row of rows)
				await db.delete(table).where(and(eq(table.id, row.id), lt(table.expiresAt, cutoff)));
	}
	return counts;
}
