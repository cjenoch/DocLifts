# Lifting App — Planning Lock (v2.1)

*Captures all decisions made through 2026-05-07, including v2's cross-LLM review (ChatGPT, Grok, Gemini) and v2.1's follow-up cross-LLM review. Use as the gate before starting environment setup. Anything that feels wrong here is cheaper to fix now than after building starts.*

---

## What changed from v2

The v2 doc was substantively right but had concrete bugs and underspecified pieces that surfaced under cross-review. v2.1 fixes them.

**Concrete schema bugs in v2:**
- `sets.prescribedReps` (singular) didn't match the prefill query that referenced `target_reps_max`. Replaced with `prescribedRepsMin` and `prescribedRepsMax` for snapshot consistency with the template's range.
- `pain_events` had nullable `sessionId` plus prose claiming `sessionId` was "the only required parent" — contradictory. Now: all three FKs nullable + CHECK constraint requiring at least one non-null.

**Pre-fill query was underspecified:**
- Match key needs `position` to distinguish multi-working-set exercises (set 1 RIR 3 vs set 2 RIR 1 are different intents).
- Must filter `executed_load IS NOT NULL` and `executed_reps IS NOT NULL` to avoid grabbing today's pre-created blank rows as history.
- Must filter `sessions.ended_at IS NOT NULL` once session completion exists.
- Must return rep range and RIR (not just executed values) so the progression engine has its inputs.

**Progression engine pseudocode in v2 didn't match the v5 program rules:**
- v5 has different rules per tier: MAIN is top-set-driven; SECONDARY/ISOLATION require ALL relevant sets to clear top of range. v2 ran one rule on one set's data — wrong for two-working-set exercises.
- Warmups don't progress (134 lb deadlift warmup stays 134 because of plate floor, not history). The engine should only run on top/working/backoff sets.
- `consecutiveBackwards` was named but not defined.
- Per-exercise progression policy (e.g., "shoulder press: hold loads, bump only after 2-3 clean sessions") wasn't expressible.

**Plate calc was a stub:**
- `snapToAchievable` was just `// ...` in v2. Concrete algorithm written below, with v5 deadlift increments (134/184/224/244/264/284/304/314/324) as test fixture.

**Schema additions:**
- `days.alternateGroupId` for the Day 3A/3B alternation default (was hand-waved as "~5 lines").
- `day_exercises.progressionPolicy` for per-exercise progression overrides (shoulder caution, etc.).

**Order-of-operations gap:**
- v2 didn't explicitly state pipeline order: history lookup → progression engine → plate snap → display. Stating it now.

**MVP sub-phasing:**
- Split into MVP-A (logging works) and MVP-B (coaching intelligence). Validates the read/write loop before adding the more complex pieces.

**Estimate revision:**
- ~110 hours → ~140 hours, ±50%. Honest given the added scope (deep-copy implementation, tier-aware engine, real plate calc + tests, pain UI, seed update, learning Svelte 5 from rusty).

**Things that didn't change:**
- All of v2's locked decisions (snapshot semantics, single-table prescribed/executed, programs as duplicate-on-edit, no current loads in template, tier on day_exercises, Week A/B as separate days, sleep/energy stripped).
- Stack picks.
- Node 24 LTS.

---

## Project framing

**What this is:** A personal weight-lifting log application, built primarily as a vehicle for refreshing web app development skills with current (2026) stacks. Single user. Will live on localhost during development and eventually deploy to a small cloud host.

**What this isn't:** A product. Not multi-tenant. Not a fitness tracker — cardio, sleep, HRV deferred to existing tools (Fitbit). Not a general-purpose workout planner.

**The two pulls in tension:** "Useful training log" wants to ship fast. "Learn web dev" wants to slow down. Default tiebreaker: useful-tool-wins for plumbing previously done, learning-wins for the 2-3 areas discovered to be worth deepening. Identify those at the week-4 checkpoint.

**Personal profile:** 25 years enterprise/cloud/DB experience, rusty on current frontend, 20 hr/wk active build time starting ~2 weeks from this doc.

---

## Success criteria

The MVP wins by doing things Notes structurally cannot:

- Pre-populated prescribed loads (history → progression engine → plate snap)
- Pre-populated set structure (warm-ups, working, top, back-off positions)
- Inline last-session-actuals next to prescribed
- Plate-achievable loads only (no impossible suggestions)
- Validated inputs (no negative reps, no impossible loads)
- Per-exercise history without copy-paste
- Set roles as first-class data
- Structured pain events queryable by exercise/location/time

After 2 weeks of using the MVP, if you still open Notes for logging — the MVP failed.

---

## Stack

| Layer | Pick | Why |
|---|---|---|
| Runtime | **Node 24 LTS** | Active LTS through April 2028. Node 20 EOL May 2026. |
| Frontend + backend | **SvelteKit** | Less code per feature, cleaner mental model than React hooks, materially better form story (superforms + Zod). |
| Forms + validation | **sveltekit-superforms + Zod** | Schema-driven, progressive enhancement, server-first. |
| Styling | **Tailwind CSS** | Industry default. |
| Database | **PostgreSQL 16** | Self-managed in Docker for dev. |
| ORM/query layer | **Drizzle** | TypeScript-native, SQL-shaped. |
| Linter/formatter | **Biome** | Single tool, fast, low config. |
| Testing | **Vitest** | Built into SvelteKit scaffold. |
| Package manager | **pnpm** | Faster, better disk use. |
| Deployment (later) | **Fly.io or Railway** | Containerized, modern tooling. |

**TypeScript strict mode.** Non-negotiable.

**Project rules file (`CLAUDE.md` / `AGENTS.md` in repo root):**
- Use Svelte 5 runes (`$state`, `$derived`, `$effect`), not legacy `$:` patterns
- SvelteKit server actions for form submissions unless there's a strong reason not to
- DB code lives only under `src/lib/server`
- Don't add auth, sync, AI, or mobile without explicit approval
- Preserve session snapshot semantics (sets store prescribed values at log time)
- Don't store prescribed loads only in notes — use the structured fields
- Override progression suggestions easily (user judgment outranks rule output)
- Volume aggregates must filter `target_metric = 'reps'` to avoid mixing planks (seconds) into weight × reps math

---

## Auth, privacy, encryption

**Decision:** Skip for MVP. Single-tenant, localhost only. No login, no app-level encryption beyond OS-level disk encryption. When eventually deployed, add Auth.js or Lucia.

**Open / unresolved:** "Optional encryption, no recovery" was over-engineered for low-sensitivity data. Revisit when deployment becomes real.

---

## Data model decisions

### 1. Snapshot semantics for sessions

Past sessions preserve what was prescribed at the time. History is append-only and immutable in effect. Editing the program does not retroactively rewrite history.

**Snapshot-into-`sets`:** `prescribed_load`, `prescribed_reps_min`, `prescribed_reps_max`, `prescribed_rir`, `set_role`, and `target_metric` are all copied into the `sets` row at session-start time. Once written, they don't change — even if the program template is edited.

### 2. Prescribed vs executed: single-table (Option A)

A `sets` row contains both prescribed and executed columns side-by-side. Snapshot is implicit — values are copied at log time.

**Principle named:** Textbook normalization is often wrong for small single-user systems. Optimize for read simplicity. Refactor if duplication causes real bugs.

### 3. No *current target* loads in the program template (with cold-start exception)

Program template stores **structure** (exercises, set roles, rep ranges, tiers, position, rest targets, metric type) but **not current target loads.** Prescribed loads at session-start come from `last_executed_load + progression engine + plate snap`, editable inline.

**Cold-start exception:** `prescribed_sets.initialLoad` (nullable) holds the seed value used only when no history exists. After session 1 logs the exercise, history takes over.

**Two consequences:**
- The wave-loading state machine still dissolves. No "Week 1A / 3A / 5A" abstraction in the schema.
- Week A / Week B alternation is two separate days. Alternation default (see #14) is a UI affordance via `alternateGroupId`, not a state machine.

### 4. Programs as independent rows with duplicate-on-edit (Option b)

Editing a program **deep-copies the program AND all child rows** (`days`, `day_exercises`, `prescribed_sets`), marks the old program inactive, user edits the copy. Exercises stay shared (master list).

`programs.sourceProgramId` (self-FK, nullable) tracks lineage.

**UI implication:** "Edit program" must visibly create a new active program and archive the previous one. Label it "Save as new version."

### 5. Tier on `day_exercises`, not `exercises`

Tier (`main` / `secondary` / `isolation`) is a property of (program × day × exercise), not exercise alone.

### 6. Pain events as first-class table

Promoted from "use notes" because the user's program has hard shoulder rules; pain is recurring data, not edge case.

**FK rule:** All three of `sessionId`, `setId`, `exerciseId` are nullable, but a CHECK constraint requires at least one to be non-null. Supports per-set, per-session, per-exercise, and "right shoulder ached generally" pain events without orphans.

### 7. Rest seconds on `prescribed_sets`

Rest target is per-set prescription data. The v5 deadlift ordering varies rest within one exercise (60-90s, 90s, 90s, 2 min for warmups; 3 min for working). Tier-derived defaults would be wrong for some sets. Two columns: `restSecondsMin`, `restSecondsMax`.

**Seed responsibility:** populate rest values for every prescribed_set. No fallback to tier defaults at query time — every set has explicit values.

### 8. `targetMetric` enum on prescribed_sets and sets

`'reps' | 'seconds'`, default `'reps'`. Planks store actual seconds in the rep columns honestly via this flag. Volume queries (post-MVP analytics) must filter `target_metric = 'reps'`.

**Naming note:** kept `prescribedRepsMin/Max` and `executedReps` rather than renaming to generic `targetValueMin/Max`. Reps is the dominant case; the metric flag disambiguates planks. Open to revisit if mixed-metric queries proliferate.

### 9. DB constraints, not just validation

- `executed_reps >= 0`
- `executed_load >= 0`
- `executed_rir BETWEEN 0 AND 10`
- `prescribed_rir BETWEEN 0 AND 10`
- `prescribed_reps_min <= prescribed_reps_max` (when both non-null)
- `target_reps_min <= target_reps_max` (when both non-null)
- `severity BETWEEN 1 AND 10` (pain_events)
- `pain_events`: at least one of (session_id, set_id, exercise_id) non-null
- Uniqueness on `(program_id, day_position)`, `(day_id, exercise_position)`, `(day_exercise_id, set_position)`

### 10. Indexes — explicit, not assumed

Postgres does NOT auto-index FK columns. Drizzle doesn't either. Declare these explicitly:

- `days(program_id)`
- `day_exercises(day_id)`
- `prescribed_sets(day_exercise_id)`
- `sets(session_id)`
- `sets(exercise_id, set_role, position, logged_at DESC)` — composite for prefill query (see §11)
- `sessions(day_id, started_at DESC)`
- `pain_events(exercise_id, occurred_at DESC)`
- `pain_events(location, occurred_at DESC)`

### 11. Pre-fill query specification

When a session starts, each prescribed set in the day's structure needs a suggested `prescribed_load`. Resolution order:

1. Look up most recent **completed** execution matching `(exercise_id, set_role, position)`.
2. If found, apply progression engine (§12) to compute suggestion.
3. If not found, fall back to `prescribed_sets.initialLoad`.
4. If `initialLoad` null, leave blank — user enters manually.
5. Snap final suggestion to plate-achievable load (§13).

The query:

```sql
SELECT
  s.executed_load,
  s.executed_reps,
  s.executed_rir,
  s.prescribed_reps_min,
  s.prescribed_reps_max,
  s.prescribed_rir
FROM sets s
JOIN sessions sess ON s.session_id = sess.id
WHERE s.exercise_id = $1
  AND s.set_role = $2
  AND s.position = $3
  AND s.executed_load IS NOT NULL
  AND s.executed_reps IS NOT NULL
  AND sess.ended_at IS NOT NULL
ORDER BY s.logged_at DESC
LIMIT 1
```

Match by `(exercise_id, set_role, position)` — preserves the distinction between two-working-set exercises (set 1 RIR 3 vs set 2 RIR 1). Cross-version: history flows naturally because exercises are shared across program versions.

The `ended_at IS NOT NULL` filter prevents in-progress sessions from poisoning the prefill (a freshly-created blank set row from today's session won't be returned as "history").

### 12. Progression engine

Encoded from v5's progression rules. Tier-aware: MAIN is top-set-driven, SECONDARY/ISOLATION require all relevant sets to clear top of range.

```typescript
type ExecutedSet = {
  position: number;
  load: number;
  reps: number;
  rir: number;
};

type ProgressionPolicy = 'standard' | 'cautious' | 'hold';

type ProgressionInput = {
  tier: 'main' | 'secondary' | 'isolation';
  policy: ProgressionPolicy;        // from day_exercises.progressionPolicy, default 'standard'
  // For 'main': pass [topSet]
  // For 'secondary' / 'isolation': pass all working sets in position order
  relevantSets: ExecutedSet[];
  targetRepsMax: number;
  targetRir: number;
  increment: number;                // 5 lb upper, 10 lb lower
  consecutiveBackwards: number;     // see definition below
};

type ProgressionResult = {
  load: number;                     // raw suggested load (pre-plate-snap)
  reasoning: string;                // for UI provenance display
};

function suggestNextLoad(input: ProgressionInput): ProgressionResult {
  const baseline = input.relevantSets[0].load;

  // Cautious / hold policy bypasses progression
  if (input.policy === 'cautious' || input.policy === 'hold') {
    return {
      load: baseline,
      reasoning: 'cautious progression — hold load until manual advance',
    };
  }

  // Reset rule: 2 consecutive backwards → 10% deload
  if (input.consecutiveBackwards >= 2) {
    return {
      load: baseline * 0.9,
      reasoning: '10% deload after 2 consecutive backwards sessions',
    };
  }

  if (input.tier === 'main') {
    const top = input.relevantSets[0];

    if (top.reps < input.targetRepsMax) {
      return { load: top.load, reasoning: `held: top set ${top.reps} reps below target ${input.targetRepsMax}` };
    }
    if (top.rir <= input.targetRir - 2) {
      return {
        load: top.load + input.increment * 2,
        reasoning: `+${input.increment * 2}: top set crushed at RIR ${top.rir} (target ${input.targetRir})`,
      };
    }
    if (top.rir <= input.targetRir) {
      return {
        load: top.load + input.increment,
        reasoning: `+${input.increment}: top set hit ${top.reps} reps at RIR ${top.rir}`,
      };
    }
    return { load: top.load, reasoning: `held: top set RIR ${top.rir} above target ${input.targetRir}` };
  }

  // SECONDARY / ISOLATION: ALL relevant sets must clear top of range
  const allClearTop = input.relevantSets.every(
    s => s.reps >= input.targetRepsMax && s.rir <= input.targetRir,
  );
  if (allClearTop) {
    return {
      load: baseline + input.increment,
      reasoning: `+${input.increment}: all working sets at top of range, RIR ≤ ${input.targetRir}`,
    };
  }
  return {
    load: baseline,
    reasoning: 'held: not all working sets cleared top of range',
  };
}
```

**Definition of `consecutiveBackwards`:** count, starting from the most recent completed session for this `(exercise_id, set_role)` and walking backwards, the number of consecutive sessions where the suggested load did not advance (load held or decreased relative to the prior session). Reset to 0 on first session that advanced.

For the MAIN tier this is computed against the top set. For SECONDARY/ISOLATION it's computed against any of the relevant sets (they all share a load, so any one is fine).

**Critical principle:** the engine produces *suggestions*, never auto-applied loads. User override is always one tap away. The user's read on form quality outranks the engine.

**Warmups don't use the engine.** When `set_role = 'warmup'`, prefill comes from `prescribed_sets.initialLoad` directly, with no progression. (A 134 lb deadlift warmup stays 134 because of the plate floor; "last warmup + bump" is the wrong frame.)

**Per-exercise overrides via `day_exercises.progressionPolicy`:**
- `'standard'` (default): apply rules above
- `'cautious'`: hold load by default; user manually advances. Used for shoulder press in v5 ("hold loads... bump to 75 only after 2-3 clean sessions").
- `'hold'`: explicit hold (e.g., during a deload week). Same effect as `cautious` for now; separated semantically.

### 13. Plate calculator

For single-tenant single-gym MVP, hardcode the gym config:

```typescript
// src/lib/server/gym-config.ts
export const gymConfig = {
  bars: { standard: 44 },                                  // lb
  platesPerSide: [45, 35, 25, 20, 15, 10, 5, 2.5] as const, // available pairs
};

export type SnapResult = {
  achievable: number;
  platesUsed: number[];  // per side, biggest first
};

/**
 * Greedy plate snap: prefer biggest plates first, add smallest to fill gap.
 * Returns the closest achievable load <= target.
 * If target < bar, returns bar only.
 */
export function snapToAchievable(
  targetLoad: number,
  bar: number = gymConfig.bars.standard,
  plates: readonly number[] = gymConfig.platesPerSide,
): SnapResult {
  if (targetLoad <= bar) {
    return { achievable: bar, platesUsed: [] };
  }

  const perSide = (targetLoad - bar) / 2;
  const used: number[] = [];
  let remaining = perSide;

  const sorted = [...plates].sort((a, b) => b - a);

  for (const plate of sorted) {
    while (remaining >= plate) {
      used.push(plate);
      remaining -= plate;
    }
  }

  const perSideTotal = used.reduce((sum, p) => sum + p, 0);
  return { achievable: bar + 2 * perSideTotal, platesUsed: used };
}
```

**Test fixture (v5 deadlift increments):** all of these must round-trip exactly when called as `snapToAchievable(load)`:
- 134 → 134 (45)
- 184 → 184 (45+25)
- 224 → 224 (45+45)
- 244 → 244 (45+45+10)
- 264 → 264 (45+45+20)
- 284 → 284 (45+45+25+5)
- 304 → 304 (45+45+35+5)
- 314 → 314 (45+45+45)
- 324 → 324 (45+45+45+5)

Off-target inputs round down to nearest achievable. (snapToAchievable(280) → 279 or similar; user accepts or overrides.)

When multi-gym arrives post-MVP, promote `gymConfig` to a `gyms` table with per-row plate inventory.

### 14. Day 3A/3B alternation default

`days.alternateGroupId` (text, nullable). Days with the same `alternateGroupId` form an alternation set.

When starting a session in an alternation set:
1. Look up the most recent session for any day in the group.
2. Default the day picker to the *other* day(s).
3. User can override.

For the v5 program: Day 3A (`alternateGroupId = 'legs'`) and Day 3B (`alternateGroupId = 'legs'`). After Day 3A is logged, default for next leg session is Day 3B.

Not a state machine. A presentation default. ~10 lines of logic.

### 15. Wave-loading UX expectation (known limitation)

The progression engine is built for linear progression. The v5 deadlift has wave loading (Wk1A 284 → Wk3A 304 → Wk5A 324 PR → Wk7A 224 deload). On wave weeks the engine's suggestion will be mechanically wrong:

- Wk5A → Wk7A: engine bumps from PR; reality wants 100 lb deload.
- Wk1A → Wk3A: engine bumps 5-10 lb; program wants 20 lb jump.

Mitigation:
1. Pre-fill is editable inline. One tap to change 290 → 304.
2. UI cue on each load field showing source: "Suggested 290 lb (last: 284 × 3, RIR 1, +5 hit target)" — load value, source data, reasoning, all visible. User can sanity-check rather than auto-accept.
3. Friction is bounded: ~4-6 manual overrides per 8-week cycle, all on the deadlift main lift.

Trade-off accepted. Not building a wave-loading state machine for MVP.

### 16. Pipeline order of operations

When session-starting and suggesting a load for a prescribed set:

```
1. history lookup        → returns last executed values, or null if none
2. progression engine    → returns ideal raw suggestion + reasoning
   (or skipped for warmups → use initialLoad)
   (or skipped if no history → use initialLoad)
3. plate snap            → returns achievable load given gym config
4. display               → suggestion + reasoning provenance, editable
```

Each step is independent and unit-testable. The engine produces ideal numbers; the snap reduces to physical reality; display shows both the achievable load and the source.

---

## Schema (Drizzle)

```typescript
// programs
export const programs = pgTable('programs', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  isActive: boolean('is_active').notNull().default(true),
  sourceProgramId: uuid('source_program_id')
    .references((): any => programs.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

// days
export const days = pgTable(
  'days',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    programId: uuid('program_id').notNull()
      .references(() => programs.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    position: integer('position').notNull(),
    alternateGroupId: text('alternate_group_id'),  // null = standalone
    notes: text('notes'),
  },
  (t) => ({
    uniqueProgramPosition: unique().on(t.programId, t.position),
    programIdIdx: index('days_program_id_idx').on(t.programId),
  }),
);

// exercises (master list)
export const exercises = pgTable('exercises', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull().unique(),
  equipmentType: text('equipment_type'),
  notes: text('notes'),
});

// day_exercises
export const dayExercises = pgTable(
  'day_exercises',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    dayId: uuid('day_id').notNull()
      .references(() => days.id, { onDelete: 'cascade' }),
    exerciseId: uuid('exercise_id').notNull()
      .references(() => exercises.id),
    position: integer('position').notNull(),
    tier: text('tier', { enum: ['main', 'secondary', 'isolation'] }).notNull(),
    progressionPolicy: text('progression_policy', {
      enum: ['standard', 'cautious', 'hold']
    }).notNull().default('standard'),
    notes: text('notes'),
  },
  (t) => ({
    uniqueDayPosition: unique().on(t.dayId, t.position),
    dayIdIdx: index('day_exercises_day_id_idx').on(t.dayId),
  }),
);

// prescribed_sets
export const prescribedSets = pgTable(
  'prescribed_sets',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    dayExerciseId: uuid('day_exercise_id').notNull()
      .references(() => dayExercises.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    setRole: text('set_role', {
      enum: ['warmup', 'working', 'top', 'backoff']
    }).notNull(),
    targetMetric: text('target_metric', {
      enum: ['reps', 'seconds']
    }).notNull().default('reps'),
    targetRepsMin: integer('target_reps_min'),
    targetRepsMax: integer('target_reps_max'),
    targetRir: integer('target_rir'),
    initialLoad: numeric('initial_load',
      { precision: 6, scale: 2, mode: 'number' }),
    restSecondsMin: integer('rest_seconds_min'),
    restSecondsMax: integer('rest_seconds_max'),
    notes: text('notes'),
  },
  (t) => ({
    uniqueDayExercisePosition: unique().on(t.dayExerciseId, t.position),
    dayExerciseIdIdx: index('prescribed_sets_day_exercise_id_idx').on(t.dayExerciseId),
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
  }),
);

// sessions
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    dayId: uuid('day_id').notNull().references(() => days.id),
    programId: uuid('program_id').notNull().references(() => programs.id),
    startedAt: timestamp('started_at').notNull().defaultNow(),
    endedAt: timestamp('ended_at'),
    notes: text('notes'),
  },
  (t) => ({
    dayStartedAtIdx: index('sessions_day_started_at_idx').on(
      t.dayId, t.startedAt.desc()
    ),
  }),
);

// sets (Option A: prescribed range + executed in one row, snapshotted)
export const sets = pgTable(
  'sets',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sessionId: uuid('session_id').notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    exerciseId: uuid('exercise_id').notNull()
      .references(() => exercises.id),
    prescribedSetId: uuid('prescribed_set_id')
      .references(() => prescribedSets.id, { onDelete: 'set null' }),
    position: integer('position').notNull(),
    setRole: text('set_role', {
      enum: ['warmup', 'working', 'top', 'backoff']
    }).notNull(),
    targetMetric: text('target_metric', {
      enum: ['reps', 'seconds']
    }).notNull().default('reps'),

    // prescribed (snapshotted at session-start; range, not single value)
    prescribedLoad: numeric('prescribed_load',
      { precision: 6, scale: 2, mode: 'number' }),
    prescribedRepsMin: integer('prescribed_reps_min'),
    prescribedRepsMax: integer('prescribed_reps_max'),
    prescribedRir: integer('prescribed_rir'),

    // executed
    executedLoad: numeric('executed_load',
      { precision: 6, scale: 2, mode: 'number' }),
    executedReps: integer('executed_reps'),
    executedRir: integer('executed_rir'),

    wasAudible: boolean('was_audible').notNull().default(false),
    notes: text('notes'),
    loggedAt: timestamp('logged_at').notNull().defaultNow(),
  },
  (t) => ({
    sessionIdIdx: index('sets_session_id_idx').on(t.sessionId),
    exerciseRolePositionLoggedAtIdx: index('sets_prefill_idx').on(
      t.exerciseId, t.setRole, t.position, t.loggedAt.desc()
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
  }),
);

// pain_events
export const painEvents = pgTable(
  'pain_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sessionId: uuid('session_id')
      .references(() => sessions.id, { onDelete: 'cascade' }),
    setId: uuid('set_id')
      .references(() => sets.id, { onDelete: 'set null' }),
    exerciseId: uuid('exercise_id')
      .references(() => exercises.id),
    location: text('location').notNull(),
    severity: integer('severity').notNull(),
    trigger: text('trigger'),
    notes: text('notes'),
    occurredAt: timestamp('occurred_at').notNull().defaultNow(),
  },
  (t) => ({
    exerciseOccurredIdx: index('pain_events_exercise_occurred_idx').on(
      t.exerciseId, t.occurredAt.desc()
    ),
    locationOccurredIdx: index('pain_events_location_occurred_idx').on(
      t.location, t.occurredAt.desc()
    ),
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
```

**Notes:**
- `numeric` columns use `mode: 'number'`. JS-number precision is safe for load weights bounded under 1000 lbs.
- `sourceProgramId` self-FK uses `(): any => programs.id` because of TypeScript's circular-reference issue with self-referencing tables in Drizzle. Known workaround.
- Drizzle's `check()` and `unique()` syntax may have shifted between versions; verify against current docs when wiring up.

---

## MVP scope, sub-phased

The MVP ships in two stages. MVP-A validates the read/write loop end-to-end before adding the coaching intelligence; MVP-B layers on the differentiation features.

### MVP-A: logging works (~60 hours, ±50%)

Goal: by end of MVP-A you can log a real session against the app. The first end-to-end log is the validation moment.

1. Schema migrated, v5 program seeded with all v2.1 fields populated.
2. Read-only routes: `/programs`, `/programs/[id]`, `/days/[id]` showing structure.
3. Session start: pick a day → create `sessions` row + `sets` rows pre-populated from prescribed_sets (snapshot the range, position, role, target metric, initial load if no history).
4. Set logging: edit `executedLoad`, `executedReps`, `executedRir`, `notes` per set via superforms + Zod.
5. History per exercise: `/exercises/[id]/history` listing last N sessions.
6. Persistence working end-to-end.

**Pre-fill in MVP-A is dumb:** if history exists for `(exercise_id, set_role, position)`, fill last `executed_load`. If not, fill `initialLoad`. No progression engine yet; user adjusts manually.

### MVP-B: coaching intelligence (~80 hours, ±50%)

Goal: app produces suggestions that beat manual mental math.

7. Progression engine implemented with test coverage on v5's rules.
8. Plate calc implemented with v5 deadlift increments as test fixture.
9. Pipeline wired: history → engine → snap → display, with provenance shown.
10. Pain events: form, basic list view per exercise/location.
11. Day 3A/3B alternation default.
12. Per-exercise progression policy (cautious for shoulder press).
13. Deep-copy on program edit (the duplicate-on-edit implementation).

**Total estimate:** ~140 hours, ±50%. ~7 weeks at 20 hr/wk if everything goes smoothly. Honestly, expect closer to 9-10 weeks given learning Svelte 5 + superforms while rusty.

### Explicitly cut from MVP

| Cut | Rationale |
|---|---|
| Rest timer UI | Phone has one. Rest *targets* are stored in schema; timer comes later. |
| Charts / trend visualizations | Write SQL against the DB directly first. |
| Multi-gym | One gym hardcoded for now. Promote to table later. |
| Wave loading state machine | Dissolved by "no current loads in template" + accepted UX friction on wave weeks. |
| AI integration | Phase 2-3. |
| Auth | Single-tenant localhost. |
| Sleep / energy / readiness fields | Logged elsewhere (Fitbit). Open to revisit. |
| `targetReps*` → `targetValue*` rename | Reps is dominant case; metric flag disambiguates. |
| `progressionGroup` on day_exercises | Seed approach (different name = different exercise) handles current cases. |

### Post-MVP priority order

1. Multi-gym support (gyms table, per-gym plate inventory, per-gym last-executed prefill)
2. Movement-vector tagging on exercises (for substitutions and pain-pattern matching)
3. Pain event analytics (trends, flagging)
4. Charts (trend visualizations)
5. AI for free-text-to-structured logging
6. Rest timer UI
7. Mobile / PWA
8. Wave loading explicit support if manual-override friction is actually painful
9. `progressionGroup` on day_exercises if exercise consolidation creates ambiguity

---

## Setup runway (2 weeks before active build)

| Day | Task |
|---|---|
| 1 | pnpm + SvelteKit init, Postgres docker, Biome config, Vitest scaffold, CLAUDE.md committed |
| 2 | Drizzle install, schema typed up (with all v2.1 additions), first migration, db client wired, sanity query |
| 3-4 | Update v5 seed script to populate `initialLoad`, `restSecondsMin/Max`, `targetMetric`, `progressionPolicy`, `alternateGroupId` |
| 5+ | Read SvelteKit docs (loads, actions, hooks), skim superforms README, look at one or two example apps |

**Active setup work:** ~12-15 hours.

### Repo skeleton

```
.
├── docker-compose.yml
├── drizzle.config.ts
├── drizzle/
├── CLAUDE.md
├── src/
│   ├── lib/
│   │   ├── server/
│   │   │   ├── db/
│   │   │   │   ├── index.ts     # db client
│   │   │   │   ├── schema.ts    # all tables
│   │   │   │   └── seed.ts      # v5 program populated
│   │   │   ├── gym-config.ts    # single-gym hardcoded for MVP
│   │   │   ├── progression.ts   # tier-aware engine
│   │   │   └── plates.ts        # snap-to-achievable
│   │   └── (client-safe utils)
│   ├── routes/
│   │   ├── +layout.svelte
│   │   ├── +page.svelte
│   │   ├── programs/
│   │   ├── sessions/
│   │   ├── exercises/
│   │   └── pain/
│   └── hooks.server.ts
└── vite.config.ts
```

---

## Week-1-of-active-build structure (for reference)

After the 2-week runway, week 1 of MVP-A:

| Day | Focus | Stretch |
|---|---|---|
| 1 | Routes scaffold: `/programs`, `/programs/[id]`, `/days/[id]`. Read-only rendering. | Styling. |
| 2 | Session start flow: button → creates session + pre-populated sets rows → redirect. | Dumb prefill (last executed load, no engine). |
| 3 | Set logging form (superforms + Zod): edit executed values inline. | Optimistic UI. |
| 4 | History view per exercise. | Filtering by set role. |
| 5 | Polish friction. **Log a real session against the dev app.** | Plate snap, if stretches stayed contained. |

End of week 1 = first end-to-end log. If you can't log a session by Friday, the architecture has a problem; find it before adding more features. Don't rush MVP-B features into week 1.

---

## Commercial divergence callouts

| Decision | Personal tool | Product implication |
|---|---|---|
| Single-tenant schema | Fine, no `user_id` columns | Multi-tenancy retroactively costs 2-3x; permanent debt |
| No auth | Fine on localhost | Required from day one |
| "No recovery" auth | Fine; export for safety | Non-starter — top support ticket category |
| Single-table prescribed/executed | Cleaner, simpler | Option B's normalization wins matter at scale with shared programs |
| Programs as independent rows (Option b) | Trivial duplicate-on-edit | Want explicit version semantics for shared/published programs |
| Drizzle | Fits SQL fluency | Prisma's migration tooling and ecosystem matter more for hiring/onboarding |
| SvelteKit | Better daily DX | React/Next.js wins on hiring pool and LLM coverage |
| Hardcoded gym config | Single gym fine | Per-gym plate inventory required |
| Progression engine encodes one program's rules | Fine for one trainee | Per-program rule pluggability needed |

---

## Open questions (revisit before relevant phase)

1. **Auth model when deploying.** Revisit when deployment becomes real.
2. **What "I'll know it when I see it" actually became.** Week-4 checkpoint.
3. **Sleep / energy fields.** Cut for now; revisit if Fitbit/lift connection mentally becomes annoying.
4. **Pain location enum.** Free text for MVP; promote to enum once values stabilize.
5. **Wave loading UX friction.** Accepted for MVP. Revisit if inline override on wave weeks becomes painful.
6. **Progression engine vs reality.** Encoded rules are from v5. Treat as v1; expect tuning. Keep override frictionless.
7. **`targetReps*` → `targetValue*` rename.** Held off; revisit if mixed-metric volume queries proliferate.

---

## Lessons-learned principles encoded into this design

1. **AIs accept framing without checking** → cross-LLM review of v1 and v2 caught real bugs (Node version, FK indexes, schema mismatches in prefill query, contradictory pain events spec, generic-not-tier-aware progression engine). Triangulating multiple reviews surfaces what any single review misses. Apply this principle to the user's training data too: progression suggestions are surfaced, never auto-applied.
2. **Confident-looking numbers can be wrong** → suggested loads display provenance ("based on last session: 284 × 3, RIR 1, +5 hit target") so user can sanity-check.
3. **Methodology matters more than output** → count sets, not exercise mentions, for volume metrics.
4. **False precision is worse than honest uncertainty** → no synthesized estimates when no history exists. Blank field, user enters.
5. **The user's read on form quality outranks log inference** → progression rules are suggestions, never auto-applied. Per-exercise `progressionPolicy` lets caution be expressed in schema.
6. **Recovery ≠ readiness** → readiness fields cut for MVP, but the schema is structured so they can be added without breaking changes.

---

## Diff summary from v2 → v2.1

**Schema changes:**
- `sets.prescribedReps` (singular int) → `prescribedRepsMin` + `prescribedRepsMax` (range, snapshotted)
- `days.alternateGroupId` (text, nullable) added
- `day_exercises.progressionPolicy` (enum, default `'standard'`) added
- `pain_events`: prose contradiction fixed (sessionId nullable consistently); CHECK constraint requires at least one of (sessionId, setId, exerciseId) non-null
- `sets`: prescribedRepsMin/Max range CHECK added
- `sets.exerciseRolePositionLoggedAtIdx`: composite now includes `position` for prefill query
- Index renamed for clarity (`sets_prefill_idx`)

**Spec rewrites:**
- Progression engine: tier-aware (MAIN top-set-driven, SECONDARY/ISOLATION all-sets-driven), with `progressionPolicy` overrides, `consecutiveBackwards` defined, warmups bypass
- Plate calc: real algorithm with v5 deadlift increment test fixture (was a stub)
- Pre-fill query: filter on `executed_load IS NOT NULL`, `executed_reps IS NOT NULL`, `sessions.ended_at IS NOT NULL`; match by `(exercise_id, set_role, position)`; return rep range and RIR
- Pipeline order of operations explicitly stated (history → engine → snap → display)

**MVP scope:**
- Sub-phased into MVP-A (logging works, ~60 hours) and MVP-B (coaching intelligence, ~80 hours)
- Total estimate: 110 → 140 hours, ±50%
- Week-1 structure documented

**Documentation:**
- CLAUDE.md / AGENTS.md: added rule about volume aggregates filtering `target_metric = 'reps'`
- Snapshot semantics explicitly state which fields are copied at session-start
- Warmup/progression interaction stated explicitly
- Cross-LLM-review pattern noted as a meta-lesson

---

## What this document is for

Read it once before starting setup. Push back on anything that feels wrong. If everything still looks right after re-read, archive `planning_v2.1.md` and start environment setup.

If this gets cross-reviewed and surfaces more catches, produce v2.2 before building. The cost of one more review pass is hours; the cost of finding bugs after seed and forms exist is days.
