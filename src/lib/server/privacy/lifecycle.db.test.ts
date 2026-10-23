import { authenticateMcp } from '../mcp/access';
import { tokenHash, mcpResource } from '../mcp/config';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { setupTestDb, resetTestDb, withTwoUsers } from '../test-db';
import * as s from '../db/schema';
import { MemoryPhotoStore, photoKey } from '../photos/store';
import {
	requestAccountDeletion,
	requestPhotoDeletion,
	runDeletion,
	reconcileDeletions
} from './lifecycle';
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
	it('revokes access immediately; object failure retains keys and restart retry removes only that account', async () => {
		const store = new MemoryPhotoStore();
		const a = await fixture(alice, store);
		const b = await fixture(bob, store);
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
		expect((await h.db.select().from(s.sets)).map((r) => r.id)).toEqual([b.set.id]);
		expect(
			await h.db.select().from(s.equipmentModels).where(eq(s.equipmentModels.id, global.id))
		).toHaveLength(1);
		expect((await h.db.select().from(s.privacyDeletions))[0]).toMatchObject({
			ownerId: null,
			lastError: null
		});
	});
	it('keeps journal failure honest and resumes bounded batches including a pre-migration orphan', async () => {
		const store = new MemoryPhotoStore();
		const a = await fixture(alice, store);
		await expect(
			requestAccountDeletion(h.db, alice, a.authSession, {
				append: async () => {
					throw new Error('unavailable');
				}
			})
		).rejects.toThrow('unavailable');
		expect(
			(await h.db.select().from(s.authUsers).where(eq(s.authUsers.id, alice)))[0]
				.deletionRequestedAt
		).toBeNull();
		expect(await h.db.select().from(s.authSessions)).toHaveLength(1);
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
		expect((await runDeletion(h.db, alice, job!.id, store, ledger)).state).toBe('failed');
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
});
