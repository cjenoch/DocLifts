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
	foreignKey,
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

// Better Auth's four tables live in the `auth` Postgres schema (see
// auth-schema.ts). Re-exported HERE, not from db/index.ts, because
// drizzle.config.ts points `schema:` at this one file — drizzle-kit does not
// follow db/index.ts, so without this the generate step would see no auth
// tables and emit an empty migration.
import { authUsers } from './auth-schema';

export {
	authSchema,
	authUsers,
	authSessions,
	authAccounts,
	authVerifications,
	authTables
} from './auth-schema';

// Historical source records are separate from progression inputs so unknown
// dates and estimates need not masquerade as measured performance.
export const workoutLogImports = pgTable(
	'workout_log_imports',
	{
		id: uuid('id').primaryKey(),
		/**
		 * D5: was globally UNIQUE. Two users importing the same source file
		 * would collide, so uniqueness is now per-owner. Re-importing your
		 * own file is still blocked — that is what the sha256 is for.
		 */
		sourceSha256: text('source_sha256').notNull(),
		sourceName: text('source_name').notNull(),
		sourceText: text('source_text').notNull(),
		importedAt: timestamp('imported_at').notNull().defaultNow(),
		/** Owner. `text` not `uuid` — see programs.userId. No onDelete: NO ACTION. */
		userId: text('user_id')
			.notNull()
			.references(() => authUsers.id)
	},
	(t) => ({
		userSourceSha256Unique: unique('workout_log_imports_user_sha256_unique').on(
			t.userId,
			t.sourceSha256
		),
		userIdIdx: index('workout_log_imports_user_id_idx').on(t.userId)
	})
);
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
		updatedAt: timestamp('updated_at').notNull().defaultNow(),
		/**
		 * Owner account, `auth.user.id`.
		 *
		 * `text`, NOT `uuid`, and this is the reference case for the other
		 * eight. Better Auth generates the id itself — 32-char alphanumeric
		 * (crypto-safe random, @better-auth/core/dist/utils/id.mjs) — and
		 * stores it in a `text` column. The adapter sets `supportsUUIDs: true`
		 * for pg, but that only says a `generateId: 'uuid'` opt-in is
		 * *permitted*; the default generator still returns a non-UUID string.
		 * Declaring this `uuid()` would compile and then fail at runtime on
		 * every join.
		 *
		 * Deliberately NO `onDelete`. Work order §3 rule 1: deleting an
		 * account must never silently delete workout history, so the FK
		 * defaults to NO ACTION and account deletion fails until history is
		 * handled explicitly. (Contrast Better Auth's own auth.* FKs, which
		 * do cascade — correct for auth rows, wrong for these.)
		 */
		userId: text('user_id')
			.notNull()
			.references(() => authUsers.id),
		/**
		 * NULL for every program a user builds. `'quick'` marks the one hidden
		 * system program behind "Start workout" (0.5.1, migration 0017): one
		 * day, no prescriptions, created on first use by `ensureQuickProgram`.
		 * A system program never appears on Home, in the program list, or in
		 * any edit, deactivate or delete control; History and Reports include
		 * its sessions, labelled from `src/lib/workout-ui.ts`.
		 */
		systemKind: text('system_kind')
	},
	(t) => ({
		sourceProgramIdIdx: index('programs_source_program_id_idx').on(t.sourceProgramId),
		userIdIdx: index('programs_user_id_idx').on(t.userId),
		systemKindCheck: check(
			'programs_system_kind_check',
			sql`${t.systemKind} IS NULL OR ${t.systemKind} = 'quick'`
		),
		// One quick program per user. ensureQuickProgram is idempotent through
		// this index (INSERT ... ON CONFLICT DO NOTHING), including under two
		// concurrent first taps.
		oneQuickPerUser: uniqueIndex('programs_one_quick_per_user')
			.on(t.userId)
			.where(sql`system_kind = 'quick'`)
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
		createdAt: timestamp('created_at').notNull().defaultNow(),
		/**
		 * Owner. `text` not `uuid` — see the note on programs.userId.
		 * No onDelete: NO ACTION, so deleting an account cannot silently
		 * delete workout history.
		 */
		userId: text('user_id')
			.notNull()
			.references(() => authUsers.id)
	},
	(t) => ({
		programIdx: index('program_draft_requests_program_idx').on(t.programId),
		userIdIdx: index('program_draft_requests_user_id_idx').on(t.userId),
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
		name: text('name').notNull(),
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
		notes: text('notes'),
		/**
		 * Owner. Exercises are PER-USER as of the accounts migration (D4):
		 * two users may each have their own "Bench Press" row, and each row's
		 * notes/isLowerBody/targets are theirs alone. `text` not `uuid` — see
		 * programs.userId. No onDelete: NO ACTION.
		 */
		userId: text('user_id')
			.notNull()
			.references(() => authUsers.id),
		/** One of the eight body regions (0.7.0, machines spec Part J); null = "Other". */
		bodyRegion: text('body_region'),
		/** Hidden from the picker, kept in history (0.7.0, Part J). */
		archivedAt: timestamp('archived_at', { withTimezone: true })
	},
	(t) => ({
		bodyRegionCheck: check(
			'exercises_body_region_check',
			sql`${t.bodyRegion} IS NULL OR ${t.bodyRegion} IN ('legs', 'back', 'chest', 'arms', 'shoulders', 'glutes', 'core', 'full body')`
		),
		/**
		 * D4: was a GLOBAL unique on `name` alone. Replaced by per-user.
		 *
		 * This is why two call sites had to change with the migration, not
		 * just the schema — see the T3 acceptance criteria in the accounts
		 * work order:
		 *   - program-builder.ts quick-add: `onConflictDoNothing({ target:
		 *     exercises.name })` raises at runtime under a compound index, and
		 *     its fallback `select` had no user predicate and could return
		 *     another user's row.
		 *   - machines.ts addSessionExercise: rejects on a global name match,
		 *     which would refuse user B a name user A already has.
		 *
		 * The global `UNIQUE(name)` itself is dropped by
		 * 0010_drop_exercise_name_unique, which could not land earlier
		 * because program-builder.ts was its last remaining caller.
		 */
		userNameUnique: unique('exercises_user_id_name_unique').on(t.userId, t.name),
		userIdIdx: index('exercises_user_id_idx').on(t.userId),
		equipmentTypeCheck: check(
			'exercises_equipment_type_check',
			sql`${t.equipmentType} IN (
      'barbell', 'barbell-ez', 'machine-plate', 'machine-stack',
      'cable', 'dumbbell', 'smith', 'bodyweight', 'band'
    )`
		)
	})
);

/**
 * Machine models. Two kinds of row share this table, told apart by
 * `owner_user_id`:
 *
 *   - GLOBAL (owner_user_id IS NULL): read-only catalog data, written only by
 *     `pnpm catalog:import` from a dated manufacturer snapshot
 *     (data/catalog/). Every user reads them; no app path writes them.
 *   - OWNED (owner_user_id = a user): user data — a model a user typed in, or
 *     their own corrected copy of a catalog row. Visible to that user only.
 *
 * Reads are `owner_user_id IS NULL OR owner_user_id = userId`. Writes only
 * ever target owned rows. See CLAUDE.md "Every row is owned" and
 * docs/catalog.md.
 */
export const CONFIDENCE_VALUES = [
	'manufacturer_page',
	'reseller_or_manual',
	'inferred',
	'line_only',
	'user'
] as const;
export const BODY_REGIONS = [
	'chest',
	'back',
	'shoulders',
	'arms',
	'legs',
	'glutes',
	'core',
	'full_body',
	'cable'
] as const;
export const RESISTANCE_BASES = ['total', 'per_arm'] as const;

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
		laterality: text('laterality').notNull().default('unknown'),
		bodyRegion: text('body_region'),
		/** `total` or `per_arm`; meaningful only when starting_resistance is set. */
		startingResistanceBasis: text('starting_resistance_basis'),
		/** Where the row's facts came from. `user` for every row a user creates. */
		confidence: text('confidence').notNull().default('user'),
		/** The page the catalog row was read from; null on `inferred` and `user` rows. */
		sourceUrl: text('source_url'),
		/** The catalog snapshot date a global row came from; null on user rows. */
		catalogSnapshot: date('catalog_snapshot', { mode: 'string' }),
		/**
		 * The catalog's own remark on the row (CSV `notes`), e.g. "code unknown —
		 * verify". Catalog data on global rows; carried onto an owned copy. Since
		 * 0.3.2 (migration 0014).
		 */
		notes: text('notes'),
		/**
		 * The manufacturer's standard weight stack (CSV `stack_lb` / `stack_note`).
		 * Only a default: the gym's own instance keeps `gym_equipment.stack_lb`,
		 * pre-filled from this when the user leaves it blank. Since 0.3.2 (0015).
		 */
		standardStackLb: integer('standard_stack_lb'),
		standardStackNote: text('standard_stack_note'),
		/**
		 * When a catalog snapshot stopped listing this global row (0.3.2, 0015).
		 * Retired rows are hidden from lists, search, pickers and matching
		 * (`modelVisibleTo`), but never deleted: machines may point at them.
		 * Always NULL on owned rows.
		 */
		retiredAt: timestamp('retired_at', { withTimezone: true }),
		/**
		 * Optional owner. NULLABLE and therefore not backfilled: NULL means
		 * "global equipment catalogue entry" — a machine model is reference
		 * data, not user data, so the existing rows stay shared. A non-NULL
		 * value means the model is private to that user.
		 *
		 * `text` not `uuid` — see programs.userId. No onDelete: NO ACTION.
		 */
		ownerUserId: text('owner_user_id').references(() => authUsers.id)
	},
	(t) => ({
		ownerUserIdIdx: index('equipment_models_owner_user_id_idx').on(t.ownerUserId),
		resistanceCheck: check(
			'model_resistance_check',
			sql`${t.startingResistance} IS NULL OR ${t.startingResistance} >= 0`
		),
		// The catalog join key. Partial: owned rows may repeat a catalog code
		// (a user's corrected copy), and codeless catalog rows (Signature
		// Series publishes none) are deduped by the importer instead.
		catalogCodeUnique: uniqueIndex('equipment_models_catalog_code_unique')
			.on(t.manufacturer, t.code)
			.where(sql`${t.code} IS NOT NULL AND ${t.code} <> '' AND ${t.ownerUserId} IS NULL`),
		standardStackCheck: check(
			'equipment_models_standard_stack_lb_check',
			sql`${t.standardStackLb} IS NULL OR ${t.standardStackLb} > 0`
		),
		confidenceCheck: check(
			'equipment_models_confidence_check',
			sql`${t.confidence} IN ('manufacturer_page', 'reseller_or_manual', 'inferred', 'line_only', 'user')`
		),
		bodyRegionCheck: check(
			'equipment_models_body_region_check',
			sql`${t.bodyRegion} IS NULL OR ${t.bodyRegion} IN ('chest', 'back', 'shoulders', 'arms', 'legs', 'glutes', 'core', 'full_body', 'cable')`
		),
		resistanceBasisCheck: check(
			'equipment_models_resistance_basis_check',
			sql`${t.startingResistanceBasis} IS NULL OR ${t.startingResistanceBasis} IN ('total', 'per_arm')`
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

export const gyms = pgTable(
	'gyms',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		name: text('name').notNull(),
		/**
		 * Owner. `text` not `uuid` — see the note on programs.userId.
		 * No onDelete: NO ACTION, so deleting an account cannot silently
		 * delete the gym (and everything hanging off it).
		 */
		userId: text('user_id')
			.notNull()
			.references(() => authUsers.id),
		/**
		 * Removed with history (0.7.0, machines spec Part G): hidden from every
		 * list and picker, and its machines with it; kept for past workouts. A
		 * gym nothing points at is deleted instead.
		 */
		archivedAt: timestamp('archived_at', { withTimezone: true })
	},
	(t) => ({
		userIdIdx: index('gyms_user_id_idx').on(t.userId)
	})
);

export const gymEquipment = pgTable(
	'gym_equipment',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		gymId: uuid('gym_id')
			.notNull()
			.references(() => gyms.id),
		equipmentModelId: uuid('equipment_model_id').references(() => equipmentModels.id),
		localLabel: text('local_label').notNull(),
		equipmentType: text('equipment_type').notNull(),
		/**
		 * Stack size of THIS gym's instance. It lives here, not on the model,
		 * because manufacturers sell heavier optional stacks under one code.
		 */
		stackLb: integer('stack_lb'),
		/** Smallest load step on this instance (pin step or add-on weight). */
		incrementLb: integer('increment_lb'),
		/** Removed with history (0.7.0, Part G); see gyms.archivedAt. */
		archivedAt: timestamp('archived_at', { withTimezone: true }),
		/** Merged into this machine (0.7.0, Part K); set with archivedAt, cleared by undo. */
		mergedIntoId: uuid('merged_into_id')
	},
	(t) => ({
		mergedIntoFk: foreignKey({
			name: 'gym_equipment_merged_into_id_fk',
			columns: [t.mergedIntoId],
			foreignColumns: [t.id]
		}),
		mergedIntoIdx: index('gym_equipment_merged_into_idx').on(t.mergedIntoId),
		gymIdx: index('gym_equipment_gym_idx').on(t.gymId),
		modelIdx: index('gym_equipment_model_idx').on(t.equipmentModelId),
		stackCheck: check(
			'gym_equipment_stack_lb_check',
			sql`${t.stackLb} IS NULL OR ${t.stackLb} > 0`
		),
		incrementCheck: check(
			'gym_equipment_increment_lb_check',
			sql`${t.incrementLb} IS NULL OR ${t.incrementLb} > 0`
		)
	})
);

/**
 * One merge of two machines (0.7.0, machines spec Part K): which machine was
 * dropped into which, and the ids of every row that moved, so undo moves back
 * exactly those rows. Owned directly by `user_id`.
 */
export const machineMerges = pgTable(
	'machine_merges',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		userId: text('user_id').notNull(),
		droppedId: uuid('dropped_id').notNull(),
		keptId: uuid('kept_id').notNull(),
		/** The ids of every row that moved: `{ sets, sessionExercises, photos }`. */
		moved: jsonb('moved').$type<MachineMergeMoved>().notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		undoneAt: timestamp('undone_at', { withTimezone: true })
	},
	(t) => ({
		userFk: foreignKey({
			name: 'machine_merges_user_id_fk',
			columns: [t.userId],
			foreignColumns: [authUsers.id]
		}),
		droppedFk: foreignKey({
			name: 'machine_merges_dropped_id_fk',
			columns: [t.droppedId],
			foreignColumns: [gymEquipment.id]
		}),
		keptFk: foreignKey({
			name: 'machine_merges_kept_id_fk',
			columns: [t.keptId],
			foreignColumns: [gymEquipment.id]
		}),
		userIdx: index('machine_merges_user_idx').on(t.userId),
		droppedIdx: index('machine_merges_dropped_idx').on(t.droppedId),
		keptIdx: index('machine_merges_kept_idx').on(t.keptId)
	})
);
export type MachineMergeMoved = {
	sets: string[];
	sessionExercises: string[];
	photos: string[];
};

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
		notes: text('notes'),
		/**
		 * Owner. `text` not `uuid` — see the note on programs.userId.
		 * No onDelete: NO ACTION, so deleting an account cannot silently
		 * delete workout history.
		 */
		userId: text('user_id')
			.notNull()
			.references(() => authUsers.id),
		/**
		 * The gym this workout is in (0.5.1, migration 0017). Set by
		 * `startQuickSession`, always to a gym of the session's owner; NULL for
		 * program sessions and everything before 0.5.1. `addSessionExercise`
		 * defaults to it. NO ACTION on delete, like every owner-chain FK.
		 */
		gymId: uuid('gym_id')
	},
	(t) => ({
		gymFk: foreignKey({
			name: 'sessions_gym_id_fk',
			columns: [t.gymId],
			foreignColumns: [gyms.id]
		}),
		gymIdIdx: index('sessions_gym_id_idx').on(t.gymId),
		dayStartedAtIdx: index('sessions_day_started_at_idx').on(
			t.dayId,
			t.startedAt.desc().nullsLast()
		),
		programIdIdx: index('sessions_program_id_idx').on(t.programId),
		/**
		 * Every scoped history/progression query filters sessions by owner
		 * without joining. History is append-only and unbounded, so this is
		 * the most-used new index in the migration.
		 */
		userIdIdx: index('sessions_user_id_idx').on(t.userId),
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
		loggedAt: timestamp('logged_at').notNull().defaultNow(),
		/**
		 * Owner. `text` not `uuid` — see the note on programs.userId.
		 * No onDelete: NO ACTION, so deleting an account cannot silently
		 * delete workout history.
		 */
		userId: text('user_id')
			.notNull()
			.references(() => authUsers.id)
	},
	(t) => ({
		sessionIdIdx: index('sets_session_id_idx').on(t.sessionId),
		/**
		 * Owner filter for scoped set queries (history, progression, reports).
		 * The existing `sets_identity_idx` leads with exercise_id and is used
		 * by a different access path, so it cannot serve this filter.
		 */
		userIdIdx: index('sets_user_id_idx').on(t.userId),
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
			t.loggedAt.desc().nullsLast()
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
		occurredAt: timestamp('occurred_at').notNull().defaultNow(),
		/**
		 * Owner. `text` not `uuid` — see the note on programs.userId.
		 * No onDelete: NO ACTION, so deleting an account cannot silently
		 * delete workout history.
		 */
		userId: text('user_id')
			.notNull()
			.references(() => authUsers.id)
	},
	(t) => ({
		exerciseOccurredIdx: index('pain_events_exercise_occurred_idx').on(
			t.exerciseId,
			t.occurredAt.desc().nullsLast()
		),
		locationOccurredIdx: index('pain_events_location_occurred_idx').on(
			t.location,
			t.occurredAt.desc().nullsLast()
		),
		sessionIdIdx: index('pain_events_session_id_idx').on(t.sessionId),
		userIdIdx: index('pain_events_user_id_idx').on(t.userId),
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

// ---------- llm_calls (0.3.1) ----------

/**
 * Every outcome a `complete()` call can record. One row per call, written on
 * every path including the ones that throw — see src/lib/server/llm/.
 */
export const LLM_CALL_STATUSES = [
	'ok',
	'schema_error',
	'provider_error',
	'timeout',
	'refused'
] as const;
export type LlmCallStatus = (typeof LLM_CALL_STATUSES)[number];

/**
 * One row per model call, written only by `complete()` in
 * src/lib/server/llm/index.ts. Directly owned: `user_id` is the caller, and
 * every call is on behalf of a user (no system calls in v1).
 *
 * Prompts are NOT stored by default: `prompt_hash` is always present (first 16
 * hex of sha256 over instructions + messages) and `prompt_text` is filled only
 * when LLM_STORE_PROMPTS=1. The API key is never stored anywhere.
 */
export const llmCalls = pgTable(
	'llm_calls',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		/** Owner. `text` not `uuid` — see programs.userId. No onDelete: NO ACTION. */
		userId: text('user_id').notNull(),
		/** What the call was for, e.g. `ping`, `equipment_from_photo`. */
		purpose: text('purpose').notNull(),
		/** `openrouter` today; `anthropic` / `bedrock` later. */
		provider: text('provider').notNull(),
		/** The model id sent (empty when the call never got as far as a model). */
		model: text('model').notNull(),
		/** The provider's response id, when it returned one. */
		requestId: text('request_id'),
		status: text('status').$type<LlmCallStatus>().notNull(),
		errorCode: text('error_code'),
		promptTokens: integer('prompt_tokens'),
		completionTokens: integer('completion_tokens'),
		latencyMs: integer('latency_ms').notNull(),
		promptHash: text('prompt_hash').notNull(),
		promptText: text('prompt_text'),
		/** The parsed object on `ok`; the raw model text on `schema_error`. */
		output: jsonb('output'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => ({
		userFk: foreignKey({
			name: 'llm_calls_user_id_fk',
			columns: [t.userId],
			foreignColumns: [authUsers.id]
		}),
		userCreatedIdx: index('llm_calls_user_created_idx').on(t.userId, t.createdAt),
		purposeCreatedIdx: index('llm_calls_purpose_created_idx').on(t.purpose, t.createdAt),
		statusCheck: check(
			'llm_calls_status_check',
			sql`${t.status} IN ('ok', 'schema_error', 'provider_error', 'timeout', 'refused')`
		)
	})
);

// ---------- equipment_photos (0.4.0) ----------

/**
 * A photo's life: `uploaded` (stored, not yet read by a model, or the last
 * analysis failed) -> `analyzed` (a candidate is attached) -> `confirmed` (the
 * user linked or created a model and a gym_equipment row exists) or
 * `discarded` (the object is deleted from the store; the row stays for audit).
 */
export const PHOTO_STATUSES = ['uploaded', 'analyzed', 'confirmed', 'discarded'] as const;
export type PhotoStatus = (typeof PHOTO_STATUSES)[number];

/**
 * One row per uploaded equipment photo. Directly owned (`user_id NOT NULL`),
 * and the gym it was taken for is the same user's: every write resolves the
 * gym with `gyms.user_id = userId` first. The image itself lives in the
 * private photo store under `storage_key`; it is served only through the
 * guarded `/photos/[id]/image` route.
 */
export const equipmentPhotos = pgTable(
	'equipment_photos',
	{
		id: uuid('id').defaultRandom().primaryKey(),
		/** Owner. `text` not `uuid` — see programs.userId. No onDelete: NO ACTION. */
		userId: text('user_id').notNull(),
		/** The gym the photo was taken for; the resulting machine goes here. */
		gymId: uuid('gym_id').notNull(),
		storageKey: text('storage_key').notNull(),
		/** Always `image/jpeg` after processing. */
		contentType: text('content_type').notNull(),
		/** Of the STORED (processed) image, not the upload. */
		bytes: integer('bytes').notNull(),
		width: integer('width').notNull(),
		height: integer('height').notNull(),
		/** sha256 hex of the stored bytes. */
		sha256: text('sha256').notNull(),
		status: text('status').$type<PhotoStatus>().notNull(),
		/** The analysis call that produced `candidate`. */
		llmCallId: uuid('llm_call_id'),
		/** The parsed EquipmentCandidate (photos/analyze.ts). */
		candidate: jsonb('candidate'),
		/** The existing model the user linked. */
		matchedModelId: uuid('matched_model_id'),
		/** The owned model the user created from the candidate. */
		createdModelId: uuid('created_model_id'),
		/** The machine the confirmation created. */
		gymEquipmentId: uuid('gym_equipment_id'),
		/**
		 * The workout block this photo opened (0.6.0, Part C), so the photo stays
		 * with the workout record after machines are merged. Null for photos from
		 * the gym page, and when the block is deleted.
		 */
		sessionExerciseId: uuid('session_exercise_id'),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => ({
		userFk: foreignKey({
			name: 'equipment_photos_user_id_fk',
			columns: [t.userId],
			foreignColumns: [authUsers.id]
		}),
		gymFk: foreignKey({
			name: 'equipment_photos_gym_id_fk',
			columns: [t.gymId],
			foreignColumns: [gyms.id]
		}),
		llmCallFk: foreignKey({
			name: 'equipment_photos_llm_call_id_fk',
			columns: [t.llmCallId],
			foreignColumns: [llmCalls.id]
		}),
		matchedModelFk: foreignKey({
			name: 'equipment_photos_matched_model_id_fk',
			columns: [t.matchedModelId],
			foreignColumns: [equipmentModels.id]
		}),
		createdModelFk: foreignKey({
			name: 'equipment_photos_created_model_id_fk',
			columns: [t.createdModelId],
			foreignColumns: [equipmentModels.id]
		}),
		gymEquipmentFk: foreignKey({
			name: 'equipment_photos_gym_equipment_id_fk',
			columns: [t.gymEquipmentId],
			foreignColumns: [gymEquipment.id]
		}),
		sessionExerciseFk: foreignKey({
			name: 'equipment_photos_session_exercise_id_fk',
			columns: [t.sessionExerciseId],
			foreignColumns: [sessionExercises.id]
		}).onDelete('set null'),
		sessionExerciseIdx: index('equipment_photos_session_exercise_idx').on(t.sessionExerciseId),
		storageKeyUnique: unique('equipment_photos_storage_key_unique').on(t.storageKey),
		userCreatedIdx: index('equipment_photos_user_created_idx').on(t.userId, t.createdAt),
		gymEquipmentIdx: index('equipment_photos_gym_equipment_idx').on(t.gymEquipmentId),
		// Every FK column is indexed (CLAUDE.md "Schema discipline"); user_id is
		// covered by the (user_id, created_at) index above.
		gymIdx: index('equipment_photos_gym_idx').on(t.gymId),
		llmCallIdx: index('equipment_photos_llm_call_idx').on(t.llmCallId),
		matchedModelIdx: index('equipment_photos_matched_model_idx').on(t.matchedModelId),
		createdModelIdx: index('equipment_photos_created_model_idx').on(t.createdModelId),
		statusCheck: check(
			'equipment_photos_status_check',
			sql`${t.status} IN ('uploaded', 'analyzed', 'confirmed', 'discarded')`
		),
		sizeCheck: check(
			'equipment_photos_size_check',
			sql`${t.bytes} > 0 AND ${t.width} > 0 AND ${t.height} > 0`
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
export type LlmCall = typeof llmCalls.$inferSelect;
export type NewLlmCall = typeof llmCalls.$inferInsert;
export type EquipmentPhoto = typeof equipmentPhotos.$inferSelect;
export type NewEquipmentPhoto = typeof equipmentPhotos.$inferInsert;
