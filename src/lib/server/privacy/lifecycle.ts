import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Database } from '../progression';
import * as s from '../db/schema';
import type { PhotoStore } from '../photos/store';
import { withStorageLock } from './storage-lock';
import { subjectHash, type Ledger, type LedgerEntry } from './ledger';

const entry = (kind: 'account' | 'photo', id: string, now: Date): LedgerEntry => ({
	version: 1,
	kind,
	subjectHash: subjectHash(kind, id),
	requestedAt: now.toISOString()
});

async function receipt(db: Database, userId: string, record: LedgerEntry) {
	const [row] = await db
		.insert(s.privacyDeletions)
		.values({
			kind: record.kind,
			subjectHash: record.subjectHash,
			ownerId: userId,
			requestedAt: new Date(record.requestedAt)
		})
		.onConflictDoUpdate({
			target: [s.privacyDeletions.kind, s.privacyDeletions.subjectHash],
			set: { ownerId: userId, completedAt: null }
		})
		.returning();
	return row;
}

async function assertNoForeignAuthCascade(db: Database, userId: string) {
	const foreign = await db.execute(sql`SELECT 1 WHERE
 EXISTS(SELECT 1 FROM auth.oauth_access_token t JOIN auth.oauth_refresh_token r ON r.id=t.refresh_id WHERE r.user_id=${userId} AND t.user_id IS DISTINCT FROM ${userId}) OR
 EXISTS(SELECT 1 FROM auth.oauth_access_token t JOIN auth.session a ON a.id=t.session_id WHERE a.user_id=${userId} AND t.user_id IS DISTINCT FROM ${userId}) OR
 EXISTS(SELECT 1 FROM auth.oauth_refresh_token t JOIN auth.session a ON a.id=t.session_id WHERE a.user_id=${userId} AND t.user_id IS DISTINCT FROM ${userId})`);
	if (foreign.length)
		throw new Error('Foreign authentication reference requires operator resolution');
}

async function revoke(db: Database, userId: string) {
	await assertNoForeignAuthCascade(db, userId);
	// Child-first: session ON DELETE SET NULL must not update a revoked user's tokens.
	await db.delete(s.oauthAccessToken).where(eq(s.oauthAccessToken.userId, userId));
	await db.delete(s.oauthRefreshToken).where(eq(s.oauthRefreshToken.userId, userId));
	await db.delete(s.oauthConsent).where(eq(s.oauthConsent.userId, userId));
	await db.delete(s.authSessions).where(eq(s.authSessions.userId, userId));
	await db
		.delete(s.authVerifications)
		.where(sql`privacy_verification_owner(${s.authVerifications.value}) = ${userId}`);
}

/** Caller has just verified the current password through the rate-limited auth
 * handler. Recheck the SAME session inside the fencing transaction, so a concurrent
 * logout/password change cannot authorize deletion using a stale request. */
export async function requestAccountDeletion(
	db: Database,
	userId: string,
	sessionId: string,
	ledger: Ledger,
	now = new Date()
) {
	return db.transaction(async (tx) => {
		const [user] = await tx
			.select()
			.from(s.authUsers)
			.where(eq(s.authUsers.id, userId))
			.for('update');
		if (!user || user.deletionRequestedAt) return null;
		const [session] = await tx
			.select()
			.from(s.authSessions)
			.where(
				and(
					eq(s.authSessions.id, sessionId),
					eq(s.authSessions.userId, userId),
					gt(s.authSessions.expiresAt, now)
				)
			)
			.for('update');
		if (!session) return null;
		const record = entry('account', userId, now);
		// Journal first. A DB failure afterwards is recoverable by reconciliation;
		// reporting an ambiguous request as "nothing changed" would be dishonest.
		await ledger.append(record);
		const job = await receipt(tx, userId, record);
		await inventoryPhotos(tx, userId);
		await revoke(tx, userId);
		await tx
			.update(s.authUsers)
			.set({ deletionRequestedAt: now })
			.where(eq(s.authUsers.id, userId));
		return job;
	});
}

async function inventoryPhotos(db: Database, userId: string) {
	await db.execute(sql`INSERT INTO photo_objects(storage_key,user_id,photo_id,state,created_at)
  SELECT storage_key,user_id,id,'stored',created_at FROM equipment_photos WHERE user_id=${userId}
  ON CONFLICT(storage_key) DO NOTHING`);
}

/** Explicit removal also accepts confirmed photos. Only the image and its review
 * metadata are removed; machines, blocks, prescriptions and executed sets survive. */
export async function requestPhotoDeletion(
	db: Database,
	userId: string,
	photoId: string,
	ledger: Ledger,
	now = new Date()
) {
	if (!/^[a-f0-9-]{36}$/i.test(photoId)) return null;
	return db.transaction(async (tx) => {
		await tx.execute(sql`SELECT privacy_assert_active(${userId})`);
		const [photo] = await tx
			.select()
			.from(s.equipmentPhotos)
			.where(and(eq(s.equipmentPhotos.id, photoId), eq(s.equipmentPhotos.userId, userId)))
			.for('update');
		if (!photo) return null;
		const [pending] = await tx
			.select()
			.from(s.privacyDeletions)
			.where(
				and(
					eq(s.privacyDeletions.kind, 'photo'),
					eq(s.privacyDeletions.subjectHash, subjectHash('photo', photoId))
				)
			);
		if (pending) return pending;
		const record = entry('photo', photoId, now);
		await ledger.append(record);
		await inventoryPhotos(tx, userId);
		// Hide immediately. The key remains in the outbox until erasure succeeds.
		await tx
			.update(s.equipmentPhotos)
			.set({ status: 'discarded', candidate: null })
			.where(eq(s.equipmentPhotos.id, photoId));
		await tx
			.update(s.photoObjects)
			.set({ state: 'delete_pending' })
			.where(eq(s.photoObjects.storageKey, photo.storageKey));
		return receipt(tx, userId, record);
	});
}

async function completePhotoReceipt(db: Database, photoId: string) {
	await db
		.update(s.privacyDeletions)
		.set({ completedAt: new Date(), ownerId: null, lastError: null })
		.where(
			and(
				eq(s.privacyDeletions.kind, 'photo'),
				eq(s.privacyDeletions.subjectHash, subjectHash('photo', photoId))
			)
		);
}

/** No remote call is made inside a DB transaction. A crash after erasure merely
 * repeats an idempotent erasure; a crash before erasure leaves the durable key. */
export async function erasePhotoObject(
	db: Database,
	userId: string,
	key: string,
	store: PhotoStore,
	accountDeletion = false
) {
	return withStorageLock(db, key, async () => {
		const [object] = await db
			.select()
			.from(s.photoObjects)
			.where(and(eq(s.photoObjects.storageKey, key), eq(s.photoObjects.userId, userId)));
		if (!object) return true;
		if (key !== `users/${userId}/equipment-photos/${object.photoId}.jpg`)
			throw new Error('Object inventory owner mismatch');
		if (object.writeDeadline && object.writeDeadline.getTime() > Date.now())
			throw new Error('Upload settlement pending');
		if (!accountDeletion && object.state === 'stored') return false;
		if (!store.erase) throw new Error('Version-aware object erasure is unavailable');
		await store.erase(key);
		await db.transaction(async (tx) => {
			const [photo] = await tx
				.delete(s.equipmentPhotos)
				.where(and(eq(s.equipmentPhotos.id, object.photoId), eq(s.equipmentPhotos.userId, userId)))
				.returning();
			if (photo?.llmCallId)
				await tx
					.delete(s.llmCalls)
					.where(
						and(
							eq(s.llmCalls.userId, userId),
							eq(s.llmCalls.id, photo.llmCallId),
							sql`NOT EXISTS (SELECT 1 FROM equipment_photos WHERE llm_call_id=${photo.llmCallId})`
						)
					);
			await tx
				.delete(s.photoObjects)
				.where(and(eq(s.photoObjects.storageKey, key), eq(s.photoObjects.userId, userId)));
			await completePhotoReceipt(tx, object.photoId);
		});
		return true;
	});
}

/** Explicit, owner-scoped order. Global catalog rows never enter any predicate.
 * A foreign reference fails the transaction instead of cascading into a tenant. */
async function purgeAccount(db: Database, userId: string, jobId: string) {
	await db.transaction(async (tx) => {
		const [user] = await tx
			.select()
			.from(s.authUsers)
			.where(eq(s.authUsers.id, userId))
			.for('update');
		if (user && !user.deletionRequestedAt) throw new Error('Account is not fenced');
		const remaining = await tx
			.select()
			.from(s.photoObjects)
			.where(eq(s.photoObjects.userId, userId))
			.limit(1);
		if (remaining.length) throw new Error('Private objects remain');
		// A registered OAuth client may have other users' grants. Refuse and leave a
		// visible pending job for operator resolution rather than cascading those grants.
		const shared =
			await tx.execute(sql`SELECT 1 FROM auth.oauth_client c JOIN auth.oauth_consent g ON g.client_id=c.client_id
   WHERE c.user_id=${userId} AND g.user_id IS DISTINCT FROM ${userId} LIMIT 1`);
		const foreignTokens = await tx.execute(sql`SELECT 1 WHERE
   EXISTS(SELECT 1 FROM auth.oauth_client c JOIN auth.oauth_access_token t ON t.client_id=c.client_id WHERE c.user_id=${userId} AND t.user_id IS DISTINCT FROM ${userId}) OR
   EXISTS(SELECT 1 FROM auth.oauth_client c JOIN auth.oauth_refresh_token t ON t.client_id=c.client_id WHERE c.user_id=${userId} AND t.user_id IS DISTINCT FROM ${userId})`);
		if (shared.length || foreignTokens.length)
			throw new Error('Shared client requires operator resolution');
		const foreign = await tx.execute(sql`SELECT 1 WHERE
   EXISTS(SELECT 1 FROM sets c JOIN sessions p ON p.id=c.session_id WHERE p.user_id=${userId} AND c.user_id<>${userId}) OR
   EXISTS(SELECT 1 FROM pain_events c JOIN sessions p ON p.id=c.session_id WHERE p.user_id=${userId} AND c.user_id<>${userId}) OR
   EXISTS(SELECT 1 FROM pain_events c JOIN sets p ON p.id=c.set_id WHERE p.user_id=${userId} AND c.user_id<>${userId}) OR
   EXISTS(SELECT 1 FROM programs c JOIN programs p ON p.id=c.source_program_id WHERE p.user_id=${userId} AND c.user_id<>${userId}) OR
   EXISTS(SELECT 1 FROM sets c JOIN prescribed_sets ps ON ps.id=c.prescribed_set_id JOIN day_exercises de ON de.id=ps.day_exercise_id JOIN days d ON d.id=de.day_id JOIN programs p ON p.id=d.program_id WHERE p.user_id=${userId} AND c.user_id<>${userId}) OR
   EXISTS(SELECT 1 FROM equipment_photos c JOIN session_exercises se ON se.id=c.session_exercise_id JOIN sessions p ON p.id=se.session_id WHERE p.user_id=${userId} AND c.user_id<>${userId})`);
		if (foreign.length) throw new Error('Foreign history reference requires operator resolution');
		await revoke(tx, userId);
		for (const table of [
			s.painEvents,
			s.sets,
			s.sessions,
			s.programDraftRequests,
			s.programs,
			s.machineMerges,
			s.workoutLogImports,
			s.llmCalls
		]) {
			await tx.delete(table).where(eq(table.userId, userId));
		}
		await tx.execute(
			sql`DELETE FROM exercise_equipment_map WHERE exercise_id IN (SELECT id FROM exercises WHERE user_id=${userId})`
		);
		await tx.execute(
			sql`DELETE FROM gym_equipment WHERE gym_id IN (SELECT id FROM gyms WHERE user_id=${userId})`
		);
		await tx.delete(s.gyms).where(eq(s.gyms.userId, userId));
		await tx.delete(s.equipmentModels).where(eq(s.equipmentModels.ownerUserId, userId));
		await tx.delete(s.exercises).where(eq(s.exercises.userId, userId));
		await tx.delete(s.authUsers).where(eq(s.authUsers.id, userId));
		await tx
			.update(s.privacyDeletions)
			.set({ completedAt: new Date(), ownerId: null, lastError: null })
			.where(eq(s.privacyDeletions.id, jobId));
	});
}

/** One bounded batch; a pending result is never called completion. No scheduler
 * is installed by this change. Apply must be invoked explicitly by the operator. */
export async function runDeletion(
	db: Database,
	userId: string,
	jobId: string,
	store: PhotoStore,
	ledger: Ledger,
	limit = 25
) {
	if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid batch limit');
	const [job] = await db
		.select()
		.from(s.privacyDeletions)
		.where(and(eq(s.privacyDeletions.id, jobId), eq(s.privacyDeletions.ownerId, userId)));
	if (!job) return { state: 'not_found' as const, removed: 0 };
	if (job.completedAt) return { state: 'completed' as const, removed: 0 };
	let stage = 'ledger';
	let removed = 0;
	try {
		await ledger.append({
			version: 1,
			kind: job.kind,
			subjectHash: job.subjectHash,
			requestedAt: job.requestedAt.toISOString()
		});
		await db
			.update(s.privacyDeletions)
			.set({ attempts: sql`${s.privacyDeletions.attempts}+1`, lastError: null })
			.where(eq(s.privacyDeletions.id, jobId));
		stage = 'storage';
		if (job.kind === 'account') {
			if (!store.listOwned) throw new Error('Owner-prefix object inventory unavailable');
			// Includes pre-migration orphan objects and noncurrent object versions.
			for (const key of await store.listOwned(userId, limit)) {
				const prefix = `users/${userId}/equipment-photos/`;
				const photoId = key.slice(prefix.length, -4);
				if (!key.startsWith(prefix) || !key.endsWith('.jpg') || !/^[a-f0-9-]{36}$/i.test(photoId))
					throw new Error('Unexpected private object key');
				await db
					.insert(s.photoObjects)
					.values({ storageKey: key, userId, photoId, state: 'delete_pending' })
					.onConflictDoNothing();
			}
		}
		const selected = await db
			.select()
			.from(s.photoObjects)
			.where(
				and(
					eq(s.photoObjects.userId, userId),
					job.kind === 'photo'
						? sql`encode(sha256(convert_to('doclifts-deletion-v1:photo:' || ${s.photoObjects.photoId}::text,'UTF8')),'hex')=${job.subjectHash}`
						: undefined
				)
			)
			.orderBy(s.photoObjects.createdAt, s.photoObjects.storageKey)
			.limit(limit);
		const owned = selected.filter(
			(o) => job.kind === 'account' || subjectHash('photo', o.photoId) === job.subjectHash
		);
		for (const object of owned) {
			if (await erasePhotoObject(db, userId, object.storageKey, store, job.kind === 'account'))
				removed++;
		}
		stage = 'database';
		if (job.kind === 'account') {
			const remaining = await db
				.select()
				.from(s.photoObjects)
				.where(eq(s.photoObjects.userId, userId))
				.limit(1);
			if (remaining.length || (await store.listOwned!(userId, 1)).length)
				return { state: 'pending' as const, removed };
			await purgeAccount(db, userId, jobId);
		}
		const [state] = await db
			.select()
			.from(s.privacyDeletions)
			.where(eq(s.privacyDeletions.id, jobId));
		return { state: state.completedAt ? ('completed' as const) : ('pending' as const), removed };
	} catch {
		// Never persist S3 messages, credential-bearing URLs, payloads or raw DB errors.
		await db
			.update(s.privacyDeletions)
			.set({ lastError: stage })
			.where(eq(s.privacyDeletions.id, jobId));
		return { state: 'failed' as const, removed };
	}
}

/** Before a restored installation is served, match only high-entropy identifier
 * hashes from the independently preserved newest ledger. No emails are needed. */
export async function reconcileDeletions(db: Database, records: LedgerEntry[], apply = false) {
	const accounts = new Map(
		records.filter((r) => r.kind === 'account').map((r) => [r.subjectHash, r])
	);
	const photos = new Map(records.filter((r) => r.kind === 'photo').map((r) => [r.subjectHash, r]));
	let accountCount = 0,
		photoCount = 0;
	const users = await db.select({ id: s.authUsers.id }).from(s.authUsers);
	for (const user of users) {
		const record = accounts.get(subjectHash('account', user.id));
		if (!record) continue;
		accountCount++;
		if (apply)
			await db.transaction(async (tx) => {
				await tx.select().from(s.authUsers).where(eq(s.authUsers.id, user.id)).for('update');
				await inventoryPhotos(tx, user.id);
				await revoke(tx, user.id);
				await tx
					.update(s.authUsers)
					.set({ deletionRequestedAt: new Date(record.requestedAt) })
					.where(eq(s.authUsers.id, user.id));
				await receipt(tx, user.id, record);
			});
	}
	const rows = await db.select().from(s.equipmentPhotos);
	for (const photo of rows) {
		const record = photos.get(subjectHash('photo', photo.id));
		if (!record) continue;
		photoCount++;
		if (apply)
			await db.transaction(async (tx) => {
				await inventoryPhotos(tx, photo.userId);
				// An account fence already hides its photos; no owned-row update is needed.
				if (!accounts.has(subjectHash('account', photo.userId))) {
					const [pending] = await tx
						.select()
						.from(s.photoObjects)
						.where(eq(s.photoObjects.storageKey, photo.storageKey));
					if (pending.state !== 'delete_pending')
						await tx
							.update(s.equipmentPhotos)
							.set({ status: 'discarded', candidate: null })
							.where(eq(s.equipmentPhotos.id, photo.id));
				}
				await tx
					.update(s.photoObjects)
					.set({ state: 'delete_pending' })
					.where(eq(s.photoObjects.storageKey, photo.storageKey));
				await receipt(tx, photo.userId, record);
			});
	}
	return { accounts: accountCount, photos: photoCount, applied: apply };
}
