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
import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
	equipmentModels,
	equipmentPhotos,
	exerciseEquipmentMap,
	exercises,
	gymEquipment,
	gyms,
	llmCalls,
	sessionExercises,
	sessions,
	sets
} from './db/schema';
import type { Database } from './progression';
import {
	addSessionExercise,
	createMachine,
	lockMachineForUse,
	MachineInputError,
	machineIsReferenced,
	prefillOccurrence,
	relinkMachinePhotos
} from './machines';
import { modelVisibleTo } from './catalog';
import { matchCandidate } from './photos/match';
import { parseCandidate } from './photos/analyze';
import { defaultMachineLabel } from '../catalog-labels';
import { workoutUi } from '../workout-ui';
import { sessionPhase } from '../workout-state';
import { lockSession } from './session-lock';
import { historyFilter, sessionIs } from './workout-state-sql';

/** Marks the per-user placeholder exercise, whatever its display name. */
export const PLACEHOLDER_MOVEMENT = 'unidentified-machine';

/**
 * The one rule for "this block is still waiting to be named from its photo"
 * (owner review P2, 2026-11-08): the block is on this user's placeholder
 * exercise AND a photo it opened is not discarded. The workout page's
 * `photoBlocks` (which hides Swap and Change machine), the server's refusals
 * (`isPhotoBlock` in bind and swap), Home's count and every naming path all
 * read it, so the page and the server cannot disagree.
 *
 * A placeholder block whose photo was discarded, or erased, is an ordinary
 * unnamed block: Swap, Change machine and Remove work on it under their own
 * rules, because there is no photo left to name it from.
 *
 * The query must join `exercises` on the block's exercise and
 * `equipment_photos` on `equipment_photos.session_exercise_id` = the block.
 */
export const waitingForPhotoName = (userId: string) =>
	and(
		eq(exercises.userId, userId),
		eq(exercises.canonicalMovement, PLACEHOLDER_MOVEMENT),
		eq(equipmentPhotos.userId, userId),
		ne(equipmentPhotos.status, 'discarded')
	);

/** True when this block is still waiting to be named from its photo (`waitingForPhotoName`). */
export async function isPhotoBlock(
	db: Database,
	userId: string,
	occurrenceId: string
): Promise<boolean> {
	const [row] = await db
		.select({ id: sessionExercises.id })
		.from(sessionExercises)
		.innerJoin(exercises, eq(exercises.id, sessionExercises.exerciseId))
		.innerJoin(equipmentPhotos, eq(equipmentPhotos.sessionExerciseId, sessionExercises.id))
		.where(and(eq(sessionExercises.id, occurrenceId), waitingForPhotoName(userId)))
		.limit(1);
	return !!row;
}

/** The machine `openPhotoBlock` made for a block, and the photos that prove it. */
export type PhotoPlaceholder = { machineId: string; photoIds: string[] };

/**
 * Positive evidence that the block's current machine is the placeholder the
 * app made for THIS block (owner review P2, 2026-11-08). `openPhotoBlock` (and
 * `undoPhotoIdentify`) record it on the photo: `equipment_photos.session_exercise_id`
 * = the block AND `equipment_photos.gym_equipment_id` = the machine it created,
 * in the same transaction. Evidence is a photo of this user with both links
 * (any status, discarded included), the block on this user's placeholder
 * exercise, and the machine still placeholder-shaped (this user's gym, no
 * model, the placeholder type, not archived or merged). The label is not
 * evidence: a user may name a machine "Photo Finish".
 *
 * Read it BEFORE the block changes: removing the block sets the photo's
 * `session_exercise_id` to null. No evidence (an erased photo, a photo from
 * before 0.10.x, a photo confirmed onto another machine) means null, and the
 * machine is kept.
 */
export async function photoPlaceholderOf(
	db: Database,
	userId: string,
	block: { id: string; exerciseId: string; gymEquipmentId: string | null }
): Promise<PhotoPlaceholder | null> {
	if (!block.gymEquipmentId) return null;
	const rows = await db
		.select({ photoId: equipmentPhotos.id })
		.from(equipmentPhotos)
		.innerJoin(gymEquipment, eq(gymEquipment.id, equipmentPhotos.gymEquipmentId))
		.innerJoin(gyms, eq(gyms.id, gymEquipment.gymId))
		.innerJoin(exercises, eq(exercises.id, block.exerciseId))
		.where(
			and(
				eq(equipmentPhotos.userId, userId),
				eq(equipmentPhotos.sessionExerciseId, block.id),
				eq(equipmentPhotos.gymEquipmentId, block.gymEquipmentId),
				eq(equipmentPhotos.gymId, gymEquipment.gymId),
				eq(gyms.userId, userId),
				isNull(gymEquipment.equipmentModelId),
				isNull(gymEquipment.archivedAt),
				isNull(gymEquipment.mergedIntoId),
				eq(gymEquipment.equipmentType, workoutUi.photoPlaceholderType),
				eq(exercises.userId, userId),
				eq(exercises.canonicalMovement, PLACEHOLDER_MOVEMENT)
			)
		);
	return rows.length
		? { machineId: block.gymEquipmentId, photoIds: rows.map((r) => r.photoId) }
		: null;
}

/**
 * SQLSTATEs a best-effort cleanup absorbs: a reference, a lock, a deadlock,
 * and 23514, the write fence: a fenced account's row, or (should the database
 * still run 0022's fence, before 0024) any UPDATE of a photo whose object is
 * `delete_pending`.
 */
const CLEANUP_CONTAINED = new Set(['23503', '55P03', '40P01', '23514']);
function sqlState(err: unknown): string | undefined {
	// Drizzle wraps the driver's PostgresError in DrizzleQueryError (`.cause`).
	for (let e = err; typeof e === 'object' && e !== null; e = (e as { cause?: unknown }).cause) {
		const code = (e as { code?: unknown }).code;
		if (typeof code === 'string') return code;
	}
	return undefined;
}

/**
 * After a block leaves its machine (swap, change machine, remove: possible
 * only once its photo is discarded, or erased), delete the placeholder that
 * `photoPlaceholderOf` proved was made for it, so no "Photo 14:32" row with
 * nothing on it is left in the gym list. Best-effort, never a reason for the
 * edit it follows to fail:
 *
 * - The machine is locked `FOR UPDATE SKIP LOCKED` before references are
 *   counted. Another transaction writing a reference holds `FOR KEY SHARE` on
 *   it (an attach also `FOR SHARE`, `lockMachineForUse`), so the lock is
 *   skipped and the machine kept: no wait, no 23503.
 * - The locked row is re-read and must still be `untouchedPhotoPlaceholder`:
 *   a placeholder the user has renamed, or given a stack, increment or model,
 *   is their machine now and is kept (owner review P2, 2026-11-08).
 * - Anything pointing at it other than the evidence photos (logged sets, a
 *   merge, another photo) keeps it, as history.
 * - The evidence photos are unlinked (`gym_equipment_id` to null) before the
 *   machine is deleted, since that FK is NO ACTION. A discarded photo's object
 *   is `delete_pending` until it is erased; since migration 0024 the write
 *   fence lets such a row lose its links (only `session_exercise_id` /
 *   `gym_equipment_id` going to null), so the placeholder goes right after
 *   Discard too. Any other change to a pending photo is still refused.
 * - It runs in a SAVEPOINT (a nested transaction). A reference, lock,
 *   deadlock or write-fence (23514: a fenced account, or a fence that refuses
 *   the unlink) error rolls back only the cleanup and keeps the machine; any
 *   other error is a programming error and is thrown.
 *
 * Returns true when the machine was deleted.
 */
export async function dropPhotoPlaceholderMachine(
	db: Database,
	userId: string,
	placeholder: PhotoPlaceholder | null,
	nowMachineId: string | null
): Promise<boolean> {
	if (!placeholder || placeholder.machineId === nowMachineId) return false;
	const { machineId, photoIds } = placeholder;
	try {
		return await db.transaction(async (sp) => {
			const [locked] = await sp
				.select()
				.from(gymEquipment)
				.where(
					and(
						eq(gymEquipment.id, machineId),
						inArray(
							gymEquipment.gymId,
							sp.select({ id: gyms.id }).from(gyms).where(eq(gyms.userId, userId))
						)
					)
				)
				.for('update', { skipLocked: true });
			// Re-read under the lock: a machine the user has edited since the app
			// made it (renamed, a stack or increment, a model) is theirs: kept.
			if (!locked || !untouchedPhotoPlaceholder(locked)) return false;
			if (await machineIsReferenced(sp, machineId, { ignoringPhotoIds: photoIds })) return false;
			await sp
				.update(equipmentPhotos)
				.set({ gymEquipmentId: null })
				.where(
					and(
						inArray(equipmentPhotos.id, photoIds),
						eq(equipmentPhotos.userId, userId),
						eq(equipmentPhotos.gymEquipmentId, machineId)
					)
				);
			await sp.delete(gymEquipment).where(eq(gymEquipment.id, machineId));
			return true;
		});
	} catch (err) {
		if (CLEANUP_CONTAINED.has(sqlState(err) ?? '')) return false;
		throw err;
	}
}

/**
 * Erasure's half of the placeholder cleanup. `erasePhotoObject` calls it in its
 * own transaction, right after it deletes the photo row (`photo` is that
 * deleted row), for a live account only. Since 0024 the swap-time cleanup
 * (`dropPhotoPlaceholderMachine`) unlinks a pending photo and deletes the
 * placeholder itself, so this is the backstop for a photo that still points at
 * a placeholder when it is erased because the swap-time cleanup kept it (the
 * machine was locked by another writer, or still referenced then).
 *
 * The rule: the photo is not `confirmed` (a confirmed photo names a real
 * machine, which is never deleted here), and it pointed at a machine in the
 * photo's gym, a gym of this user, that is still `untouchedPhotoPlaceholder`
 * on the locked row (a placeholder the user edited is kept). The machine is locked
 * `FOR UPDATE SKIP LOCKED` and deleted only when nothing points at it any more
 * (`machineIsReferenced`: no other photo, set, block or merge). A block still
 * on it keeps it, and a later swap then finds no evidence and keeps it too.
 *
 * It runs in a SAVEPOINT and absorbs EVERY error, not only the codes the
 * swap-time cleanup contains: by now the object is already erased from
 * storage, and a deterministic failure here would fail the erasure on every
 * retry and leave the photo row behind. Losing the cleanup only leaves an
 * empty machine the user can remove from the gym page.
 *
 * Returns true when the machine was deleted.
 */
export async function dropErasedPhotoPlaceholder(
	db: Database,
	userId: string,
	photo: {
		status: string;
		gymId: string;
		gymEquipmentId: string | null;
		matchedModelId: string | null;
		createdModelId: string | null;
	}
): Promise<boolean> {
	const machineId = photo.gymEquipmentId;
	// Not evidence: a confirmed photo, or one that was ever confirmed (a model was
	// matched or created from it; removal leaves those columns). requestPhotoDeletion
	// also drops a confirmed photo's link before it reads `discarded`.
	if (!machineId || photo.status === 'confirmed') return false;
	if (photo.matchedModelId || photo.createdModelId) return false;
	try {
		return await db.transaction(async (sp) => {
			const [locked] = await sp
				.select()
				.from(gymEquipment)
				.where(
					and(
						eq(gymEquipment.id, machineId),
						eq(gymEquipment.gymId, photo.gymId),
						inArray(
							gymEquipment.gymId,
							sp.select({ id: gyms.id }).from(gyms).where(eq(gyms.userId, userId))
						)
					)
				)
				.for('update', { skipLocked: true });
			// Re-read under the lock: an edited placeholder is the user's machine.
			if (!locked || !untouchedPhotoPlaceholder(locked)) return false;
			if (await machineIsReferenced(sp, machineId)) return false;
			await sp.delete(gymEquipment).where(eq(gymEquipment.id, machineId));
			return true;
		});
	} catch {
		return false;
	}
}

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
	typeof fromClient === 'string' && CLIENT_TIME.test(fromClient.trim())
		? fromClient.trim()
		: now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });

/** The phone's time as `photoTimeLabel` accepts it ("2:32 PM", "14:32"). */
const CLIENT_TIME = /^[0-9]{1,2}:[0-9]{2}( ?[AaPp][Mm])?$/;
/**
 * Every time `photoTimeLabel` can return: the phone's (CLIENT_TIME), or the
 * server's UTC fallback, which is the same shape except that some ICU builds
 * put U+202F (narrow no-break space) before AM/PM. Group 1 is the minute.
 */
const ANY_PHOTO_TIME = '[0-9]{1,2}:([0-9]{2})(?:[ \\u202F]?[AaPp][Mm])?';
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Exactly the labels `openPhotoBlock` (and `undoPhotoIdentify`) give a
 * placeholder machine: `workoutUi.photoMachineLabel(photoTimeLabel(...))`.
 * Built from `photoMachineLabel` itself, so a change to the label's wording
 * changes this too; `photo-placeholder-label.test.ts` checks it against the
 * function's own output. Used only by the one-time legacy cleanup
 * (`legacyPhotoPlaceholders`): the label is never evidence on its own for a
 * delete (see `photoPlaceholderOf`).
 */
export const photoMachineLabelPattern: RegExp = (() => {
	const slot = '\u0000';
	const [before, after] = workoutUi.photoMachineLabel(slot).split(slot);
	return new RegExp(`^${escapeRegExp(before)}${ANY_PHOTO_TIME}${escapeRegExp(after ?? '')}$`);
})();

/**
 * A placeholder machine nobody has touched since `openPhotoBlock` (or
 * `undoPhotoIdentify`) inserted it (owner review P2, 2026-11-08): every column
 * the user can edit still holds its insert value. The columns, from schema.ts
 * and the paths that write them:
 *
 * - `local_label` (the machine edit page, `updateMachine`): still exactly the
 *   generated "Photo <time>" (`photoMachineLabelPattern`). The time is the
 *   phone's and is not stored anywhere else, so the label cannot be compared
 *   to the one written at creation; any label of that exact format passes.
 * - `stack_lb`, `increment_lb` (`updateMachine`, `applyStandardStack`): null.
 * - `equipment_model_id`, `equipment_type` (`changeMachineModel`, naming):
 *   no model, the placeholder type.
 * - `archived_at`, `merged_into_id` (Remove, Merge): neither set.
 *
 * `gym_id` and `id` are never edited. Anything else, including a placeholder
 * renamed "West stack" or given a stack, is the user's machine now: the
 * cleanups (`dropPhotoPlaceholderMachine`, `dropErasedPhotoPlaceholder`) keep
 * it, and so does the legacy archive (`placeholderShaped` in machine-admin.ts).
 */
export function untouchedPhotoPlaceholder(m: typeof gymEquipment.$inferSelect): boolean {
	return (
		m.equipmentModelId === null &&
		m.equipmentType === workoutUi.photoPlaceholderType &&
		m.archivedAt === null &&
		m.mergedIntoId === null &&
		m.stackLb === null &&
		m.incrementLb === null &&
		photoMachineLabelPattern.test(m.localLabel)
	);
}

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
		const session = await lockSession(tx, userId, sessionId);
		if (!session || sessionPhase(session) === 'trashed')
			throw new MachineInputError('Session not found');
		if (sessionPhase(session) === 'ended') throw new MachineInputError('Session has ended');
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
		// Both links, in this transaction: the evidence `photoPlaceholderOf` reads
		// that this machine was made for this block. Thumbnails and lists read
		// only confirmed photos, so an open photo's machine link shows nowhere.
		await tx
			.update(equipmentPhotos)
			.set({ sessionExerciseId: occurrence.id, gymEquipmentId: machine.id })
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
	),
	/** A specific machine of that model in the gym (a repeat visit names the one used last). */
	gymEquipmentId: z.preprocess(
		(v) => (v === '' || v == null ? undefined : v),
		z.string().uuid().optional()
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
 * written. On an open workout, the sets not touched yet are prefilled from
 * that machine's history (0.6.1); a set with a saved value keeps its target.
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
		const session = await lockSession(tx, userId, sessionId);
		if (!session || sessionPhase(session) === 'trashed') return null;
		// Only a block still waiting for its photo: a discarded photo names nothing.
		const [block] = await tx
			.select({ occurrence: sessionExercises, exercise: exercises })
			.from(sessionExercises)
			.innerJoin(exercises, eq(exercises.id, sessionExercises.exerciseId))
			.innerJoin(equipmentPhotos, eq(equipmentPhotos.sessionExerciseId, sessionExercises.id))
			.where(
				and(
					eq(sessionExercises.id, occurrenceId),
					eq(sessionExercises.sessionId, sessionId),
					waitingForPhotoName(userId)
				)
			)
			.limit(1);
		if (!block) return null;
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
					ne(gymEquipment.id, placeholder.id),
					isNull(gymEquipment.archivedAt),
					value.gymEquipmentId ? eq(gymEquipment.id, value.gymEquipmentId) : undefined
				)
			)
			.orderBy(asc(gymEquipment.localLabel))
			.limit(1);
		if (value.gymEquipmentId && !existing) throw new MachineInputError('Machine not found');
		// Joining an existing machine attaches it to this block: under the
		// machine-use lock, re-checked (not archived or merged since the read).
		let machine = existing
			? (await lockMachineForUse(tx, userId, existing.id, { gymId: placeholder.gymId }))?.machine
			: undefined;
		if (existing && !machine) throw new MachineInputError('Machine not found');
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
			.where(
				and(
					eq(equipmentPhotos.sessionExerciseId, occurrenceId),
					ne(equipmentPhotos.status, 'discarded')
				)
			);

		if (machine.id !== placeholder.id) {
			// Merged: any other photo still on the placeholder moves too (one pending
			// removal is unlinked instead, which the 0024 fence allows), then the
			// placeholder goes once nothing at all points at it (another block or
			// set, a photo, a machine merge).
			await relinkMachinePhotos(
				tx,
				userId,
				eq(equipmentPhotos.gymEquipmentId, placeholder.id),
				machine.id
			);
			if (!(await machineIsReferenced(tx, placeholder.id)))
				await tx.delete(gymEquipment).where(eq(gymEquipment.id, placeholder.id));
		}

		// Last time's numbers into the sets not touched yet, on an open workout
		// (0.6.1). A set with a saved value or note keeps its prescription.
		if (sessionPhase(session) === 'open')
			await prefillOccurrence(tx, userId, updated, { onlyUntouched: true });
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
 * `uploaded` whose recorded read (`llm_call_id`) did not end `ok`: `failed`,
 * "Read again" or name it. Any other `uploaded`: `reading`, the read has not
 * finished (the page reads it once, right after the photo; on a later load it
 * offers "Read again"). `analyzed` with a preselected match: the "Use this"
 * card. Anything else: name it now or later.
 *
 * `analyzePhoto` records the call on an `uploaded` photo whether it succeeds
 * or fails, so a failed read survives a reload. A read that never ran (the
 * request was cut off before the model call) has no call and stays `reading`.
 */
export async function photoBlocksForSession(
	db: Database,
	userId: string,
	sessionId: string
): Promise<Record<string, PhotoBlockState>> {
	const rows = await db
		.select({
			photo: equipmentPhotos,
			occurrenceId: sessionExercises.id,
			readStatus: llmCalls.status
		})
		.from(equipmentPhotos)
		.innerJoin(sessionExercises, eq(sessionExercises.id, equipmentPhotos.sessionExerciseId))
		.innerJoin(exercises, eq(exercises.id, sessionExercises.exerciseId))
		// The read on record, owner-scoped like every llm_calls read.
		.leftJoin(
			llmCalls,
			and(eq(llmCalls.id, equipmentPhotos.llmCallId), eq(llmCalls.userId, userId))
		)
		.where(and(eq(sessionExercises.sessionId, sessionId), waitingForPhotoName(userId)))
		.orderBy(desc(equipmentPhotos.createdAt));
	const out: Record<string, PhotoBlockState> = {};
	for (const { photo, occurrenceId, readStatus } of rows) {
		if (out[occurrenceId]) continue;
		if (photo.status === 'uploaded') {
			const failed = readStatus != null && readStatus !== 'ok';
			out[occurrenceId] = { kind: failed ? 'failed' : 'reading', photoId: photo.id };
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
		.where(and(eq(sessions.userId, userId), sessionIs.notTrashed(), waitingForPhotoName(userId)))
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
				eq(sessions.userId, userId),
				sessionIs.notTrashed(),
				waitingForPhotoName(userId)
			)
		);
	return row ?? null;
}

/**
 * A repeat visit (0.6.1): after a read, name the block without asking when the
 * read's code is an exact match for a model this gym already has a machine
 * for, and the user has logged on that machine before. The name guard applies
 * (`matchCandidate`: a code whose model name disagrees with the name read is
 * not preselected). The block takes the exercise and weight format logged
 * there last, joins that machine, and its untouched sets get last time's
 * numbers. Undo (`undoPhotoIdentify`) puts it back.
 *
 * Returns the identified block, or null when this is not a repeat visit.
 */
export async function autoIdentifyRepeatVisit(
	db: Database,
	userId: string,
	sessionId: string,
	photoId: string
) {
	const [row] = await db
		.select({ photo: equipmentPhotos, occurrence: sessionExercises })
		.from(equipmentPhotos)
		.innerJoin(sessionExercises, eq(sessionExercises.id, equipmentPhotos.sessionExerciseId))
		.innerJoin(sessions, eq(sessions.id, sessionExercises.sessionId))
		.innerJoin(exercises, eq(exercises.id, sessionExercises.exerciseId))
		.where(
			and(
				eq(equipmentPhotos.id, photoId),
				eq(equipmentPhotos.status, 'analyzed'),
				eq(sessions.id, sessionId),
				eq(sessions.userId, userId),
				sessionIs.open(),
				waitingForPhotoName(userId)
			)
		);
	if (!row) return null;
	const candidate = parseCandidate(row.photo.candidate);
	if (!candidate) return null;
	const found = await matchCandidate(db, userId, candidate);
	if (found.method !== 'exact' || !found.preselectedId || found.nameDisagrees) return null;

	// The machine of that model in this gym logged on most recently, and what
	// was logged there: an ended, kept workout with an executed set.
	const [last] = await db
		.select({
			gymEquipmentId: sessionExercises.gymEquipmentId,
			exerciseName: sessionExercises.exerciseName,
			loadConvention: sessionExercises.loadConvention
		})
		.from(sessionExercises)
		.innerJoin(sessions, eq(sessions.id, sessionExercises.sessionId))
		.innerJoin(gymEquipment, eq(gymEquipment.id, sessionExercises.gymEquipmentId))
		.innerJoin(sets, eq(sets.sessionExerciseId, sessionExercises.id))
		.where(
			and(
				eq(sessions.userId, userId),
				historyFilter(),
				eq(gymEquipment.gymId, row.photo.gymId),
				eq(gymEquipment.equipmentModelId, found.preselectedId),
				isNull(gymEquipment.archivedAt)
			)
		)
		.orderBy(desc(sessions.startedAt))
		.limit(1);
	if (!last?.gymEquipmentId) return null;
	const done = await identifySessionExercise(db, userId, sessionId, row.occurrence.id, {
		modelId: found.preselectedId,
		exerciseName: last.exerciseName,
		loadConvention: last.loadConvention === 'legacy' ? undefined : last.loadConvention,
		gymEquipmentId: last.gymEquipmentId
	});
	return done?.occurrence ?? null;
}

/**
 * Undo a photo block's naming (0.6.1), on an open workout: the block goes back
 * to the placeholder exercise on a new placeholder machine, its photo back to
 * `analyzed` (so the card offers the match again), and its untouched sets lose
 * the prefill. Saved values and notes are never touched. No machine is
 * deleted: the one it was named to may be one the user made themselves.
 *
 * Returns null when the block is not this user's photo-named block on an open
 * workout.
 */
export async function undoPhotoIdentify(
	db: Database,
	userId: string,
	sessionId: string,
	occurrenceId: string,
	opts: { timeLabel?: string } = {}
) {
	z.string().uuid().parse(sessionId);
	z.string().uuid().parse(occurrenceId);
	return db.transaction(async (tx) => {
		const session = await lockSession(tx, userId, sessionId);
		if (!session || sessionPhase(session) !== 'open') return null;
		const [block] = await tx
			.select({ occurrence: sessionExercises, photo: equipmentPhotos })
			.from(sessionExercises)
			.innerJoin(exercises, eq(exercises.id, sessionExercises.exerciseId))
			.innerJoin(equipmentPhotos, eq(equipmentPhotos.sessionExerciseId, sessionExercises.id))
			.where(
				and(
					eq(sessionExercises.id, occurrenceId),
					eq(sessionExercises.sessionId, sessionId),
					eq(exercises.userId, userId),
					sql`${exercises.canonicalMovement} IS DISTINCT FROM ${PLACEHOLDER_MOVEMENT}`,
					eq(equipmentPhotos.userId, userId),
					eq(equipmentPhotos.status, 'confirmed')
				)
			)
			.limit(1);
		if (!block) return null;
		const exercise = await ensurePlaceholderExercise(tx, userId);
		const machine = await createMachine(tx, userId, {
			gymId: block.photo.gymId,
			localLabel: workoutUi.photoMachineLabel(photoTimeLabel(opts.timeLabel)),
			equipmentType: exercise.equipmentType
		});
		const [gym] = await tx.select().from(gyms).where(eq(gyms.id, block.photo.gymId));
		const [reverted] = await tx
			.update(sessionExercises)
			.set({
				exerciseId: exercise.id,
				exerciseName: exercise.name,
				gymEquipmentId: machine.id,
				machineLabel: machine.localLabel,
				gymName: gym?.name ?? block.occurrence.gymName,
				modelName: null,
				equipmentType: exercise.equipmentType,
				loadConvention: 'unknown'
			})
			.where(eq(sessionExercises.id, occurrenceId))
			.returning();
		await tx
			.update(sets)
			.set({ exerciseId: exercise.id, gymEquipmentId: machine.id, loadConvention: 'unknown' })
			.where(eq(sets.sessionExerciseId, occurrenceId));
		await tx
			.update(equipmentPhotos)
			.set({
				status: parseCandidate(block.photo.candidate) ? 'analyzed' : 'uploaded',
				matchedModelId: null,
				// The new placeholder, as openPhotoBlock records it (photoPlaceholderOf).
				gymEquipmentId: machine.id
			})
			.where(eq(equipmentPhotos.sessionExerciseId, occurrenceId));
		// The new placeholder has no history: untouched sets go back to blank.
		await prefillOccurrence(tx, userId, reverted, { onlyUntouched: true });
		return reverted;
	});
}

/** Photo-named blocks of this session, by block id, for the Undo line (0.6.1). */
export async function namedPhotoBlocks(
	db: Database,
	userId: string,
	sessionId: string
): Promise<Record<string, { photoId: string; modelLabel: string }>> {
	const rows = await db
		.select({
			occurrenceId: sessionExercises.id,
			photoId: equipmentPhotos.id,
			model: equipmentModels
		})
		.from(equipmentPhotos)
		.innerJoin(sessionExercises, eq(sessionExercises.id, equipmentPhotos.sessionExerciseId))
		.innerJoin(sessions, eq(sessions.id, sessionExercises.sessionId))
		.innerJoin(equipmentModels, eq(equipmentModels.id, equipmentPhotos.matchedModelId))
		.where(
			and(
				eq(equipmentPhotos.userId, userId),
				eq(equipmentPhotos.status, 'confirmed'),
				eq(sessions.id, sessionId),
				eq(sessions.userId, userId)
			)
		);
	return Object.fromEntries(
		rows.map((r) => [
			r.occurrenceId,
			{ photoId: r.photoId, modelLabel: defaultMachineLabel(r.model) }
		])
	);
}
