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
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

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
    sourceProgramId: uuid('source_program_id').references(
      (): any => programs.id,
      { onDelete: 'set null' },
    ),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    sourceProgramIdIdx: index('programs_source_program_id_idx').on(
      t.sourceProgramId,
    ),
  }),
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
    notes: text('notes'),
  },
  (t) => ({
    uniqueProgramPosition: unique('days_program_position_unique').on(
      t.programId,
      t.position,
    ),
    programIdIdx: index('days_program_id_idx').on(t.programId),
  }),
);

// ---------- exercises (master list) ----------

export const exercises = pgTable('exercises', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull().unique(),
  // Free text for MVP. Used by `snapForEquipment()` to dispatch plate-snap math.
  // Known values: 'barbell', 'barbell-ez', 'machine-plate', 'machine-stack',
  // 'cable', 'dumbbell', 'smith', 'bodyweight', 'band'.
  equipmentType: text('equipment_type'),
  notes: text('notes'),
});

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
      enum: ['standard', 'cautious', 'hold'],
    })
      .notNull()
      .default('standard'),
    notes: text('notes'),
  },
  (t) => ({
    uniqueDayPosition: unique('day_exercises_day_position_unique').on(
      t.dayId,
      t.position,
    ),
    dayIdIdx: index('day_exercises_day_id_idx').on(t.dayId),
    exerciseIdIdx: index('day_exercises_exercise_id_idx').on(t.exerciseId),
  }),
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
      enum: ['warmup', 'working', 'top', 'backoff'],
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
      mode: 'number',
    }),
    restSecondsMin: integer('rest_seconds_min'),
    restSecondsMax: integer('rest_seconds_max'),
    notes: text('notes'),
  },
  (t) => ({
    uniqueDayExercisePosition: unique(
      'prescribed_sets_day_exercise_position_unique',
    ).on(t.dayExerciseId, t.position),
    dayExerciseIdIdx: index('prescribed_sets_day_exercise_id_idx').on(
      t.dayExerciseId,
    ),
    repsRangeCheck: check(
      'prescribed_sets_reps_range_check',
      sql`${t.targetRepsMin} IS NULL OR ${t.targetRepsMax} IS NULL
          OR ${t.targetRepsMin} <= ${t.targetRepsMax}`,
    ),
    rirRangeCheck: check(
      'prescribed_sets_rir_range_check',
      sql`${t.targetRir} IS NULL
          OR (${t.targetRir} >= 0 AND ${t.targetRir} <= 10)`,
    ),
    repsMinNonNeg: check(
      'prescribed_sets_reps_min_non_negative',
      sql`${t.targetRepsMin} IS NULL OR ${t.targetRepsMin} >= 0`,
    ),
    repsMaxNonNeg: check(
      'prescribed_sets_reps_max_non_negative',
      sql`${t.targetRepsMax} IS NULL OR ${t.targetRepsMax} >= 0`,
    ),
    initialLoadNonNeg: check(
      'prescribed_sets_initial_load_non_negative',
      sql`${t.initialLoad} IS NULL OR ${t.initialLoad} >= 0`,
    ),
    restMinNonNeg: check(
      'prescribed_sets_rest_min_non_negative',
      sql`${t.restSecondsMin} IS NULL OR ${t.restSecondsMin} >= 0`,
    ),
    restMaxNonNeg: check(
      'prescribed_sets_rest_max_non_negative',
      sql`${t.restSecondsMax} IS NULL OR ${t.restSecondsMax} >= 0`,
    ),
    restRangeCheck: check(
      'prescribed_sets_rest_range_check',
      sql`${t.restSecondsMin} IS NULL OR ${t.restSecondsMax} IS NULL
          OR ${t.restSecondsMin} <= ${t.restSecondsMax}`,
    ),
  }),
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
    notes: text('notes'),
  },
  (t) => ({
    dayStartedAtIdx: index('sessions_day_started_at_idx').on(
      t.dayId,
      t.startedAt.desc(),
    ),
    programIdIdx: index('sessions_program_id_idx').on(t.programId),
    // At most one open session per day. Partial unique index — closes the
    // double-submit race in `startSessionForDay` (the app-layer check there
    // covers the common case; this catches true concurrent inserts).
    oneOpenPerDay: uniqueIndex('sessions_one_open_per_day')
      .on(t.dayId)
      .where(sql`ended_at IS NULL`),
  }),
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
    prescribedSetId: uuid('prescribed_set_id').references(
      () => prescribedSets.id,
      { onDelete: 'set null' },
    ),
    position: integer('position').notNull(),
    setRole: text('set_role', {
      enum: ['warmup', 'working', 'top', 'backoff'],
    }).notNull(),
    targetMetric: text('target_metric', { enum: ['reps', 'seconds'] })
      .notNull()
      .default('reps'),

    // Prescribed values: snapshotted from the template at session-start time
    // (per planning §1 snapshot semantics). Range, not single value (v2.2 fix).
    prescribedLoad: numeric('prescribed_load', {
      precision: 6,
      scale: 2,
      mode: 'number',
    }),
    prescribedRepsMin: integer('prescribed_reps_min'),
    prescribedRepsMax: integer('prescribed_reps_max'),
    prescribedRir: integer('prescribed_rir'),

    // Executed values: filled in by the user during/after the set.
    executedLoad: numeric('executed_load', {
      precision: 6,
      scale: 2,
      mode: 'number',
    }),
    executedReps: integer('executed_reps'),
    executedRir: integer('executed_rir'),

    wasAudible: boolean('was_audible').notNull().default(false),
    notes: text('notes'),
    loggedAt: timestamp('logged_at').notNull().defaultNow(),
  },
  (t) => ({
    sessionIdIdx: index('sets_session_id_idx').on(t.sessionId),
    prescribedSetIdIdx: index('sets_prescribed_set_id_idx').on(
      t.prescribedSetId,
    ),
    // Composite for the prefill query (planning §11). Ordering:
    //   exercise_id, set_role, position, logged_at DESC.
    prefillIdx: index('sets_prefill_idx').on(
      t.exerciseId,
      t.setRole,
      t.position,
      t.loggedAt.desc(),
    ),
    repsCheck: check(
      'sets_reps_check',
      sql`${t.executedReps} IS NULL OR ${t.executedReps} >= 0`,
    ),
    loadCheck: check(
      'sets_load_check',
      sql`${t.executedLoad} IS NULL OR ${t.executedLoad} >= 0`,
    ),
    rirCheck: check(
      'sets_rir_check',
      sql`${t.executedRir} IS NULL
          OR (${t.executedRir} >= 0 AND ${t.executedRir} <= 10)`,
    ),
    prescribedRepsRangeCheck: check(
      'sets_prescribed_reps_range_check',
      sql`${t.prescribedRepsMin} IS NULL OR ${t.prescribedRepsMax} IS NULL
          OR ${t.prescribedRepsMin} <= ${t.prescribedRepsMax}`,
    ),
    prescribedRepsMinNonNeg: check(
      'sets_prescribed_reps_min_non_negative',
      sql`${t.prescribedRepsMin} IS NULL OR ${t.prescribedRepsMin} >= 0`,
    ),
    prescribedRepsMaxNonNeg: check(
      'sets_prescribed_reps_max_non_negative',
      sql`${t.prescribedRepsMax} IS NULL OR ${t.prescribedRepsMax} >= 0`,
    ),
    prescribedLoadNonNeg: check(
      'sets_prescribed_load_non_negative',
      sql`${t.prescribedLoad} IS NULL OR ${t.prescribedLoad} >= 0`,
    ),
    prescribedRirCheck: check(
      'sets_prescribed_rir_check',
      sql`${t.prescribedRir} IS NULL
          OR (${t.prescribedRir} >= 0 AND ${t.prescribedRir} <= 10)`,
    ),
  }),
);

// ---------- pain_events ----------

export const painEvents = pgTable(
  'pain_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    // All three FKs nullable. CHECK below requires at least one non-null
    // (no orphan pain entries with only location/severity).
    sessionId: uuid('session_id').references(() => sessions.id, {
      onDelete: 'cascade',
    }),
    setId: uuid('set_id').references(() => sets.id, { onDelete: 'set null' }),
    exerciseId: uuid('exercise_id').references(() => exercises.id),
    location: text('location').notNull(), // free text MVP; promote to enum later
    severity: integer('severity').notNull(), // 1-10
    trigger: text('trigger'),
    notes: text('notes'),
    occurredAt: timestamp('occurred_at').notNull().defaultNow(),
  },
  (t) => ({
    exerciseOccurredIdx: index('pain_events_exercise_occurred_idx').on(
      t.exerciseId,
      t.occurredAt.desc(),
    ),
    locationOccurredIdx: index('pain_events_location_occurred_idx').on(
      t.location,
      t.occurredAt.desc(),
    ),
    sessionIdIdx: index('pain_events_session_id_idx').on(t.sessionId),
    setIdIdx: index('pain_events_set_id_idx').on(t.setId),
    severityCheck: check(
      'pain_events_severity_check',
      sql`${t.severity} >= 1 AND ${t.severity} <= 10`,
    ),
    parentRequiredCheck: check(
      'pain_events_parent_required_check',
      sql`${t.sessionId} IS NOT NULL
          OR ${t.setId} IS NOT NULL
          OR ${t.exerciseId} IS NOT NULL`,
    ),
  }),
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
