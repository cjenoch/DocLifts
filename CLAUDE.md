# Project rules for AI coding assistants

This file is read by Claude, Cursor, and other AI coding tools when working in this repo. Decisions encoded here are locked from planning v2.2. Do not deviate without explicit user approval.

## Stack

- **Framework:** SvelteKit (Svelte 5)
- **Runtime:** Node 24 LTS
- **Database:** PostgreSQL 16, self-hosted in Docker for dev
- **ORM:** Drizzle (TypeScript-native, SQL-shaped)
- **Forms:** plain HTML POSTs to SvelteKit server actions, Zod-validated server-side.
- **Styling:** Tailwind CSS
- **Formatter:** Prettier (with `prettier-plugin-svelte` and `prettier-plugin-tailwindcss`). Config in `.prettierrc`: tabs, single quotes, no trailing commas, 100-char print width.
- **Testing:** Vitest
- **Package manager:** pnpm

TypeScript strict mode is non-negotiable.

## Svelte conventions

- Use **Svelte 5 runes** (`$state`, `$derived`, `$effect`, `$props`). Do NOT use legacy `$:` reactive labels or Svelte 4 component syntax. LLM training data mixes Svelte 4 and 5 patterns; default to 5.
- Use **SvelteKit server actions** (`+page.server.ts`) for form submissions unless there's a strong reason not to.
- DB code lives **only** under `src/lib/server`. Importing DB code from a client component is a build error and should stay that way.
- Use `+page.server.ts` for server-only code, not `+page.ts`.

## Architectural principles (DO NOT BREAK)

These are locked from planning v2.1/v2.2 and reflect substantive design decisions, not preferences.

### Snapshot semantics

- Past sessions preserve what was prescribed at the time. History is append-only and immutable in effect.
- When a session starts, prescribed values (`prescribed_load`, `prescribed_reps_min`, `prescribed_reps_max`, `prescribed_rir`, `set_role`, `target_metric`) are copied from `prescribed_sets` into the `sets` row. Once written, they don't change — even if the program template is later edited.

### Programs are duplicate-on-edit, not mutate-in-place

- Editing a program **deep-copies** the program AND all child rows (`days`, `day_exercises`, `prescribed_sets`), marks the old program inactive, user edits the copy.
- A shallow copy would create historical-mutation problems. Always deep copy children.
- `programs.sourceProgramId` (self-FK, nullable) tracks lineage.

### History lookups always filter incomplete data

**All** history lookups — dumb prefill in MVP-A, smart prefill in MVP-B, `consecutiveBackwards` calculation, history views — use these filters:

```sql
WHERE executed_load IS NOT NULL
  AND executed_reps IS NOT NULL
  AND sessions.ended_at IS NOT NULL
```

The blank-row poisoning bug is real: pre-created session rows with null executed values can be returned as "history" by naive `ORDER BY logged_at DESC LIMIT 1` queries. Don't reintroduce it. (See planning v2.2 §3.)

### No prescribed loads in the program template

- `prescribed_sets` stores **structure** (set roles, rep ranges, rest, tier) and `initialLoad` (cold-start only).
- Current target loads come from history + progression engine, not from the template.
- Don't add a "current load" column to `prescribed_sets`.

### Pre-fill query match key

- Match by `(exercise_id, set_role, position)`, not just `(exercise_id, set_role)`.
- Position matters because two-working-set exercises have different intents at different positions (set 1 RIR 3 vs set 2 RIR 1).

### Progression engine is tier-aware

- **MAIN**: top-set-driven. Pass only the top set to `suggestNextLoad`.
- **SECONDARY / ISOLATION**: all-sets-driven. Pass all working sets. The rule requires ALL sets to clear top of range before advancing.
- **Warmups DO NOT use the progression engine.** Warmups always use `initialLoad` from the template.

### `consecutiveBackwards` is computed from executed outcomes

- NOT from prior suggestions. User overrides are first-class; suggestion history doesn't reflect what actually happened.
- MVP simplification: load-only check (no reps/RIR clearance inspection). See `progression.ts` `computeConsecutiveBackwards()` comment for tightening path.
- **MVP-A does NOT wire this function in.** MVP-A prefill is dumb: last completed `executed_load` (filtered per the history-filter rule above) or `initial_load` if no history exists. `computeConsecutiveBackwards` and the full progression engine are MVP-B work.

### Session-start integrity: `programId` from day, never from client

- The server action that creates a session MUST compute `programId` by looking up the chosen day row, NEVER trust a client-supplied `programId`.
- The DB stores `sessions.programId` as a denormalization of `days.programId` for query convenience. There is no trigger or composite FK enforcing the invariant — application code is solely responsible.
- A bug here corrupts the history filter (queries by program_id will silently return wrong sessions), and you won't notice until you're looking at trends weeks later.

### Progression policy taxonomy

- `'standard'` — default. Engine progresses linearly per tier rules (top set + bump, all sets clear + bump).
- `'cautious'` — engine holds load; user must manually advance after 2-3 clean sessions at RIR 0-1. Used for shoulder press, DB lateral raise, band external rotations (right-shoulder fragility per v5 hard rules).
- `'hold'` — engine never suggests progression. Used for **wave-loaded lifts** (deadlift) where the engine's linear progression is wrong every wave-shift week. User inputs target directly per the wave plan.

### Pipeline order

```
history lookup → progression engine → plate snap → display
```

This order is locked. The engine produces an ideal raw load; plate snap reduces to physical reality. Never snap before the engine — you'd snap a stale value, then the engine would propagate snap rounding.

### Plate snap is equipment-type-aware — use the router

The pipeline calls **`snapForEquipment(load, equipmentType)`**, not `snapToAchievable` directly. The router dispatches to the correct math:

| `equipmentType`     | Snap behavior                                                  |
|---------------------|---------------------------------------------------------------|
| `barbell`           | Subtract bar (44 lb), halve, snap plates per side, double back |
| `barbell-ez`        | Same as barbell with EZ bar weight (25 lb)                     |
| `machine-plate`     | Snap directly on per-side plate sums (no bar)                  |
| `machine-stack`     | Pass-through (load IS the displayed value)                     |
| `cable`             | Pass-through                                                   |
| `dumbbell`          | Pass-through (post-MVP could snap to gym DB inventory)         |
| `smith`             | Pass-through                                                   |
| `bodyweight`        | Pass-through                                                   |
| `band`              | Pass-through                                                   |
| (anything else)     | Pass-through                                                   |

Never call `snapToAchievable` directly from the pipeline. Always go through the router. (See planning v2.2 artifact-review patches.)

### Engine output is suggestion, never auto-applied

- The user override path is one tap. Never bake a load into the prescribed field without giving the user an editable surface.
- Show provenance on every suggested load: "Suggested 290 lb (last: 284 × 3, RIR 1, +5 hit target)."
- Provenance goes near or under the load field, NOT in a tooltip. Tooltips are for things you don't need to see; provenance you need every session.

## Schema discipline

- Volume aggregates (when added post-MVP) MUST filter `target_metric = 'reps'` to avoid mixing planks (seconds) into weight × reps math.
- All position columns have UNIQUE constraints with their parent (program × day_position, day × exercise_position, day_exercise × set_position).
- All FK columns have explicit indexes declared. Drizzle does NOT auto-index FK columns; Postgres doesn't either.
- All numeric columns use `mode: 'number'`. JS-number precision is safe for load weights bounded under 1000 lbs.
- `pain_events` requires at least one of (sessionId, setId, exerciseId) non-null via CHECK constraint.

## Out of scope (do NOT add without user approval)

- Authentication or login flows
- Cloud deployment
- AI/LLM integration in the app itself
- Mobile or PWA
- Sync between devices
- Advanced charting dashboards beyond the current Reporting v1 (consistency + trend bars already shipped)
- Rest timers (UI; rest **targets** in schema are fine)
- Multi-gym support
- Wave loading state machine
- Sleep / energy / readiness fields on sessions
- Gamification, social features, or streaks

If the user asks for any of these, confirm before building. The "personal tool, not product" framing is locked.

## File conventions

- `src/lib/server/db/schema.ts` — all Drizzle table definitions
- `src/lib/server/db/seed.ts` — v5 program seed
- `src/lib/server/db/index.ts` — Drizzle client singleton
- `src/lib/server/progression.ts` — engine + history helpers
- `src/lib/server/plates.ts` — plate snap algorithms + router
- `src/lib/server/sessions.ts` — action helpers (`startSessionForDay`, `endSession`, `updateSetInSession`). The route `+page.server.ts` files are thin wrappers around these.
- `src/lib/server/gym-config.ts` — single-gym hardcoded config (move to `gyms` table when multi-gym arrives)
- `src/lib/server/test-db.ts` — integration-test DB bootstrap. Not imported by production code.
- `scripts/backup-db.sh` — daily `pg_dump` to `~/backups/doclifts/`, 30-day rotation. Installed in user crontab (`0 3 * * *`). Cron log at `~/backups/doclifts/cron.log`.
- `drizzle/` — generated migration files (committed to repo)
- `drizzle.config.ts` — Drizzle Kit config

## When in doubt

Re-read this `CLAUDE.md` file in the repo root. It is the source of truth for locked decisions and assistant operating constraints in this codebase.
