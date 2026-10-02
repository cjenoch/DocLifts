/**
 * Photo in the workout (0.6.0, SPEC 0.5.0 Part C). One path for every photo:
 *
 * 1. `openPhotoBlock`: the stored photo opens a block at once, on a placeholder
 *    machine in the session's gym ("Photo 14:32") and the user's placeholder
 *    exercise ("Unidentified machine"). Set entry works straight away.
 * 2. The read runs afterwards (`analyzePhoto`, unchanged) while sets are logged.
 * 3. `identifySessionExercise`: "Use this" (or the review page) sets the model,
 *    the exercise and the load convention on the block. It never changes a
 *    saved load, rep, RIR or note.
 *
 * Identify only ever touches a block a photo opened that is still on the
 * placeholder exercise, so the refusal to change a program exercise's machine
 * after values are saved (`bindSessionMachine`) is untouched. It is allowed on
 * an ended workout: "name it later" is filling in an unknown machine, not
 * switching one (docs/machine-identity.md, "Photo blocks").
 *
 * Every function takes the owner's id (D5); another user's session, block,
 * photo or model is "not found" (D6).
 */
import { and, asc, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
	equipmentModels,
	equipmentPhotos,
	exerciseEquipmentMap,
	exercises,
	gymEquipment,
	gyms,
	sessionExercises,
	sessions,
	sets
} from './db/schema';
import type { Database } from './progression';
import {
	addSessionExercise,
	createMachine,
	MachineInputError,
	prefillOccurrence
} from './machines';
import { modelVisibleTo } from './catalog';
import { matchCandidate } from './photos/match';
import { parseCandidate } from './photos/analyze';
import { defaultMachineLabel } from '../catalog-labels';
import { workoutUi } from '../workout-ui';

/** Marks the per-user placeholder exercise, whatever its display name. */
export const PLACEHOLDER_MOVEMENT = 'unidentified-machine';

const convention = z.enum(['unknown', 'plates_per_side', 'total_plates', 'per_arm', 'displayed']);
type Convention = z.infer<typeof convention>;

/** How weight is recorded on a machine of this type once it is identified. */
export const conventionFor = (equipmentType: string): Convention =>
	workoutUi.photoConvention[equipmentType] ?? 'unknown';

/** This user's placeholder exercise, created on first use. */
export async function ensurePlaceholderExercise(db: Database, userId: string) {
	const mine = () =>
		db
			.select()
			.from(exercises)
			.where(
				and(eq(exercises.userId, userId), eq(exercises.canonicalMovement, PLACEHOLDER_MOVEMENT))
			)
			.limit(1);
	const [existing] = await mine();
	if (existing) return existing;
	const [created] = await db
		.insert(exercises)
		.values({
			name: workoutUi.placeholderExerciseName,
			canonicalMovement: PLACEHOLDER_MOVEMENT,
			equipmentType: workoutUi.photoPlaceholderType,
			userId
		})
		.onConflictDoNothing()
		.returning();
	if (created) return created;
	// The name was taken by an exercise the user made themselves: mark that one.
	const [byName] = await db
		.update(exercises)
		.set({ canonicalMovement: PLACEHOLDER_MOVEMENT })
		.where(and(eq(exercises.userId, userId), eq(exercises.name, workoutUi.placeholderExerciseName)))
		.returning();
	return byName;
}

/**
 * The label's time. The phone sends its own local time ("2:32 PM"); the server
 * does not know the user's time zone, so its fallback is UTC. Only a short,
 * plain time is accepted from the form.
 */
export const photoTimeLabel = (fromClient: unknown, now = new Date()): string =>
	typeof fromClient === 'string' && /^[0-9]{1,2}:[0-9]{2}( ?[AaPp][Mm])?$/.test(fromClient.trim())
		? fromClient.trim()
		: now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });

/**
 * Step 1: the stored photo opens a block. Idempotent per photo: a photo that
 * already opened a block returns that block. Throws `MachineInputError` when
 * the session is not this user's open workout, has no gym, or the photo is not
 * this user's fresh upload at that gym.
 */
export async function openPhotoBlock(
	db: Database,
	userId: string,
	sessionId: string,
	photoId: string,
	opts: { requestId?: string; timeLabel?: string } = {}
) {
	z.string().uuid().parse(photoId);
	return db.transaction(async (tx) => {
		const [session] = await tx
			.select()
			.from(sessions)
			.where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
			.for('update');
		if (!session || session.deletedAt) throw new MachineInputError('Session not found');
		if (session.endedAt) throw new MachineInputError('Session has ended');
		if (!session.gymId) throw new MachineInputError('This workout has no gym');
		const [photo] = await tx
			.select()
			.from(equipmentPhotos)
			.where(and(eq(equipmentPhotos.id, photoId), eq(equipmentPhotos.userId, userId)))
			.for('update');
		if (!photo || photo.gymId !== session.gymId) throw new MachineInputError('Photo not found');
		if (photo.sessionExerciseId) {
			const [open] = await tx
				.select()
				.from(sessionExercises)
				.where(eq(sessionExercises.id, photo.sessionExerciseId));
			if (open && open.sessionId === sessionId) return open;
			throw new MachineInputError('Photo not found');
		}
		const exercise = await ensurePlaceholderExercise(tx, userId);
		const machine = await createMachine(tx, userId, {
			gymId: session.gymId,
			localLabel: workoutUi.photoMachineLabel(photoTimeLabel(opts.timeLabel)),
			equipmentType: exercise.equipmentType
		});
		const occurrence = await addSessionExercise(tx, userId, sessionId, {
			requestId: opts.requestId,
			exerciseId: exercise.id,
			equipmentType: exercise.equipmentType,
			gymId: session.gymId,
			gymEquipmentId: machine.id,
			loadConvention: 'unknown',
			setCount: workoutUi.photoBlockSets,
			repsMin: workoutUi.photoBlockRepsMin,
			repsMax: workoutUi.photoBlockRepsMax,
			rir: workoutUi.photoBlockRir,
			tier: 'secondary',
			progressionPolicy: 'standard'
		});
		await tx
			.update(equipmentPhotos)
			.set({ sessionExerciseId: occurrence.id })
			.where(and(eq(equipmentPhotos.id, photo.id), eq(equipmentPhotos.userId, userId)));
		return occurrence;
	});
}

const identifySchema = z.object({
	modelId: z.string().uuid(),
	exerciseName: z.preprocess(
		(v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
		z.string().trim().min(1).max(120).optional()
	),
	loadConvention: z.preprocess(
		(v) => (v === '' || v == null ? undefined : v),
		convention.optional()
	)
});

/** The exercise to suggest for a model: one this user has used on it, else its catalog name. */
export async function suggestedExerciseName(
	db: Database,
	userId: string,
	model: { id: string; name: string }
): Promise<string> {
	const [used] = await db
		.select({ name: exercises.name })
		.from(exerciseEquipmentMap)
		.innerJoin(exercises, eq(exercises.id, exerciseEquipmentMap.exerciseId))
		.where(
			and(
				eq(exerciseEquipmentMap.equipmentModelId, model.id),
				eq(exercises.userId, userId),
				// IS DISTINCT FROM: most exercises have no movement, and NULL <> x is not true.
				sql`${exercises.canonicalMovement} IS DISTINCT FROM ${PLACEHOLDER_MOVEMENT}`
			)
		)
		.orderBy(asc(exercises.name))
		.limit(1);
	return used?.name ?? model.name;
}

/**
 * Step 3: identify a photo block. Sets the model on the placeholder machine, or,
 * when the gym already has a machine with that model, moves the block, its sets
 * and its photo there and removes the placeholder. Sets the exercise (the name
 * given, else the suggestion; an existing exercise of that name is reused) and
 * the load convention. Only identity columns move: no load, rep, RIR or note is
 * written. When nothing is logged yet on an open workout, the sets are
 * prefilled from that machine's history, as any newly bound machine is.
 *
 * Returns null when the block is not this user's unidentified photo block.
 */
export async function identifySessionExercise(
	db: Database,
	userId: string,
	sessionId: string,
	occurrenceId: string,
	input: unknown
) {
	z.string().uuid().parse(sessionId);
	z.string().uuid().parse(occurrenceId);
	const value = identifySchema.parse(input);
	return db.transaction(async (tx) => {
		// Serialises with set updates and quick-add, like every block change.
		const [session] = await tx
			.select()
			.from(sessions)
			.where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
			.for('update');
		if (!session || session.deletedAt) return null;
		const [block] = await tx
			.select({ occurrence: sessionExercises, exercise: exercises })
			.from(sessionExercises)
			.innerJoin(exercises, eq(exercises.id, sessionExercises.exerciseId))
			.where(
				and(
					eq(sessionExercises.id, occurrenceId),
					eq(sessionExercises.sessionId, sessionId),
					eq(exercises.userId, userId),
					eq(exercises.canonicalMovement, PLACEHOLDER_MOVEMENT)
				)
			);
		if (!block) return null;
		const [photo] = await tx
			.select()
			.from(equipmentPhotos)
			.where(
				and(eq(equipmentPhotos.sessionExerciseId, occurrenceId), eq(equipmentPhotos.userId, userId))
			)
			.orderBy(desc(equipmentPhotos.createdAt))
			.limit(1);
		if (!photo) return null;
		const placeholderId = block.occurrence.gymEquipmentId;
		const [placeholder] = placeholderId
			? await tx.select().from(gymEquipment).where(eq(gymEquipment.id, placeholderId))
			: [];
		if (!placeholder) return null;
		// modelVisibleTo: a retired or foreign model is "not found" for a machine.
		const [model] = await tx
			.select()
			.from(equipmentModels)
			.where(and(eq(equipmentModels.id, value.modelId), modelVisibleTo(userId)));
		if (!model) throw new MachineInputError('Model not found');
		const equipmentType = model.loadingType;

		// The machine: one this gym already has with that model, else the placeholder.
		const [existing] = await tx
			.select()
			.from(gymEquipment)
			.where(
				and(
					eq(gymEquipment.gymId, placeholder.gymId),
					eq(gymEquipment.equipmentModelId, model.id),
					ne(gymEquipment.id, placeholder.id)
				)
			)
			.orderBy(asc(gymEquipment.localLabel))
			.limit(1);
		let machine = existing;
		if (!machine) {
			[machine] = await tx
				.update(gymEquipment)
				.set({
					equipmentModelId: model.id,
					equipmentType,
					localLabel: defaultMachineLabel(model),
					stackLb: placeholder.stackLb ?? model.standardStackLb
				})
				.where(eq(gymEquipment.id, placeholder.id))
				.returning();
		}

		// The exercise: the name given or suggested; an existing one is reused.
		const exerciseName = value.exerciseName ?? (await suggestedExerciseName(tx, userId, model));
		let [exercise] = await tx
			.select()
			.from(exercises)
			.where(and(eq(exercises.userId, userId), eq(exercises.name, exerciseName)));
		if (exercise && exercise.canonicalMovement === PLACEHOLDER_MOVEMENT)
			throw new MachineInputError('Choose a name for the exercise');
		if (exercise && exercise.equipmentType !== equipmentType)
			throw new MachineInputError(
				`"${exerciseName}" is an exercise for different equipment; give this one another name`
			);
		if (!exercise)
			[exercise] = await tx
				.insert(exercises)
				.values({ name: exerciseName, equipmentType, userId })
				.returning();

		const loadConvention = value.loadConvention ?? conventionFor(equipmentType);
		const [gym] = await tx.select().from(gyms).where(eq(gyms.id, placeholder.gymId));
		const [updated] = await tx
			.update(sessionExercises)
			.set({
				exerciseId: exercise.id,
				exerciseName: exercise.name,
				gymEquipmentId: machine.id,
				machineLabel: machine.localLabel,
				gymName: gym?.name ?? block.occurrence.gymName,
				modelName: `${model.manufacturer} ${model.name}`,
				equipmentType,
				loadConvention
			})
			.where(eq(sessionExercises.id, occurrenceId))
			.returning();
		// Identity columns only: never executed or prescribed values, never notes.
		await tx
			.update(sets)
			.set({ exerciseId: exercise.id, gymEquipmentId: machine.id, loadConvention })
			.where(eq(sets.sessionExerciseId, occurrenceId));
		await tx
			.insert(exerciseEquipmentMap)
			.values({ exerciseId: exercise.id, equipmentModelId: model.id })
			.onConflictDoNothing();
		await tx
			.update(equipmentPhotos)
			.set({ status: 'confirmed', matchedModelId: model.id, gymEquipmentId: machine.id })
			.where(eq(equipmentPhotos.sessionExerciseId, occurrenceId));

		if (machine.id !== placeholder.id) {
			// Merged: anything else still on the placeholder moves too, then it goes.
			await tx
				.update(equipmentPhotos)
				.set({ gymEquipmentId: machine.id })
				.where(eq(equipmentPhotos.gymEquipmentId, placeholder.id));
			const [stillUsed] = await tx
				.select({ n: sql<number>`count(*)::int` })
				.from(sessionExercises)
				.where(eq(sessionExercises.gymEquipmentId, placeholder.id));
			const [setsUsing] = await tx
				.select({ n: sql<number>`count(*)::int` })
				.from(sets)
				.where(eq(sets.gymEquipmentId, placeholder.id));
			if (!stillUsed.n && !setsUsing.n)
				await tx.delete(gymEquipment).where(eq(gymEquipment.id, placeholder.id));
		}

		// Last time's numbers, only while nothing is logged on an open workout.
		if (!session.endedAt) {
			const logged = await tx
				.select({ id: sets.id })
				.from(sets)
				.where(
					and(
						eq(sets.sessionExerciseId, occurrenceId),
						sql`(${sets.executedLoad} IS NOT NULL OR ${sets.executedReps} IS NOT NULL OR ${sets.executedRir} IS NOT NULL OR ${sets.notes} IS NOT NULL)`
					)
				)
				.limit(1);
			if (!logged.length) await prefillOccurrence(tx, userId, updated);
		}
		return { occurrence: updated, machineId: machine.id, merged: machine.id !== placeholder.id };
	});
}

export type PhotoBlockState =
	| { kind: 'reading'; photoId: string }
	| { kind: 'failed'; photoId: string }
	| {
			kind: 'match';
			photoId: string;
			modelId: string;
			modelLabel: string;
			exerciseName: string;
			loadConvention: Convention;
			equipmentType: string;
	  }
	| { kind: 'none'; photoId: string };

/**
 * What each unidentified photo block of this session shows, by block id.
 * `uploaded`: the read has not finished (the page reads it once, right after
 * the photo; on a later load it offers "Read again"). `analyzed` with a
 * preselected match: the "Use this" card. Anything else: name it now or later.
 */
export async function photoBlocksForSession(
	db: Database,
	userId: string,
	sessionId: string
): Promise<Record<string, PhotoBlockState>> {
	const rows = await db
		.select({ photo: equipmentPhotos, occurrenceId: sessionExercises.id })
		.from(equipmentPhotos)
		.innerJoin(sessionExercises, eq(sessionExercises.id, equipmentPhotos.sessionExerciseId))
		.innerJoin(exercises, eq(exercises.id, sessionExercises.exerciseId))
		.where(
			and(
				eq(equipmentPhotos.userId, userId),
				ne(equipmentPhotos.status, 'discarded'),
				eq(sessionExercises.sessionId, sessionId),
				eq(exercises.userId, userId),
				eq(exercises.canonicalMovement, PLACEHOLDER_MOVEMENT)
			)
		)
		.orderBy(desc(equipmentPhotos.createdAt));
	const out: Record<string, PhotoBlockState> = {};
	for (const { photo, occurrenceId } of rows) {
		if (out[occurrenceId]) continue;
		if (photo.status === 'uploaded') {
			out[occurrenceId] = { kind: 'reading', photoId: photo.id };
			continue;
		}
		const candidate = photo.status === 'analyzed' ? parseCandidate(photo.candidate) : null;
		if (!candidate) {
			out[occurrenceId] = { kind: 'none', photoId: photo.id };
			continue;
		}
		const found = await matchCandidate(db, userId, candidate);
		const model = found.preselectedId
			? found.matches.find((m) => m.id === found.preselectedId)
			: undefined;
		if (!model) {
			out[occurrenceId] = { kind: 'none', photoId: photo.id };
			continue;
		}
		out[occurrenceId] = {
			kind: 'match',
			photoId: photo.id,
			modelId: model.id,
			modelLabel: defaultMachineLabel(model),
			exerciseName: await suggestedExerciseName(db, userId, model),
			loadConvention: conventionFor(model.loadingType),
			equipmentType: model.loadingType
		};
	}
	return out;
}

/**
 * Unidentified photo blocks across this user's workouts (Home's "N machines to
 * name"). A block whose photo was discarded is no longer counted: there is
 * nothing left to name it from.
 */
export async function machinesToName(
	db: Database,
	userId: string
): Promise<{ count: number; latestSessionId: string | null }> {
	const rows = await db
		.selectDistinct({
			occurrenceId: sessionExercises.id,
			sessionId: sessions.id,
			startedAt: sessions.startedAt
		})
		.from(sessionExercises)
		.innerJoin(sessions, eq(sessions.id, sessionExercises.sessionId))
		.innerJoin(exercises, eq(exercises.id, sessionExercises.exerciseId))
		.innerJoin(equipmentPhotos, eq(equipmentPhotos.sessionExerciseId, sessionExercises.id))
		.where(
			and(
				eq(sessions.userId, userId),
				isNull(sessions.deletedAt),
				eq(equipmentPhotos.userId, userId),
				ne(equipmentPhotos.status, 'discarded'),
				eq(exercises.userId, userId),
				eq(exercises.canonicalMovement, PLACEHOLDER_MOVEMENT)
			)
		)
		.orderBy(desc(sessions.startedAt));
	return { count: rows.length, latestSessionId: rows[0]?.sessionId ?? null };
}

/**
 * The workout block a photo opened, while it is still unidentified, or null.
 * The review page uses it to identify the block instead of adding a machine.
 */
export async function unidentifiedBlockOfPhoto(
	db: Database,
	userId: string,
	photoId: string
): Promise<{ sessionId: string; occurrenceId: string } | null> {
	const [row] = await db
		.select({ sessionId: sessionExercises.sessionId, occurrenceId: sessionExercises.id })
		.from(equipmentPhotos)
		.innerJoin(sessionExercises, eq(sessionExercises.id, equipmentPhotos.sessionExerciseId))
		.innerJoin(sessions, eq(sessions.id, sessionExercises.sessionId))
		.innerJoin(exercises, eq(exercises.id, sessionExercises.exerciseId))
		.where(
			and(
				eq(equipmentPhotos.id, photoId),
				eq(equipmentPhotos.userId, userId),
				eq(sessions.userId, userId),
				isNull(sessions.deletedAt),
				eq(exercises.userId, userId),
				eq(exercises.canonicalMovement, PLACEHOLDER_MOVEMENT)
			)
		);
	return row ?? null;
}
