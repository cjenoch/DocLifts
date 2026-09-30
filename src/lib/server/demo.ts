import { eq, sql } from 'drizzle-orm';
import type { Database } from './progression';
import * as s from './db/schema';
import { createUser, findUserByEmail } from './users';

const demoProgramId = 'd3e00000-0000-4000-8000-000000000001';

// The demo owner is a dedicated, shared, disposable account (work order T5):
// one user that owns every demo row, created by seedDemo itself. Not the
// operator's account and not the 0011 sentinel — the demo stack is reset on a
// schedule and the account resets with it. Every insert below stamps this id,
// because 0011 makes the owned columns NOT NULL.
const DEMO_EMAIL = process.env.DOCLIFTS_DEMO_EMAIL ?? 'demo@doclifts.local';
const DEMO_PASSWORD = process.env.DOCLIFTS_DEMO_PASSWORD ?? 'doclifts-demo-2026';
const DEMO_NAME = 'Demo User';

/** Fictional fixtures only. No truncation, overwrite, or production DB fallback. */
export async function seedDemo(db: Database, enabled: boolean) {
	if (!enabled) throw new Error('Demo seeding requires DOCLIFTS_DEMO=1.');
	// The database-name guard runs FIRST, before anything is written. Creating
	// the demo user before checking the name would leave an auth.user row in a
	// database seedDemo was about to refuse — a write on the path that exists
	// precisely to avoid writing.
	//
	// The check itself still happens inside the transaction below, on the same
	// connection, so the name read and the first write are in one snapshot.
	const [name] = await db.execute<{ name: string }>(sql`select current_database() as name`);
	if (!/^doclifts_demo(?:_test)?$/.test(name.name))
		throw new Error('Demo seeding is restricted to the doclifts_demo database.');

	// Created outside the transaction below: createUser goes through Better
	// Auth's own adapter and connection, so it cannot join our tx.
	//
	// Find-or-create, not create. A second seedDemo call must still reach the
	// "already seeded" short-circuit, and createUser throws on a duplicate
	// email — an unconditional create would turn that idempotence into a
	// duplicate-email error.
	const existingOwner = await findUserByEmail(db, DEMO_EMAIL);
	const owner = existingOwner
		? { id: existingOwner, email: DEMO_EMAIL, name: DEMO_NAME }
		: await createUser(db, { email: DEMO_EMAIL, password: DEMO_PASSWORD, name: DEMO_NAME });

	return db.transaction(async (tx) => {
		// Name already checked above, before any write. The advisory lock is
		// taken here so two concurrent seeds cannot both pass the emptiness
		// check and both insert.
		await tx.execute(sql`select pg_advisory_xact_lock(74632101)`);
		if ((await tx.select().from(s.programs).where(eq(s.programs.id, demoProgramId))).length)
			return 'already seeded';
		// auth.user is checked separately and first: the demo owner was just
		// created above, so a UNION here would both match the row we just made
		// and fail outright — auth.user.id is text while every public table's
		// id is uuid, and Postgres will not match them in one UNION.
		const [otherUsers] = await tx.execute<{ n: number }>(
			sql`select count(*)::int as n from auth.user where id <> ${owner.id}`
		);
		if (Number(otherUsers?.n ?? 0) > 0)
			throw new Error(
				'Demo seeding requires an empty database; existing users were left untouched.'
			);
		const [occupied] = await tx.execute<{ present: boolean }>(sql`select exists (
			select id from programs union all select id from exercises union all select id from sessions
			union all select id from sets union all select id from gyms union all select id from equipment_models
			union all select id from workout_log_imports union all select id from imported_workouts
		) as present`);
		if (occupied.present)
			throw new Error('Demo seeding requires an empty database; existing data was left untouched.');
		const [program] = await tx
			.insert(s.programs)
			.values({
				id: demoProgramId,
				userId: owner.id,
				name: 'Demo · Three-day training',
				description:
					'Fictional workouts for exploring DocLifts. These are sample records, not training advice.'
			})
			.returning();
		const [gym] = await tx
			.insert(s.gyms)
			.values({ userId: owner.id, name: 'Demo Gym' })
			.returning();
		const specs = [
			{
				name: 'Push',
				exercises: [
					['Dumbbell press', 'dumbbell', 30],
					['Cable fly', 'cable', 20],
					['Triceps pushdown', 'cable', 25]
				]
			},
			{
				name: 'Pull',
				exercises: [
					['Seated cable row', 'cable', 50],
					['Lat pulldown', 'machine-stack', 60],
					['Dumbbell curl', 'dumbbell', 15]
				]
			},
			{
				name: 'Legs',
				exercises: [
					['Leg press', 'machine-plate', 45],
					['Leg curl', 'machine-stack', 40],
					['Calf raise', 'machine-stack', 50]
				]
			}
		] as const;
		for (const [dayIndex, spec] of specs.entries()) {
			const [day] = await tx
				.insert(s.days)
				.values({
					programId: program.id,
					name: spec.name,
					position: dayIndex + 1,
					notes: 'Fictional demo program. Adjust before using for real training.'
				})
				.returning();
			const entries = [];
			for (const [index, [name, equipmentType, load]] of spec.exercises.entries()) {
				const [exercise] = await tx
					.insert(s.exercises)
					.values({ userId: owner.id, name, equipmentType, isLowerBody: dayIndex === 2 })
					.returning();
				const [machine] = await tx
					.insert(s.gymEquipment)
					.values({ gymId: gym.id, localLabel: `Demo ${name}`, equipmentType })
					.returning();
				const [dx] = await tx
					.insert(s.dayExercises)
					.values({
						dayId: day.id,
						exerciseId: exercise.id,
						position: index + 1,
						tier: 'secondary'
					})
					.returning();
				await tx.insert(s.prescribedSets).values(
					[1, 2].map((position) => ({
						dayExerciseId: dx.id,
						position,
						setRole: 'working' as const,
						targetRepsMin: 8,
						targetRepsMax: 12,
						targetRir: 2,
						initialLoad: load
					}))
				);
				entries.push({ exercise, machine, load, index });
			}
			// Two completed sessions per day, plus one active workout and one Trash example.
			const variants = dayIndex === 0 ? [14, 7, 0] : dayIndex === 1 ? [13, 6, 20] : [12, 5];
			for (const age of variants) {
				const startedAt = new Date();
				startedAt.setDate(startedAt.getDate() - age);
				startedAt.setHours(10, 0, 0, 0);
				const active = age === 0;
				const [session] = await tx
					.insert(s.sessions)
					.values({
						userId: owner.id,
						dayId: day.id,
						programId: program.id,
						startedAt,
						endedAt: active ? null : new Date(startedAt.getTime() + 45 * 60000),
						deletedAt: age === 20 ? new Date(startedAt.getTime() + 60 * 60000) : null,
						notes: 'Fictional demo session.'
					})
					.returning();
				for (const { exercise, machine, load, index } of entries) {
					const loadConvention: typeof s.sets.$inferInsert.loadConvention =
						exercise.equipmentType === 'dumbbell'
							? 'per_arm'
							: exercise.equipmentType === 'machine-plate'
								? 'plates_per_side'
								: 'displayed';
					const [occurrence] = await tx
						.insert(s.sessionExercises)
						.values({
							sessionId: session.id,
							exerciseId: exercise.id,
							gymEquipmentId: machine.id,
							position: index + 1,
							exerciseName: exercise.name,
							machineLabel: machine.localLabel,
							gymName: gym.name,
							equipmentType: exercise.equipmentType,
							loadConvention,
							tier: 'secondary',
							progressionPolicy: 'standard'
						})
						.returning();
					await tx.insert(s.sets).values(
						[1, 2].map((position) => ({
							userId: owner.id,
							sessionId: session.id,
							sessionExerciseId: occurrence.id,
							exerciseId: exercise.id,
							gymEquipmentId: machine.id,
							loadConvention,
							position,
							setRole: 'working' as const,
							prescribedLoad: load,
							prescribedRepsMin: 8,
							prescribedRepsMax: 12,
							prescribedRir: 2,
							executedLoad: !active || (index === 0 && position === 1) ? load : null,
							executedReps: !active || (index === 0 && position === 1) ? (age > 7 ? 10 : 12) : null,
							executedRir: !active || (index === 0 && position === 1) ? 2 : null,
							loggedAt: startedAt
						}))
					);
				}
			}
		}
		return 'seeded fictional demo data';
	});
}
