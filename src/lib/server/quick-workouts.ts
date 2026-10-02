/**
 * Workouts with no program (0.5.1, spec 0.5.0 Part B).
 *
 * Each user gets one hidden system program (`programs.system_kind = 'quick'`)
 * with one day, and a quick workout is an ordinary session on that day. So
 * `sessions.day_id` and `sessions.program_id` stay NOT NULL, and
 * `startSessionForDay` stays the only way a session is created.
 */
import { and, asc, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { days, gymEquipment, gyms, programs, sessionExercises, sessions } from './db/schema';
import type { Database } from './progression';
import { startSessionForDay, type StartSessionResult } from './sessions';
import { createGym } from './machines';
import { workoutUi } from '../workout-ui';

export const QUICK = 'quick' as const;
// The partial index's predicate, repeated so ON CONFLICT can infer that index.
const QUICK_INDEX_WHERE = sql`system_kind = 'quick'`;

/**
 * The user's quick program and its day, created on first use.
 *
 * Idempotent through `programs_one_quick_per_user`: the insert is
 * ON CONFLICT DO NOTHING, so two concurrent first calls both end up with the
 * one row the winner committed (the loser's insert waits on the index, then
 * reads it). The day is made the same way through `days_program_position_unique`.
 */
export async function ensureQuickProgram(
	db: Database,
	userId: string
): Promise<{ programId: string; dayId: string }> {
	return db.transaction(async (tx) => {
		await tx
			.insert(programs)
			.values({ userId, name: workoutUi.quickProgramName, systemKind: QUICK })
			.onConflictDoNothing({
				target: programs.userId,
				where: QUICK_INDEX_WHERE
			});
		const [program] = await tx
			.select({ id: programs.id })
			.from(programs)
			.where(and(eq(programs.userId, userId), eq(programs.systemKind, QUICK)));
		await tx
			.insert(days)
			.values({ programId: program.id, name: workoutUi.quickDayName, position: 1 })
			.onConflictDoNothing({ target: [days.programId, days.position] });
		const [day] = await tx
			.select({ id: days.id })
			.from(days)
			.where(and(eq(days.programId, program.id), eq(days.position, 1)));
		return { programId: program.id, dayId: day.id };
	});
}

/** The gym, if it is this user's. Another user's gym reads as absent (D6). */
async function ownedGym(db: Database, userId: string, gymId: string) {
	if (!z.string().uuid().safeParse(gymId).success) return null;
	const [gym] = await db
		.select({ id: gyms.id })
		.from(gyms)
		.where(and(eq(gyms.id, gymId), eq(gyms.userId, userId)));
	return gym ?? null;
}

/**
 * Start (or return) the user's open quick workout at `gymId`.
 *
 * The gym is checked first, so a foreign or unknown gym is a 404 with nothing
 * written: no quick program, no session. A second call while a quick workout
 * is open returns that workout through `sessions_one_open_per_day`, and does
 * not move it to another gym.
 */
export async function startQuickSession(
	db: Database,
	userId: string,
	gymId: string
): Promise<StartSessionResult> {
	const gym = await ownedGym(db, userId, gymId);
	if (!gym) return { ok: false, status: 404, message: 'Gym not found' };
	const { dayId } = await ensureQuickProgram(db, userId);
	const started = await startSessionForDay(db, userId, dayId);
	if (!started.ok) return started;
	await db
		.update(sessions)
		.set({ gymId: gym.id })
		.where(
			and(eq(sessions.id, started.sessionId), eq(sessions.userId, userId), isNull(sessions.gymId))
		);
	return started;
}

/** The user's open quick workout, or null. Drives "Resume workout" on Home. */
export async function openQuickSessionId(db: Database, userId: string): Promise<string | null> {
	const [row] = await db
		.select({ id: sessions.id })
		.from(sessions)
		.innerJoin(programs, eq(programs.id, sessions.programId))
		.where(
			and(
				eq(sessions.userId, userId),
				eq(programs.userId, userId),
				eq(programs.systemKind, QUICK),
				isNull(sessions.endedAt),
				isNull(sessions.deletedAt)
			)
		)
		.orderBy(desc(sessions.startedAt))
		.limit(1);
	return row?.id ?? null;
}

/**
 * The gym this user trained at most recently: the latest session that
 * recorded one, else the gym of the latest machine logged in any session.
 * Null when there is neither. Both reads are scoped through `gyms.user_id`.
 */
export async function lastUsedGymId(db: Database, userId: string): Promise<string | null> {
	const [bySession] = await db
		.select({ id: gyms.id })
		.from(sessions)
		.innerJoin(gyms, eq(gyms.id, sessions.gymId))
		.where(and(eq(sessions.userId, userId), eq(gyms.userId, userId), isNull(sessions.deletedAt)))
		.orderBy(desc(sessions.startedAt))
		.limit(1);
	if (bySession) return bySession.id;
	const [byMachine] = await db
		.select({ id: gyms.id })
		.from(sessionExercises)
		.innerJoin(sessions, eq(sessions.id, sessionExercises.sessionId))
		.innerJoin(gymEquipment, eq(gymEquipment.id, sessionExercises.gymEquipmentId))
		.innerJoin(gyms, eq(gyms.id, gymEquipment.gymId))
		.where(
			and(
				eq(sessions.userId, userId),
				eq(gyms.userId, userId),
				isNotNull(sessionExercises.gymEquipmentId)
			)
		)
		.orderBy(desc(sessions.startedAt))
		.limit(1);
	return byMachine?.id ?? null;
}

/** What the gym step renders: the user's gyms and the one to preselect. */
export async function quickStartChoices(db: Database, userId: string) {
	const list = await db
		.select({ id: gyms.id, name: gyms.name })
		.from(gyms)
		.where(eq(gyms.userId, userId))
		.orderBy(asc(gyms.name));
	const last = await lastUsedGymId(db, userId);
	return { gyms: list, defaultGymId: last ?? list[0]?.id ?? null };
}

const startInput = z.union([
	z.object({ gymId: z.string().uuid() }),
	z.object({ newGymName: z.string().trim().min(1).max(120) })
]);

/**
 * The gym step's submit: an existing gym by id, or a new gym by name. A name
 * the user already has is reused rather than duplicated (a double tap on the
 * first run would otherwise make two gyms).
 */
export async function startQuickSessionFromForm(
	db: Database,
	userId: string,
	input: { gymId?: unknown; newGymName?: unknown }
): Promise<StartSessionResult> {
	const raw =
		typeof input.newGymName === 'string' && input.newGymName.trim() !== ''
			? { newGymName: input.newGymName }
			: { gymId: input.gymId };
	const parsed = startInput.safeParse(raw);
	if (!parsed.success) {
		return 'newGymName' in raw
			? { ok: false, status: 400, message: 'Give the gym a name of 120 characters or fewer' }
			: { ok: false, status: 400, message: 'Choose a gym, or type a new gym name' };
	}
	let gymId: string;
	if ('newGymName' in parsed.data) {
		const name = parsed.data.newGymName;
		const [existing] = await db
			.select({ id: gyms.id })
			.from(gyms)
			.where(and(eq(gyms.userId, userId), eq(gyms.name, name)))
			.limit(1);
		gymId = existing?.id ?? (await createGym(db, userId, { name })).id;
	} else gymId = parsed.data.gymId;
	return startQuickSession(db, userId, gymId);
}
