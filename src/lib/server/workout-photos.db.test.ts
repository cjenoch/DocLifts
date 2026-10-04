import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { setupTestDb, resetTestDbWithUsers } from './test-db';
import { createGym, createMachine } from './machines';
import { equipmentPhotos } from './db/schema';
import { workoutMachinePhotos } from './workout-photos';
let harness: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
	harness = await setupTestDb();
});
afterAll(async () => {
	await harness?.end();
});
it('returns the owner’s confirmed machine photo, never another account’s or discarded photos', async () => {
	const { db, client } = harness;
	const [alice, bob] = await resetTestDbWithUsers(db, client, 2, 'workout-photo');
	const gym = await createGym(db, alice.id, { name: 'Photo gym' });
	const machine = await createMachine(db, alice.id, {
		gymId: gym.id,
		localLabel: 'Press',
		equipmentType: 'machine-stack'
	});
	const photo = {
		userId: alice.id,
		gymId: gym.id,
		gymEquipmentId: machine.id,
		contentType: 'image/jpeg',
		bytes: 100,
		width: 100,
		height: 100,
		sha256: 'a'.repeat(64)
	};
	const [confirmed] = await db
		.insert(equipmentPhotos)
		.values({
			...photo,
			storageKey: randomUUID(),
			status: 'confirmed',
			createdAt: new Date('2026-01-01')
		})
		.returning();
	await db.insert(equipmentPhotos).values({
		...photo,
		storageKey: randomUUID(),
		status: 'discarded',
		createdAt: new Date('2026-01-02')
	});
	expect(await workoutMachinePhotos(db, alice.id, [machine.id])).toEqual({
		[machine.id]: confirmed.id
	});
	expect(await workoutMachinePhotos(db, bob.id, [machine.id])).toEqual({});
	expect(await workoutMachinePhotos(db, alice.id, [])).toEqual({});
});
