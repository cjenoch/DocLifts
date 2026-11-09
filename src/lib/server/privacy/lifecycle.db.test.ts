import { authenticateMcp } from '../mcp/access';
import { tokenHash, mcpResource } from '../mcp/config';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { setupTestDb, resetTestDb, withTwoUsers, type TestDb } from '../test-db';
import * as s from '../db/schema';
import { MemoryPhotoStore, photoKey } from '../photos/store';
import {
	requestAccountDeletion,
	requestPhotoDeletion,
	runDeletion,
	erasePhotoObject,
	reconcileDeletions,
	deletionJobState,
	deletionJobSummary,
	DELETION_LEASE_MS
} from './lifecycle';
import { configureStorageLocks, closeStorageLocks } from './storage-lock';
import { subjectHash, type LedgerEntry } from './ledger';
import { sweepRetention } from './retention';
import { uploadPhoto } from '../photos';
import { smallPng } from '../photos/test-fixtures';

describe('privacy lifecycle with isolated DB and memory objects', () => {
	let h: Awaited<ReturnType<typeof setupTestDb>>;
	let alice: string, bob: string;
	let journal: LedgerEntry[];
	const ledger = {
		append: async (entry: LedgerEntry) => {
			journal.push(entry);
		}
	};
	beforeAll(async () => {
		h = await setupTestDb();
	});
	afterAll(async () => {
		await h?.end();
	});
	beforeEach(async () => {
		await resetTestDb(h.client);
		({ alice, bob } = await withTwoUsers(h.db));
		journal = [];
	});
	async function fixture(userId: string, store: MemoryPhotoStore) {
		const [gym] = await h.db.insert(s.gyms).values({ userId, name: 'Fixture gym' }).returning();
		const [model] = await h.db
			.insert(s.equipmentModels)
			.values({
				ownerUserId: userId,
				manufacturer: 'Fixture',
				name: 'Machine',
				loadingType: 'machine-stack'
			})
			.returning();
		const [machine] = await h.db
			.insert(s.gymEquipment)
			.values({
				gymId: gym.id,
				localLabel: 'Fixture',
				equipmentType: 'machine-stack',
				equipmentModelId: model.id
			})
			.returning();
		const [exercise] = await h.db
			.insert(s.exercises)
			.values({ userId, name: 'Fixture lift', equipmentType: 'machine-stack' })
			.returning();
		const [program] = await h.db
			.insert(s.programs)
			.values({ userId, name: 'Fixture program' })
			.returning();
		const [day] = await h.db
			.insert(s.days)
			.values({ programId: program.id, name: 'Day', position: 1 })
			.returning();
		const [session] = await h.db
			.insert(s.sessions)
			.values({ userId, programId: program.id, dayId: day.id, gymId: gym.id })
			.returning();
		const [set] = await h.db
			.insert(s.sets)
			.values({
				userId,
				sessionId: session.id,
				exerciseId: exercise.id,
				gymEquipmentId: machine.id,
				loadConvention: 'displayed',
				position: 1,
				setRole: 'working',
				executedLoad: 75,
				executedReps: 8,
				notes: 'Fictional note'
			})
			.returning();
		const id = crypto.randomUUID(),
			key = photoKey(userId, id);
		await h.db.insert(s.equipmentPhotos).values({
			id,
			userId,
			gymId: gym.id,
			gymEquipmentId: machine.id,
			matchedModelId: model.id,
			storageKey: key,
			contentType: 'image/jpeg',
			bytes: 1,
			width: 1,
			height: 1,
			sha256: 'f'.repeat(64),
			status: 'confirmed'
		});
		await store.put(key, Buffer.from('fixture'), 'image/jpeg');
		const authSession = crypto.randomUUID();
		await h.db.insert(s.authSessions).values({
			id: authSession,
			userId,
			token: crypto.randomUUID(),
			expiresAt: new Date(Date.now() + 86400000)
		});
		return { gym, model, machine, exercise, program, day, session, set, id, key, authSession };
	}
	it('a deletion request needs a live session of an active account (session-liveness.ts)', async () => {
		const store = new MemoryPhotoStore();
		const a = await fixture(alice, store);
		const b = await fixture(bob, store);
		const fencedAt = async (userId: string) =>
			(await h.db.select().from(s.authUsers).where(eq(s.authUsers.id, userId)))[0]
				.deletionRequestedAt;
		// Positive first: a live session of an active account is accepted and fenced.
		expect(await requestAccountDeletion(h.db, alice, a.authSession, ledger)).not.toBeNull();
		expect(await fencedAt(alice)).not.toBeNull();
		expect(journal).toHaveLength(1);
		// An expired session: refused, nothing fenced, nothing journaled.
		await h.db
			.update(s.authSessions)
			.set({ expiresAt: new Date(Date.now() - 1000) })
			.where(eq(s.authSessions.id, b.authSession));
		expect(await requestAccountDeletion(h.db, bob, b.authSession, ledger)).toBeNull();
		expect(await fencedAt(bob)).toBeNull();
		// A live session of an account already fenced: refused, no second journal entry.
		await h.db
			.update(s.authSessions)
			.set({ expiresAt: new Date(Date.now() + 60000) })
			.where(eq(s.authSessions.id, b.authSession));
		await h.db
			.update(s.authUsers)
			.set({ deletionRequestedAt: new Date() })
			.where(eq(s.authUsers.id, bob));
		expect(await requestAccountDeletion(h.db, bob, b.authSession, ledger)).toBeNull();
		expect(journal).toHaveLength(1);
		expect(
			await h.db.select().from(s.privacyDeletions).where(eq(s.privacyDeletions.ownerId, bob))
		).toEqual([]);
	});
	it('revokes access immediately; object failure retains keys and restart retry removes only that account', async () => {
		const store = new MemoryPhotoStore();
		const a = await fixture(alice, store);
		const b = await fixture(bob, store);
		// Exercise the complete FK tree, including template history and notebook imports.
		const [oldProgram] = await h.db
			.insert(s.programs)
			.values({ userId: alice, name: 'Earlier fictional version', isActive: false })
			.returning();
		await h.db
			.update(s.programs)
			.set({ sourceProgramId: oldProgram.id })
			.where(eq(s.programs.id, a.program.id));
		const [de] = await h.db
			.insert(s.dayExercises)
			.values({ dayId: a.day.id, exerciseId: a.exercise.id, position: 1, tier: 'main' })
			.returning();
		const [ps] = await h.db
			.insert(s.prescribedSets)
			.values({ dayExerciseId: de.id, position: 1, setRole: 'working' })
			.returning();
		const [se] = await h.db
			.insert(s.sessionExercises)
			.values({
				sessionId: a.session.id,
				exerciseId: a.exercise.id,
				gymEquipmentId: a.machine.id,
				position: 1,
				exerciseName: 'Fixture lift',
				equipmentType: 'machine-stack',
				loadConvention: 'displayed',
				tier: 'main',
				progressionPolicy: 'standard'
			})
			.returning();
		await h.db
			.update(s.sets)
			.set({ prescribedSetId: ps.id, sessionExerciseId: se.id })
			.where(eq(s.sets.id, a.set.id));
		await h.db
			.update(s.equipmentPhotos)
			.set({ sessionExerciseId: se.id })
			.where(eq(s.equipmentPhotos.id, a.id));
		await h.db.insert(s.painEvents).values({
			userId: alice,
			setId: a.set.id,
			sessionId: a.session.id,
			exerciseId: a.exercise.id,
			location: 'Fictional shoulder',
			severity: 1
		});
		await h.db.insert(s.programDraftRequests).values({
			requestId: crypto.randomUUID(),
			userId: alice,
			programId: a.program.id,
			fingerprint: '0'.repeat(64)
		});
		await h.db
			.insert(s.exerciseEquipmentMap)
			.values({ exerciseId: a.exercise.id, equipmentModelId: a.model.id });
		const importId = crypto.randomUUID();
		await h.db.insert(s.workoutLogImports).values({
			id: importId,
			userId: alice,
			sourceSha256: 'fixture',
			sourceName: 'Fictional notebook',
			sourceText: 'Fictional notes'
		});
		await h.db.insert(s.importedWorkouts).values({
			id: crypto.randomUUID(),
			importId,
			sourceLine: 1,
			title: 'Fictional workout',
			dateNote: 'Unknown date',
			lines: []
		});
		await h.db.insert(s.authAccounts).values({
			id: crypto.randomUUID(),
			accountId: alice,
			providerId: 'credential',
			userId: alice,
			password: 'fictional-unused-hash'
		});
		const [global] = await h.db
			.insert(s.equipmentModels)
			.values({ manufacturer: 'Shared fixture', name: 'Catalog', loadingType: 'machine-stack' })
			.returning();
		expect(await requestAccountDeletion(h.db, alice, b.authSession, ledger)).toBeNull();
		expect(journal).toEqual([]);
		const clientId = crypto.randomUUID(),
			refreshId = crypto.randomUUID();
		const bearer = 'fictional-privacy-access-token';
		await h.db
			.insert(s.oauthClient)
			.values({ id: clientId, clientId, redirectUris: ['https://fixture.invalid/cb'] });
		await h.db.insert(s.oauthConsent).values({
			id: crypto.randomUUID(),
			clientId,
			userId: alice,
			scopes: ['workouts:read'],
			resources: [mcpResource()],
			createdAt: new Date(),
			updatedAt: new Date()
		});
		await h.db.insert(s.oauthRefreshToken).values({
			id: refreshId,
			clientId,
			userId: alice,
			sessionId: a.authSession,
			token: tokenHash('fictional-refresh'),
			scopes: ['workouts:read'],
			resources: [mcpResource()],
			createdAt: new Date(),
			expiresAt: new Date(Date.now() + 86400000)
		});
		await h.db.insert(s.oauthAccessToken).values({
			id: crypto.randomUUID(),
			clientId,
			userId: alice,
			sessionId: a.authSession,
			refreshId,
			token: tokenHash(bearer),
			scopes: ['workouts:read'],
			resources: [mcpResource()],
			createdAt: new Date(),
			expiresAt: new Date(Date.now() + 86400000)
		});
		await h.db.insert(s.authVerifications).values({
			id: crypto.randomUUID(),
			identifier: 'fictional-code',
			value: JSON.stringify({
				type: 'authorization_code',
				userId: alice,
				sessionId: a.authSession
			}),
			expiresAt: new Date(Date.now() + 60000)
		});
		expect((await authenticateMcp(h.db, 'Bearer ' + bearer))?.userId).toBe(alice);
		const job = await requestAccountDeletion(h.db, alice, a.authSession, ledger);
		expect(job).not.toBeNull();
		expect(await requestAccountDeletion(h.db, alice, a.authSession, ledger)).toBeNull();
		expect(journal).toHaveLength(1);
		await expect(
			h.db.update(s.authUsers).set({ name: 'late profile write' }).where(eq(s.authUsers.id, alice))
		).rejects.toMatchObject({ cause: { code: '23514' } });
		expect(await authenticateMcp(h.db, 'Bearer ' + bearer)).toBeNull();
		expect(await h.db.select().from(s.oauthRefreshToken)).toEqual([]);
		expect(await h.db.select().from(s.oauthConsent)).toEqual([]);
		expect(await h.db.select().from(s.authVerifications)).toEqual([]);
		expect(
			await h.db.select().from(s.authSessions).where(eq(s.authSessions.userId, alice))
		).toEqual([]);
		await expect(
			h.db.insert(s.authSessions).values({
				id: crypto.randomUUID(),
				userId: alice,
				token: crypto.randomUUID(),
				expiresAt: new Date(Date.now() + 1000)
			})
		).rejects.toThrow();
		await expect(
			h.db.update(s.sets).set({ executedLoad: 100 }).where(eq(s.sets.id, a.set.id))
		).rejects.toThrow();
		await expect(
			h.db.insert(s.days).values({ programId: a.program.id, name: 'late', position: 2 })
		).rejects.toThrow();
		const failing = Object.assign(new MemoryPhotoStore(), {
			erase: async () => {
				throw new Error('secret provider response');
			}
		});
		expect((await runDeletion(h.db, alice, job!.id, failing, ledger)).state).toBe('failed');
		expect(await store.get(a.key)).not.toBeNull();
		expect(
			(await h.db.select().from(s.photoObjects).where(eq(s.photoObjects.userId, alice))).map(
				(o) => o.storageKey
			)
		).toEqual([a.key]);
		expect((await h.db.select().from(s.privacyDeletions))[0].lastError).toBe('storage');
		expect((await runDeletion(h.db, bob, job!.id, store, ledger)).state).toBe('not_found');
		expect((await runDeletion(h.db, alice, job!.id, store, ledger)).state).toBe('completed');
		expect(await store.get(a.key)).toBeNull();
		expect(await store.get(b.key)).not.toBeNull();
		expect(await h.db.select().from(s.authUsers).where(eq(s.authUsers.id, alice))).toEqual([]);
		for (const [identifier, value] of [
			['late-code', JSON.stringify({ userId: alice })],
			['reset-password:late', alice]
		])
			await expect(
				h.db.insert(s.authVerifications).values({
					id: crypto.randomUUID(),
					identifier,
					value,
					expiresAt: new Date(Date.now() + 60000)
				})
			).rejects.toMatchObject({ cause: { code: '23514' } });

		expect((await h.db.select().from(s.sets)).map((r) => r.id)).toEqual([b.set.id]);
		expect(
			await h.db.select().from(s.equipmentModels).where(eq(s.equipmentModels.id, global.id))
		).toHaveLength(1);
		expect((await h.db.select().from(s.privacyDeletions))[0]).toMatchObject({
			ownerId: null,
			lastError: null
		});
	});
	it('resumes bounded batches including a pre-migration orphan', async () => {
		const store = new MemoryPhotoStore();
		const a = await fixture(alice, store);
		const orphan = photoKey(alice, crypto.randomUUID());
		await store.put(orphan, Buffer.from('orphan'), 'image/jpeg');
		const job = await requestAccountDeletion(h.db, alice, a.authSession, ledger);
		expect((await runDeletion(h.db, alice, job!.id, store, ledger, 1)).state).toBe('pending');
		expect((await runDeletion(h.db, alice, job!.id, store, ledger, 1)).state).toBe('completed');
		expect(store.keys()).toEqual([]);
	});
	it('removes a confirmed image with retry without changing performance or machine identity', async () => {
		const store = new MemoryPhotoStore();
		const a = await fixture(alice, store);
		const job = await requestPhotoDeletion(h.db, alice, a.id, ledger);
		expect(job).not.toBeNull();
		expect(await requestPhotoDeletion(h.db, bob, a.id, ledger)).toBeNull();
		expect((await requestPhotoDeletion(h.db, alice, a.id, ledger))?.id).toBe(job!.id);
		await expect(
			h.db
				.update(s.equipmentPhotos)
				.set({ candidate: { late: 'result' }, status: 'analyzed' })
				.where(eq(s.equipmentPhotos.id, a.id))
		).rejects.toThrow();
		expect((await runDeletion(h.db, alice, job!.id, store, ledger)).state).toBe('completed');
		expect(await store.get(a.key)).toBeNull();
		expect(await h.db.select().from(s.equipmentPhotos)).toEqual([]);
		expect((await h.db.select().from(s.sets))[0]).toEqual(a.set);
		expect((await h.db.select().from(s.gymEquipment))[0]).toEqual(a.machine);
	});
	it('refuses a corrupt object inventory pointing at another tenant prefix', async () => {
		const store = new MemoryPhotoStore();
		const b = await fixture(bob, store);
		await h.db
			.insert(s.photoObjects)
			.values({ storageKey: b.key, userId: alice, photoId: b.id, state: 'delete_pending' });
		await expect(erasePhotoObject(h.db, alice, b.key, store)).rejects.toThrow(
			'Object inventory owner mismatch'
		);
		expect(await store.get(b.key)).not.toBeNull();
		expect(await h.db.select().from(s.photoObjects)).toHaveLength(1);
	});
	it('orders a live upload before cleanup without holding a database transaction or web-pool connection', async () => {
		const store = new MemoryPhotoStore();
		const [gym] = await h.db
			.insert(s.gyms)
			.values({ userId: alice, name: 'Upload gym' })
			.returning();
		let entered!: () => void;
		let release!: () => void;
		const enteredPromise = new Promise<void>((r) => (entered = r));
		const released = new Promise<void>((r) => (release = r));
		const put = store.put.bind(store);
		store.put = async (...args) => {
			entered();
			await released;
			await put(...args);
		};
		const uploading = uploadPhoto(
			h.db,
			alice,
			{ gymId: gym.id, bytes: await smallPng() },
			{ store, limits: { dailyLimit: 20, maxBytes: 1000000 }, scan: async () => ({}) as never }
		).catch((e) => e);
		await enteredPromise;
		const authSession = crypto.randomUUID();
		await h.db.insert(s.authSessions).values({
			id: authSession,
			userId: alice,
			token: crypto.randomUUID(),
			expiresAt: new Date(Date.now() + 100000)
		});
		const job = await requestAccountDeletion(h.db, alice, authSession, ledger);
		// The upload holds the object's lock: busy, not a failure, and no retry mark.
		expect((await runDeletion(h.db, alice, job!.id, store, ledger)).state).toBe('busy');
		expect(
			(await h.db.select().from(s.privacyDeletions).where(eq(s.privacyDeletions.id, job!.id)))[0]
				.lastError
		).toBeNull();
		expect(
			(
				await h.db.execute(
					sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'`
				)
			)[0].n
		).toBe(0);
		release();
		await uploading;
		expect(store.keys()).toHaveLength(1);
		expect((await runDeletion(h.db, alice, job!.id, store, ledger)).state).toBe('completed');
		expect(store.keys()).toEqual([]);
	});
	it.each(['account', 'photo'] as const)(
		'commits the %s intent before remote acknowledgment and never erases on durability failure',
		async (kind) => {
			const store = new MemoryPhotoStore();
			const own = await fixture(alice, store);
			let entered!: () => void, release!: () => void;
			const arrived = new Promise<void>((resolve) => (entered = resolve));
			const held = new Promise<void>((resolve) => (release = resolve));
			const unavailable = {
				append: async () => {
					entered();
					await held;
					throw new Error('synthetic outage');
				}
			};
			const pending =
				kind === 'account'
					? requestAccountDeletion(h.db, alice, own.authSession, unavailable)
					: requestPhotoDeletion(h.db, alice, own.id, unavailable);
			const rejected = expect(pending).rejects.toThrow('durable journal');
			await arrived;
			try {
				const [job] = await h.db
					.select()
					.from(s.privacyDeletions)
					.where(eq(s.privacyDeletions.ownerId, alice));
				expect(job.kind).toBe(kind);
				expect(
					(
						await h.db.execute(
							sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'`
						)
					)[0].n
				).toBe(0);
				if (kind === 'account') {
					expect(
						await h.db.select().from(s.authSessions).where(eq(s.authSessions.id, own.authSession))
					).toEqual([]);
				} else {
					expect(
						(await h.db.select().from(s.equipmentPhotos).where(eq(s.equipmentPhotos.id, own.id)))[0]
							.status
					).toBe('discarded');
				}
				expect(store.keys()).toHaveLength(1);
			} finally {
				release();
				await rejected;
			}
			const [job] = await h.db
				.select()
				.from(s.privacyDeletions)
				.where(eq(s.privacyDeletions.ownerId, alice));
			expect(job.lastError).toBe('ledger');
			expect((await runDeletion(h.db, alice, job.id, store, unavailable)).state).toBe('failed');
			expect(store.keys()).toHaveLength(1);
			if (kind === 'photo') {
				await h.db
					.update(s.photoObjects)
					.set({ createdAt: new Date(Date.now() - 31 * 86400000) })
					.where(eq(s.photoObjects.userId, alice));
				expect((await sweepRetention(h.db, alice, { apply: true, store })).failed).toBe(1);
				expect(
					(await sweepRetention(h.db, alice, { apply: true, store, ledger: unavailable })).failed
				).toBe(1);
				expect(store.keys()).toHaveLength(1);
			}
			expect((await runDeletion(h.db, alice, job.id, store, ledger)).state).toBe('completed');
			expect(store.keys()).toEqual([]);
			expect(await h.db.select().from(s.authUsers).where(eq(s.authUsers.id, bob))).toHaveLength(1);
		}
	);

	it('reconciles the newest independent journal after an older restore, before serving data', async () => {
		const store = new MemoryPhotoStore();
		await fixture(alice, store);
		const b = await fixture(bob, store);
		const entries: LedgerEntry[] = [
			{
				version: 1,
				kind: 'account',
				subjectHash: subjectHash('account', alice),
				requestedAt: new Date().toISOString()
			},
			{
				version: 1,
				kind: 'photo',
				subjectHash: subjectHash('photo', b.id),
				requestedAt: new Date().toISOString()
			}
		];
		expect(await reconcileDeletions(h.db, entries)).toEqual({
			accounts: 1,
			photos: 1,
			applied: false
		});
		expect(await h.db.select().from(s.authSessions)).toHaveLength(2);
		expect(await reconcileDeletions(h.db, entries, true)).toEqual({
			accounts: 1,
			photos: 1,
			applied: true
		});
		expect((await h.db.select().from(s.authSessions)).map((r) => r.userId)).toEqual([bob]);
		for (const job of await h.db.select().from(s.privacyDeletions))
			expect((await runDeletion(h.db, job.ownerId!, job.id, store, ledger)).state).toBe(
				'completed'
			);
		expect(store.keys()).toEqual([]);
		expect((await h.db.select().from(s.sets)).map((r) => r.id)).toEqual([b.set.id]);
		expect(await reconcileDeletions(h.db, entries, true)).toEqual({
			accounts: 0,
			photos: 0,
			applied: true
		});
	});
	it('retention never cascades into live or foreign tokens and drains expired children in bounded batches', async () => {
		const expired = new Date(Date.now() - 8 * 86400000),
			future = new Date(Date.now() + 86400000);
		const sessionId = crypto.randomUUID(),
			refreshId = crypto.randomUUID(),
			clientId = crypto.randomUUID();
		await h.db
			.insert(s.authSessions)
			.values({ id: sessionId, userId: alice, token: crypto.randomUUID(), expiresAt: expired });
		await h.db
			.insert(s.oauthClient)
			.values({ id: clientId, clientId, redirectUris: ['https://fixture.invalid/cb'] });
		await h.db.insert(s.oauthRefreshToken).values({
			id: refreshId,
			clientId,
			userId: alice,
			sessionId,
			token: crypto.randomUUID(),
			scopes: [],
			createdAt: new Date(),
			expiresAt: expired
		});
		const [foreign] = await h.db
			.insert(s.oauthAccessToken)
			.values({
				id: crypto.randomUUID(),
				clientId,
				userId: bob,
				sessionId,
				refreshId,
				token: crypto.randomUUID(),
				scopes: [],
				createdAt: new Date(),
				expiresAt: future
			})
			.returning();
		const first = await sweepRetention(h.db, alice, { apply: true, limit: 1 });
		expect(first.sessions).toBe(0);
		expect(first.refreshTokens).toBe(0);
		expect((await h.db.select().from(s.oauthAccessToken))[0]).toEqual(foreign);
		await h.db
			.update(s.oauthAccessToken)
			.set({ expiresAt: expired })
			.where(eq(s.oauthAccessToken.id, foreign.id));
		await sweepRetention(h.db, alice, { apply: true, limit: 1 });
		expect(await h.db.select().from(s.oauthAccessToken)).toHaveLength(1);
		await sweepRetention(h.db, bob, { apply: true, limit: 1 });
		expect(await h.db.select().from(s.oauthAccessToken)).toHaveLength(0);
		const last = await sweepRetention(h.db, alice, { apply: true, limit: 1 });
		expect(last.refreshTokens).toBe(1);
		expect(last.sessions).toBe(1);
		expect(await h.db.select().from(s.authSessions)).toHaveLength(0);
	});
	it('uses a strict clock boundary, bounded dry-run, owner scope and keeps history and saved photos', async () => {
		const store = new MemoryPhotoStore();
		const a = await fixture(alice, store);
		await fixture(bob, store);
		const now = new Date();
		const cutoff = new Date(now.getTime() - 30 * 86400000);
		const insert = async (userId: string, createdAt: Date) => {
			const [r] = await h.db
				.insert(s.llmCalls)
				.values({
					userId,
					purpose: 'fixture',
					provider: 'fixture',
					model: 'fixture',
					status: 'ok',
					latencyMs: 1,
					promptHash: 'fixture',
					output: { private: 'fixture' },
					createdAt
				})
				.returning();
			return r;
		};
		const old = await insert(alice, new Date(cutoff.getTime() - 1));
		const edge = await insert(alice, cutoff);
		const foreign = await insert(bob, new Date(cutoff.getTime() - 1));
		expect((await sweepRetention(h.db, alice, { now, limit: 1 })).details).toBe(1);
		expect(
			(await h.db.select().from(s.llmCalls).where(eq(s.llmCalls.id, old.id)))[0].output
		).not.toBeNull();
		await sweepRetention(h.db, alice, { now, limit: 1, apply: true, store });
		expect(
			(await h.db.select().from(s.llmCalls).where(eq(s.llmCalls.id, old.id)))[0].output
		).toBeNull();
		for (const id of [edge.id, foreign.id])
			expect(
				(await h.db.select().from(s.llmCalls).where(eq(s.llmCalls.id, id)))[0].output
			).not.toBeNull();
		expect((await h.db.select().from(s.sets).where(eq(s.sets.id, a.set.id)))[0]).toEqual(a.set);
		expect(await store.get(a.key)).not.toBeNull();
	});
	describe('deletion job state (one vocabulary, one runner, no error on a completed job)', () => {
		const jobRow = (jobId: string) =>
			h.db
				.select()
				.from(s.privacyDeletions)
				.where(eq(s.privacyDeletions.id, jobId))
				.then((r) => r[0]);
		/** An erase that waits until released, so a run can be held mid-flight. */
		function holdErase(store: MemoryPhotoStore) {
			let entered!: () => void, release!: () => void;
			const arrived = new Promise<void>((r) => (entered = r));
			const held = new Promise<void>((r) => (release = r));
			const erase = store.erase.bind(store);
			store.erase = async (key: string) => {
				entered();
				await held;
				await erase(key);
			};
			return { arrived, release };
		}

		it('maps the columns in one place; completion wins over a stale error', () => {
			const at = new Date();
			expect(deletionJobState({ completedAt: null, lastError: null })).toBe('pending');
			expect(deletionJobState({ completedAt: null, lastError: 'storage' })).toBe('needs_retry');
			expect(deletionJobState({ completedAt: at, lastError: null })).toBe('completed');
			// The row the old failure path could leave behind.
			expect(deletionJobState({ completedAt: at, lastError: 'database' })).toBe('completed');
			expect(
				deletionJobSummary([
					{ completedAt: null, lastError: null, attempts: 1 },
					{ completedAt: null, lastError: 'ledger', attempts: 4 },
					{ completedAt: at, lastError: null, attempts: 9 }
				])
			).toEqual({ pending: 1, needsRetry: 1, maxAttempts: 4 });
		});

		it('a job row another connection holds is busy: no journal append, no attempt, no error', async () => {
			const store = new MemoryPhotoStore();
			const a = await fixture(alice, store);
			const job = (await requestPhotoDeletion(h.db, alice, a.id, ledger))!;
			let entered!: () => void, release!: () => void;
			const arrived = new Promise<void>((r) => (entered = r));
			const held = new Promise<void>((r) => (release = r));
			// A second connection holds the row as another runner's claim would.
			const holder = h.client.begin(async (sql) => {
				await sql`SELECT 1 FROM privacy_deletions WHERE id=${job.id} FOR UPDATE`;
				entered();
				await held;
			});
			await arrived;
			const appended = journal.length;
			try {
				expect(await runDeletion(h.db, alice, job.id, store, ledger)).toEqual({
					state: 'busy',
					removed: 0
				});
				// Another user's job id is not_found, never busy (D6).
				expect(await runDeletion(h.db, bob, job.id, store, ledger)).toEqual({
					state: 'not_found',
					removed: 0
				});
			} finally {
				release();
				await holder;
			}
			expect(journal.length).toBe(appended);
			expect(await jobRow(job.id)).toMatchObject({
				attempts: 0,
				lastError: null,
				completedAt: null
			});
			expect(await store.get(a.key)).not.toBeNull();
			expect(await runDeletion(h.db, alice, job.id, store, ledger)).toEqual({
				state: 'completed',
				removed: 1
			});
			expect(await jobRow(job.id)).toMatchObject({ attempts: 1, lastError: null });
		});

		it('a second runner while the first holds the lease is busy: no journal append, no attempt', async () => {
			const store = new MemoryPhotoStore();
			const a = await fixture(alice, store);
			const job = (await requestAccountDeletion(h.db, alice, a.authSession, ledger))!;
			const { arrived, release } = holdErase(store);
			const first = runDeletion(h.db, alice, job.id, store, ledger);
			try {
				await arrived;
				// Positive first: the first runner's claim is on the row, live.
				const during = await jobRow(job.id);
				expect(during.claimedUntil!.getTime()).toBeGreaterThan(Date.now());
				expect(during).toMatchObject({ attempts: 1, lastError: null, completedAt: null });
				const appended = journal.length;
				expect(await runDeletion(h.db, alice, job.id, store, ledger)).toEqual({
					state: 'busy',
					removed: 0
				});
				// Refused at the claim: nothing appended, counted or marked.
				expect(journal.length).toBe(appended);
				expect(await jobRow(job.id)).toMatchObject({
					attempts: 1,
					lastError: null,
					claimedUntil: during.claimedUntil
				});
				expect(deletionJobState(await jobRow(job.id))).toBe('pending');
				expect(await store.get(a.key)).not.toBeNull();
			} finally {
				release();
			}
			expect((await first).state).toBe('completed');
			const done = await jobRow(job.id);
			expect(deletionJobState(done)).toBe('completed');
			expect(done).toMatchObject({
				lastError: null,
				ownerId: null,
				attempts: 1,
				claimedUntil: null
			});
			expect(store.keys()).toEqual([]);
		});

		it('an expired lease is reclaimable; a live one is busy until it expires', async () => {
			const store = new MemoryPhotoStore();
			const a = await fixture(alice, store);
			const b = await fixture(bob, store);
			const expired = (await requestPhotoDeletion(h.db, alice, a.id, ledger))!;
			const live = (await requestPhotoDeletion(h.db, bob, b.id, ledger))!;
			const lease = (jobId: string, at: string) =>
				h.db.execute(
					sql`UPDATE privacy_deletions SET claimed_until = now() + ${at}::interval WHERE id = ${jobId}`
				);
			// A runner that died: its claim ran out a minute ago. Positive first.
			await lease(expired.id, '-1 minute');
			expect(await runDeletion(h.db, alice, expired.id, store, ledger)).toEqual({
				state: 'completed',
				removed: 1
			});
			expect(await jobRow(expired.id)).toMatchObject({ attempts: 1, claimedUntil: null });
			// A runner still within its lease.
			await lease(live.id, '1 minute');
			const appended = journal.length;
			expect(await runDeletion(h.db, bob, live.id, store, ledger)).toEqual({
				state: 'busy',
				removed: 0
			});
			expect(journal.length).toBe(appended);
			expect(await jobRow(live.id)).toMatchObject({ attempts: 0, lastError: null });
			expect(await store.get(b.key)).not.toBeNull();
			// Another user is not_found, never busy, even on a leased job (D6).
			expect((await runDeletion(h.db, alice, live.id, store, ledger)).state).toBe('not_found');
			await lease(live.id, '-1 second');
			expect((await runDeletion(h.db, bob, live.id, store, ledger)).state).toBe('completed');
		});

		it('completion, a recorded failure and a lease-bounded stop all release the claim', async () => {
			const store = new MemoryPhotoStore();
			const a = await fixture(alice, store);
			const job = (await requestPhotoDeletion(h.db, alice, a.id, ledger))!;
			const down = {
				append: async () => {
					throw new Error('synthetic outage');
				}
			};
			// Failure: the error and the release land together, so the next run claims.
			expect((await runDeletion(h.db, alice, job.id, store, down)).state).toBe('failed');
			expect(await jobRow(job.id)).toMatchObject({ lastError: 'ledger', claimedUntil: null });
			// A batch that reaches the lease's stop margin starts no object and
			// releases: the clock jumps past it while the journal append runs.
			let skew = 0;
			const now = Date.now.bind(Date);
			const clock = vi.spyOn(Date, 'now').mockImplementation(() => now() + skew);
			try {
				const slow = {
					append: async (entry: LedgerEntry) => {
						journal.push(entry);
						skew = DELETION_LEASE_MS;
					}
				};
				expect(await runDeletion(h.db, alice, job.id, store, slow)).toEqual({
					state: 'pending',
					removed: 0
				});
			} finally {
				clock.mockRestore();
			}
			expect(await store.get(a.key)).not.toBeNull();
			expect(await jobRow(job.id)).toMatchObject({ attempts: 2, claimedUntil: null });
			// Completion.
			expect((await runDeletion(h.db, alice, job.id, store, ledger)).state).toBe('completed');
			expect(await jobRow(job.id)).toMatchObject({
				attempts: 3,
				lastError: null,
				claimedUntil: null
			});
		});

		it("a run that outlived its lease never clears the next runner's claim, also when it fails", async () => {
			const store = new MemoryPhotoStore();
			const a = await fixture(alice, store);
			const job = (await requestPhotoDeletion(h.db, alice, a.id, ledger))!;
			// Positive first: a failure inside this run's own lease is recorded and releases.
			const down = {
				append: async () => {
					throw new Error('synthetic outage');
				}
			};
			expect((await runDeletion(h.db, alice, job.id, store, down)).state).toBe('failed');
			expect(await jobRow(job.id)).toMatchObject({ lastError: 'ledger', claimedUntil: null });

			// Now the run's lease runs out mid-flight, another runner claims the job
			// (a later claimed_until), and then this run fails.
			const replacement = new Date(Date.now() + 10 * 60_000);
			replacement.setMilliseconds(0);
			const overtaken = {
				append: async () => {
					await h.db
						.update(s.privacyDeletions)
						.set({ claimedUntil: replacement, lastError: null })
						.where(eq(s.privacyDeletions.id, job.id));
					throw new Error('synthetic outage');
				}
			};
			expect(await runDeletion(h.db, alice, job.id, store, overtaken)).toEqual({
				state: 'busy',
				removed: 0
			});
			// The replacement's claim stands and no failure was written over it, so a
			// third runner is still refused.
			const row = await jobRow(job.id);
			expect(row.claimedUntil!.getTime()).toBe(replacement.getTime());
			expect(row.lastError).toBeNull();
			expect((await runDeletion(h.db, alice, job.id, store, ledger)).state).toBe('busy');
			expect(await store.get(a.key)).not.toBeNull();
		});

		it('a failure after the job completed reports completion and writes no error onto it', async () => {
			const store = new MemoryPhotoStore();
			const a = await fixture(alice, store);
			const job = (await requestPhotoDeletion(h.db, alice, a.id, ledger))!;
			// The erasure commits the receipt's completion; the next plain read fails,
			// as a dropped connection would.
			let armed = false;
			const erase = store.erase.bind(store);
			store.erase = async (key: string) => {
				await erase(key);
				armed = true;
			};
			const flaky = new Proxy(h.db, {
				get(target, prop, receiver) {
					if (prop === 'select' && armed)
						return () => {
							throw new Error('connection lost');
						};
					return Reflect.get(target, prop, receiver);
				}
			}) as TestDb;
			configureStorageLocks(
				flaky,
				process.env.TEST_DATABASE_URL ?? 'postgresql://localhost/doclifts_test'
			);
			let result;
			try {
				result = await runDeletion(flaky, alice, job.id, store, ledger);
			} finally {
				await closeStorageLocks(flaky);
			}
			expect(armed).toBe(true);
			expect(store.keys()).toEqual([]);
			const row = await jobRow(job.id);
			expect(row.completedAt).not.toBeNull();
			expect(row.lastError).toBeNull();
			expect(result).toEqual({ state: 'completed', removed: 1 });
		});

		it('a journal failure never marks a completed receipt for retry', async () => {
			const store = new MemoryPhotoStore();
			const a = await fixture(alice, store);
			const job = (await requestPhotoDeletion(h.db, alice, a.id, ledger))!;
			const down = {
				append: async () => {
					throw new Error('synthetic outage');
				}
			};
			// Positive first: an open receipt does get the stage.
			await expect(erasePhotoObject(h.db, alice, a.key, store, false, down)).rejects.toThrow(
				'durable journal'
			);
			expect((await jobRow(job.id)).lastError).toBe('ledger');
			// Completed by another eraser meanwhile; the same failure leaves it alone.
			await h.db
				.update(s.privacyDeletions)
				.set({ completedAt: new Date(), lastError: null })
				.where(eq(s.privacyDeletions.id, job.id));
			await expect(erasePhotoObject(h.db, alice, a.key, store, false, down)).rejects.toThrow(
				'durable journal'
			);
			expect(await jobRow(job.id)).toMatchObject({ lastError: null });
		});

		it('counts every claimed run in attempts, failed ones included, and clears the error on completion', async () => {
			const store = new MemoryPhotoStore();
			const a = await fixture(alice, store);
			const job = (await requestPhotoDeletion(h.db, alice, a.id, ledger))!;
			const down = {
				append: async () => {
					throw new Error('synthetic outage');
				}
			};
			expect((await runDeletion(h.db, alice, job.id, store, down)).state).toBe('failed');
			expect((await runDeletion(h.db, alice, job.id, store, down)).state).toBe('failed');
			const failing = await jobRow(job.id);
			expect(failing).toMatchObject({ attempts: 2, lastError: 'ledger' });
			expect(deletionJobState(failing)).toBe('needs_retry');
			expect(deletionJobSummary([failing])).toEqual({ pending: 0, needsRetry: 1, maxAttempts: 2 });
			expect((await runDeletion(h.db, alice, job.id, store, ledger)).state).toBe('completed');
			const done = await jobRow(job.id);
			expect(done).toMatchObject({ attempts: 3, lastError: null });
			expect(deletionJobState(done)).toBe('completed');
		});
	});
});
