/**
 * Drizzle schema for the Lift Log app (planning v2.2).
 *
 * Place at: src/lib/server/db/schema.ts
 *
 * Maps to planning_v2_1.md §Schema with v2.2 patches applied:
 *   - `sets.prescribedRepsMin` / `prescribedRepsMax` (range, not singular)
 *   - `pain_events` parent-required CHECK
 *
 * After editing this file:
 *   pnpm drizzle-kit generate    # writes SQL migration to ./drizzle/
 *   pnpm drizzle-kit migrate     # applies to dev DB
 *
 * Notes on Drizzle quirks:
 *   - `numeric` columns use `mode: 'number'` so JS gets numbers back, not strings.
 *     JS-number precision is safe for load weights bounded under 1000 lb.
 *   - Self-FK (`sourceProgramId` → `programs.id`) needs `(): any` workaround for
 *     TypeScript's circular reference issue with self-referencing tables.
 *   - All FK columns get explicit indexes. Drizzle and Postgres do NOT
 *     auto-index FK columns.
 *
 * If a Drizzle API call below doesn't compile against your installed version,
 * the names may have shifted (`check`, `unique`, index syntax). The semantics
 * here are what's locked; the exact incantation may need adjustment.
 */

import { sql } from 'drizzle-orm';
import {
	boolean,
	check,
	date,
	index,
	integer,
	jsonb,
	numeric,
	pgTable,
	text,
	timestamp,
	unique,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';
import type { ImportedLine } from '$lib/imported-workout';

// Historical source records are separate from progression inputs so unknown
// dates and estimates need not masquerade as measured performance.
export const workoutLogImports = pgTable('workout_log_imports', {
	id: uuid('id').primaryKey(),
	sourceSha256: text('source_sha256').notNull().unique(),
	sourceName: text('source_name').notNull(),
	sourceText: text('source_text').notNull(),
	importedAt: timestamp('imported_at').notNull().defaultNow()
});
export const importedWorkouts = pgTable(
	'imported_workouts',
	{
		id: uuid('id').primaryKey(),
		importId: uuid('import_id')
			.notNull()
			.references(() => workoutLogImports.id, { onDelete: 'cascade' }),
		sourceLine: integer('source_line').notNull(),
		workoutDate: date('workout_date'),
		earliestDate: date('earliest_date'),
		latestDate: date('latest_date'),
		title: text('title').notNull(),
		gym: text('gym'),
		dateNote: text('date_note').notNull(),
		lines: jsonb('lines').$type<ImportedLine[]>().notNull()
	},
	(t) => ({
		importIdx: index('imported_workouts_import_idx').on(t.importId),
		dateIdx: index('imported_workouts_date_idx').on(t.workoutDate),
		sourceUnique: unique('imported_workouts_source_unique').on(t.importId, t.sourceLine),
		dateRange: check(
			'imported_workouts_date_range',
			sql`${t.earliestDate} IS NULL OR ${t.latestDate} IS NULL OR ${t.earliestDate} <= ${t.latestDate}`
		)
	})
);

// ---------- programs ----------

export const programs = pgTable(
	'programs',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		name: text('name').notNull(),
		description: text('description'),
		isActive: boolean('is_active').notNull().default(true),
		// Self-FK for lineage tracking (planning §4). The `(): any` is a known
		// Drizzle workaround for TypeScript's circular self-reference issue.
		sourceProgramId: uuid('source_program_id').references((): any => programs.id, {
			onDelete: 'set null'
		}),
		createdAt: timestamp('created_at').notNull().defaultNow(),
		updatedAt: timestamp('updated_at').notNull().defaultNow()
	},
	(t) => ({
		sourceProgramIdIdx: index('programs_source_program_id_idx').on(t.sourceProgramId)
	})
);

// Durable idempotency receipt, committed atomically with the complete draft tree.
export const programDraftRequests = pgTable(
	'program_draft_requests',
	{
		requestId: uuid('request_id').primaryKey(),
		fingerprint: text('fingerprint').notNull(),
		programId: uuid('program_id')
			.notNull()
			.references(() => programs.id),
		createdAt: timestamp('created_at').notNull().defaultNow()
	},
	(t) => ({
		programIdx: index('program_draft_requests_program_idx').on(t.programId),
		fingerprintCheck: check(
			'program_draft_requests_fingerprint_check',
			sql`${t.fingerprint} ~ '^[0-9a-f]{64}$'`
		)
	})
);

// ---------- days ----------

export const days = pgTable(
	'days',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		programId: uuid('program_id')
			.notNull()
			.references(() => programs.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		position: integer('position').notNull(),
		// Days with the same alternateGroupId form an alternation set
		// (e.g. Day 3A and Day 3B both have alternateGroupId='legs').
		alternateGroupId: text('alternate_group_id'),
		notes: text('notes')
	},
	(t) => ({
		uniqueProgramPosition: unique('days_program_position_unique').on(t.programId, t.position),
		programIdIdx: index('days_program_id_idx').on(t.programId),
		positionNonNeg: check('days_position_non_neg_check', sql`${t.position} >= 1`)
	})
);

// ---------- exercises (master list) ----------

export const exercises = pgTable(
	'exercises',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		name: text('name').notNull().unique(),
		canonicalMovement: text('canonical_movement'),
		// NOT NULL since v3 — `snapForEquipment(load, null)` silently returns
		// pass-through, so a NULL here would print wrong-by-bar-weight loads on
		// what was supposed to be a barbell exercise. Failing fast at INSERT
		// beats silent-wrong at the gym.
		//
		// Known values (CHECK below): 'barbell', 'barbell-ez', 'machine-plate',
		// 'machine-stack', 'cable', 'dumbbell', 'smith', 'bodyweight', 'band'.
		equipmentType: text('equipment_type').notNull(),
		// Progression increment source of truth (N3): false=+5, true=+10.
		// Avoids brittle name-regex classification in runtime prefill logic.
		isLowerBody: boolean('is_lower_body').notNull().default(false),
		notes: text('notes')
	},
	(t) => ({
		equipmentTypeCheck: check(
			'exercises_equipment_type_check',
			sql`${t.equipmentType} IN (
      'barbell', 'barbell-ez', 'machine-plate', 'machine-stack',
      'cable', 'dumbbell', 'smith', 'bodyweight', 'band'
    )`
		)
	})
);

// User-entered discovery metadata, not verified catalog claims.
export const equipmentModels = pgTable(
	'equipment_models',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		manufacturer: text('manufacturer').notNull(),
		productLine: text('product_line'),
		name: text('name').notNull(),
		code: text('code'),
		startingResistance: numeric('starting_resistance', { precision: 6, scale: 2, mode: 'number' }),
		loadingType: text('loading_type').notNull(),
		laterality: text('laterality').notNull().default('unknown')
	},
	(t) => ({
		resistanceCheck: check(
			'model_resistance_check',
			sql`${t.startingResistance} IS NULL OR ${t.startingResistance} >= 0`
		)
	})
);

export const exerciseEquipmentMap = pgTable(
	'exercise_equipment_map',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		exerciseId: uuid('exercise_id')
			.notNull()
			.references(() => exercises.id),
		equipmentModelId: uuid('equipment_model_id')
			.notNull()
			.references(() => equipmentModels.id)
	},
	(t) => ({
		pair: unique('exercise_equipment_map_pair').on(t.exerciseId, t.equipmentModelId),
		exerciseIdx: index('exercise_equipment_map_exercise_idx').on(t.exerciseId),
		modelIdx: index('exercise_equipment_map_model_idx').on(t.equipmentModelId)
	})
);

export const gyms = pgTable('gyms', {
	id: uuid('id').defaultRandom().primaryKey(),
	name: text('name').notNull()
});

export const gymEquipment = pgTable(
	'gym_equipment',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		gymId: uuid('gym_id')
			.notNull()
			.references(() => gyms.id),
		equipmentModelId: uuid('equipment_model_id').references(() => equipmentModels.id),
		localLabel: text('local_label').notNull(),
		equipmentType: text('equipment_type').notNull()
	},
	(t) => ({
		gymIdx: index('gym_equipment_gym_idx').on(t.gymId),
		modelIdx: index('gym_equipment_model_idx').on(t.equipmentModelId)
	})
);

// ---------- day_exercises ----------

export const dayExercises = pgTable(
	'day_exercises',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		dayId: uuid('day_id')
			.notNull()
			.references(() => days.id, { onDelete: 'cascade' }),
		exerciseId: uuid('exercise_id')
			.notNull()
			.references(() => exercises.id),
		position: integer('position').notNull(),
		tier: text('tier', { enum: ['main', 'secondary', 'isolation'] }).notNull(),
		progressionPolicy: text('progression_policy', {
			enum: ['standard', 'cautious', 'hold']
		})
			.notNull()
			.default('standard'),
		notes: text('notes')
	},
	(t) => ({
		uniqueDayPosition: unique('day_exercises_day_position_unique').on(t.dayId, t.position),
		dayIdIdx: index('day_exercises_day_id_idx').on(t.dayId),
		exerciseIdIdx: index('day_exercises_exercise_id_idx').on(t.exerciseId),
		positionNonNeg: check('day_exercises_position_non_neg_check', sql`${t.position} >= 1`)
	})
);

// ---------- prescribed_sets (structural template + cold-start + rest) ----------

export const prescribedSets = pgTable(
	'prescribed_sets',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		dayExerciseId: uuid('day_exercise_id')
			.notNull()
			.references(() => dayExercises.id, { onDelete: 'cascade' }),
		position: integer('position').notNull(),
		setRole: text('set_role', {
			enum: ['warmup', 'working', 'top', 'backoff']
		}).notNull(),
		targetMetric: text('target_metric', { enum: ['reps', 'seconds'] })
			.notNull()
			.default('reps'),
		targetRepsMin: integer('target_reps_min'),
		targetRepsMax: integer('target_reps_max'),
		targetRir: integer('target_rir'),
		initialLoad: numeric('initial_load', {
			precision: 6,
			scale: 2,
			mode: 'number'
		}),
		restSecondsMin: integer('rest_seconds_min'),
		restSecondsMax: integer('rest_seconds_max'),
		notes: text('notes')
	},
	(t) => ({
		uniqueDayExercisePosition: unique('prescribed_sets_day_exercise_position_unique').on(
			t.dayExerciseId,
			t.position
		),
		dayExerciseIdIdx: index('prescribed_sets_day_exercise_id_idx').on(t.dayExerciseId),
		repsRangeCheck: check(
			'prescribed_sets_reps_range_check',
			sql`${t.targetRepsMin} IS NULL OR ${t.targetRepsMax} IS NULL
          OR ${t.targetRepsMin} <= ${t.targetRepsMax}`
		),
		rirRangeCheck: check(
			'prescribed_sets_rir_range_check',
			sql`${t.targetRir} IS NULL
          OR (${t.targetRir} >= 0 AND ${t.targetRir} <= 10)`
		),
		repsMinNonNeg: check(
			'prescribed_sets_reps_min_non_negative',
			sql`${t.targetRepsMin} IS NULL OR ${t.targetRepsMin} >= 0`
		),
		repsMaxNonNeg: check(
			'prescribed_sets_reps_max_non_negative',
			sql`${t.targetRepsMax} IS NULL OR ${t.targetRepsMax} >= 0`
		),
		initialLoadNonNeg: check(
			'prescribed_sets_initial_load_non_negative',
			sql`${t.initialLoad} IS NULL OR ${t.initialLoad} >= 0`
		),
		restMinNonNeg: check(
			'prescribed_sets_rest_min_non_negative',
			sql`${t.restSecondsMin} IS NULL OR ${t.restSecondsMin} >= 0`
		),
		restMaxNonNeg: check(
			'prescribed_sets_rest_max_non_negative',
			sql`${t.restSecondsMax} IS NULL OR ${t.restSecondsMax} >= 0`
		),
		restRangeCheck: check(
			'prescribed_sets_rest_range_check',
			sql`${t.restSecondsMin} IS NULL OR ${t.restSecondsMax} IS NULL
          OR ${t.restSecondsMin} <= ${t.restSecondsMax}`
		),
		positionNonNeg: check('prescribed_sets_position_non_neg_check', sql`${t.position} >= 1`)
	})
);

// ---------- sessions ----------

export const sessions = pgTable(
	'sessions',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		dayId: uuid('day_id')
			.notNull()
			.references(() => days.id),
		// Denormalized from `dayId → days.programId` for query convenience
		// (history queries filter by programId without joining days).
		//
		// INVARIANT (application-enforced): session.programId MUST equal
		// days.programId for the row referenced by session.dayId. The DB
		// cannot enforce this without a trigger or composite FK. The
		// session-start server action MUST compute programId by looking up
		// the day row, never from a client-supplied form value. See CLAUDE.md
		// schema discipline rules.
		programId: uuid('program_id')
			.notNull()
			.references(() => programs.id),
		startedAt: timestamp('started_at').notNull().defaultNow(),
		endedAt: timestamp('ended_at'),
		deletedAt: timestamp('deleted_at'),
		notes: text('notes')
	},
	(t) => ({
		dayStartedAtIdx: index('sessions_day_started_at_idx').on(t.dayId, t.startedAt.desc()),
		programIdIdx: index('sessions_program_id_idx').on(t.programId),
		// At most one open session per day. Partial unique index — closes the
		// double-submit race in `startSessionForDay` (the app-layer check there
		// covers the common case; this catches true concurrent inserts).
		oneOpenPerDay: uniqueIndex('sessions_one_open_per_day')
			.on(t.dayId)
			.where(sql`ended_at IS NULL AND deleted_at IS NULL`),
		// History append-only invariant: a session can never have ended before
		// it started. Clock skew on a multi-device write or a bad UPDATE would
		// otherwise let bad rows in silently.
		endedAfterStartedCheck: check(
			'sessions_ended_after_started_check',
			sql`${t.endedAt} IS NULL OR ${t.endedAt} >= ${t.startedAt}`
		)
	})
);

// Session-local exercise occurrence. Quick-add never mutates a template.
export const sessionExercises = pgTable(
	'session_exercises',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		sessionId: uuid('session_id')
			.notNull()
			.references(() => sessions.id, { onDelete: 'cascade' }),
		exerciseId: uuid('exercise_id')
			.notNull()
			.references(() => exercises.id),
		gymEquipmentId: uuid('gym_equipment_id').references(() => gymEquipment.id),
		position: integer('position').notNull(),
		exerciseName: text('exercise_name').notNull(),
		machineLabel: text('machine_label'),
		gymName: text('gym_name'),
		modelName: text('model_name'),
		equipmentType: text('equipment_type').notNull(),
		loadConvention: text('load_convention', {
			enum: ['legacy', 'unknown', 'plates_per_side', 'total_plates', 'per_arm', 'displayed']
		})
			.notNull()
			.default('legacy'),
		tier: text('tier', { enum: ['main', 'secondary', 'isolation'] }).notNull(),
		progressionPolicy: text('progression_policy', {
			enum: ['standard', 'cautious', 'hold']
		}).notNull()
	},
	(t) => ({
		sessionIdx: index('session_exercises_session_idx').on(t.sessionId),
		exerciseIdx: index('session_exercises_exercise_idx').on(t.exerciseId),
		machineIdx: index('session_exercises_machine_idx').on(t.gymEquipmentId),
		positionUnique: unique('session_exercises_position_unique').on(t.sessionId, t.position)
	})
);

// ---------- sets (Option A: prescribed range + executed in one row, snapshotted) ----------

export const sets = pgTable(
	'sets',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		sessionId: uuid('session_id')
			.notNull()
			.references(() => sessions.id, { onDelete: 'cascade' }),
		exerciseId: uuid('exercise_id')
			.notNull()
			.references(() => exercises.id),
		sessionExerciseId: uuid('session_exercise_id').references(() => sessionExercises.id),
		gymEquipmentId: uuid('gym_equipment_id').references(() => gymEquipment.id),
		loadConvention: text('load_convention', {
			enum: ['legacy', 'unknown', 'plates_per_side', 'total_plates', 'per_arm', 'displayed']
		})
			.notNull()
			.default('legacy'),
		prescribedSetId: uuid('prescribed_set_id').references(() => prescribedSets.id, {
			onDelete: 'set null'
		}),
		position: integer('position').notNull(),
		setRole: text('set_role', {
			enum: ['warmup', 'working', 'top', 'backoff']
		}).notNull(),
		targetMetric: text('target_metric', { enum: ['reps', 'seconds'] })
			.notNull()
			.default('reps'),

		// Prescribed values: snapshotted from the template at session-start time
		// (per planning §1 snapshot semantics). Range, not single value (v2.2 fix).
		prescribedLoad: numeric('prescribed_load', {
			precision: 6,
			scale: 2,
			mode: 'number'
		}),
		// Snapshot of engine rationale at session-start. Nullable for warmup and
		// cold-start rows that bypass progression.
		suggestionReasoning: text('suggestion_reasoning'),
		prescribedRepsMin: integer('prescribed_reps_min'),
		prescribedRepsMax: integer('prescribed_reps_max'),
		prescribedRir: integer('prescribed_rir'),

		// Executed values: filled in by the user during/after the set.
		executedLoad: numeric('executed_load', {
			precision: 6,
			scale: 2,
			mode: 'number'
		}),
		executedReps: integer('executed_reps'),
		executedRir: integer('executed_rir'),

		wasAudible: boolean('was_audible').notNull().default(false),
		notes: text('notes'),
		loggedAt: timestamp('logged_at').notNull().defaultNow()
	},
	(t) => ({
		sessionIdIdx: index('sets_session_id_idx').on(t.sessionId),
		occurrenceIdx: index('sets_session_exercise_idx').on(t.sessionExerciseId),
		machineIdx: index('sets_machine_idx').on(t.gymEquipmentId),
		identityIdx: index('sets_identity_idx').on(
			t.exerciseId,
			t.gymEquipmentId,
			t.loadConvention,
			t.setRole,
			t.position,
			t.loggedAt
		),
		conventionCheck: check(
			'sets_convention_check',
			sql`${t.loadConvention} IN ('legacy', 'unknown', 'plates_per_side', 'total_plates', 'per_arm', 'displayed')`
		),
		machineConventionCheck: check(
			'sets_machine_convention_check',
			sql`${t.gymEquipmentId} IS NULL OR ${t.loadConvention} <> 'legacy'`
		),
		prescribedSetIdIdx: index('sets_prescribed_set_id_idx').on(t.prescribedSetId),
		// Composite for the prefill query (planning §11). Ordering:
		//   exercise_id, set_role, position, logged_at DESC.
		prefillIdx: index('sets_prefill_idx').on(
			t.exerciseId,
			t.setRole,
			t.position,
			t.loggedAt.desc()
		),
		repsCheck: check('sets_reps_check', sql`${t.executedReps} IS NULL OR ${t.executedReps} >= 0`),
		loadCheck: check('sets_load_check', sql`${t.executedLoad} IS NULL OR ${t.executedLoad} >= 0`),
		rirCheck: check(
			'sets_rir_check',
			sql`${t.executedRir} IS NULL
          OR (${t.executedRir} >= 0 AND ${t.executedRir} <= 10)`
		),
		prescribedRepsRangeCheck: check(
			'sets_prescribed_reps_range_check',
			sql`${t.prescribedRepsMin} IS NULL OR ${t.prescribedRepsMax} IS NULL
          OR ${t.prescribedRepsMin} <= ${t.prescribedRepsMax}`
		),
		prescribedRepsMinNonNeg: check(
			'sets_prescribed_reps_min_non_negative',
			sql`${t.prescribedRepsMin} IS NULL OR ${t.prescribedRepsMin} >= 0`
		),
		prescribedRepsMaxNonNeg: check(
			'sets_prescribed_reps_max_non_negative',
			sql`${t.prescribedRepsMax} IS NULL OR ${t.prescribedRepsMax} >= 0`
		),
		prescribedLoadNonNeg: check(
			'sets_prescribed_load_non_negative',
			sql`${t.prescribedLoad} IS NULL OR ${t.prescribedLoad} >= 0`
		),
		prescribedRirCheck: check(
			'sets_prescribed_rir_check',
			sql`${t.prescribedRir} IS NULL
          OR (${t.prescribedRir} >= 0 AND ${t.prescribedRir} <= 10)`
		),
		positionNonNeg: check('sets_position_non_neg_check', sql`${t.position} >= 1`)
	})
);

// ---------- pain_events ----------

export const painEvents = pgTable(
	'pain_events',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		// All three FKs nullable. CHECK below requires at least one non-null
		// (no orphan pain entries with only location/severity).
		sessionId: uuid('session_id').references(() => sessions.id, {
			onDelete: 'cascade'
		}),
		setId: uuid('set_id').references(() => sets.id, { onDelete: 'set null' }),
		exerciseId: uuid('exercise_id').references(() => exercises.id),
		location: text('location').notNull(), // free text MVP; promote to enum later
		severity: integer('severity').notNull(), // 1-10
		trigger: text('trigger'),
		notes: text('notes'),
		occurredAt: timestamp('occurred_at').notNull().defaultNow()
	},
	(t) => ({
		exerciseOccurredIdx: index('pain_events_exercise_occurred_idx').on(
			t.exerciseId,
			t.occurredAt.desc()
		),
		locationOccurredIdx: index('pain_events_location_occurred_idx').on(
			t.location,
			t.occurredAt.desc()
		),
		sessionIdIdx: index('pain_events_session_id_idx').on(t.sessionId),
		setIdIdx: index('pain_events_set_id_idx').on(t.setId),
		severityCheck: check(
			'pain_events_severity_check',
			sql`${t.severity} >= 1 AND ${t.severity} <= 10`
		),
		parentRequiredCheck: check(
			'pain_events_parent_required_check',
			sql`${t.sessionId} IS NOT NULL
          OR ${t.setId} IS NOT NULL
          OR ${t.exerciseId} IS NOT NULL`
		)
	})
);

// ---------- Type exports for application use ----------

export type Program = typeof programs.$inferSelect;
export type NewProgram = typeof programs.$inferInsert;
export type Day = typeof days.$inferSelect;
export type Exercise = typeof exercises.$inferSelect;
export type DayExercise = typeof dayExercises.$inferSelect;
export type PrescribedSet = typeof prescribedSets.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type Set = typeof sets.$inferSelect;
export type NewSet = typeof sets.$inferInsert;
export type PainEvent = typeof painEvents.$inferSelect;
export type NewPainEvent = typeof painEvents.$inferInsert;
