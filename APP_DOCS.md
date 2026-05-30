# DocLifts — Application Documentation

## Summary

DocLifts is a single-user lifting log for the gym. It encodes a structured training program (the "v5 program"), prescribes the next set's load + reps + RIR target based on history, captures executed work as you go, and preserves what was prescribed at the time even if the program template later changes. It is intentionally a personal tool, not a product — no auth, no cloud, no sharing.

The runtime model is a SvelteKit app talking to a local Postgres in Docker. The app is used on a phone at the gym via Tailscale, hitting a production build (adapter-node) served by systemd on the VM. Forms are progressively enhanced: they work as plain HTML POSTs with no JavaScript, and when JavaScript is available `use:enhance` submits them via `fetch` without a full-page reload.

---

## What it does, from the user's perspective

**Open the app at the gym.** You see a list of programs (typically one active program).

**Pick a program.** You see the program's days in order. Each day is either:
- **Startable** — no open session for that day exists. A "Start" button appears.
- **Resumable** — an open session for that day exists. A "Resume" button takes you back to it.

**Start a day's session.** The app snapshots the day's prescribed sets into the session: one row per set, frozen with the prescription that was active at session-start. Each row is prefilled with a target load (last executed load for that exercise + set role + position, or the cold-start `initialLoad` if no history exists).

**Log sets as you train.** Each set row shows: position, role (warmup / working / top / backoff), prescribed load × reps target with RIR, and the most recent completed prior set ("Last: 284 × 3 @ RIR 1"). You fill in `load`, `reps`, `RIR`, optional `notes`, and tap Save. The row turns green and shows a "logged" badge, and the view scrolls to the next set so you move down the workout without scrolling manually.

**End the session.** A sticky bottom button stamps `endedAt` and returns you to the program list. The session view becomes read-only after this.

**View a past session.** Navigate to any session URL to see what was prescribed and what you executed, no longer editable.

That's the entire flow. There is no rest timer UI, no chart, no streak counter, no goal-setting screen — by design.

---

## The v5 program model

A **program** has many **days** (e.g. "Day 1 - Upper", "Day 2 - Lower"). Days have a `position` for ordering and an optional `alternateGroupId` so two days can be presented as A/B alternates within a slot.

Each day has many **day_exercises** — one per exercise in the day's plan. Each carries:

- **Tier**: `main` | `secondary` | `isolation`. Drives progression logic.
- **Progression policy**: `standard` | `cautious` | `hold`.
  - `standard` — engine progresses linearly per tier rules.
  - `cautious` — engine holds; user must manually advance after clean sessions at low RIR. Used for right-shoulder-fragile lifts: shoulder press, DB lateral raise, band external rotations.
  - `hold` — engine never suggests progression. Used for wave-loaded lifts like deadlift, where the user inputs target directly per the wave plan.

Each day_exercise has many **prescribed_sets** — the actual rows of the workout:

- `setRole`: `warmup` | `working` | `top` | `backoff`
- `targetMetric`: `reps` or `seconds` (planks etc.)
- `targetRepsMin` / `targetRepsMax` — a range, not a single value
- `targetRir` — leftover reps after the set
- `initialLoad` — cold-start load when no history exists. **Not** the current target load.
- Rest range (min/max seconds) — captured in schema, not yet surfaced as a timer UI.

**Key design rule:** the template stores structure and cold-start, never current loads. Current loads come from history + the progression engine.

---

## Data model (Drizzle / Postgres)

Tables, in dependency order:

| Table | Notes |
|---|---|
| `programs` | Self-FK `sourceProgramId` for duplicate-on-edit lineage. `isActive` flag. |
| `days` | Belongs to a program. `position` unique within program. Optional `alternateGroupId`. |
| `exercises` | Master list. `name` unique. `equipmentType` is the dispatch key for plate snap. |
| `day_exercises` | Pivot: a day's exercises in order. Carries tier + progression policy. |
| `prescribed_sets` | Per day_exercise, structural prescription + `initialLoad`. Range rep columns. |
| `sessions` | One per workout instance. `programId` denormalized from `days.programId`. `endedAt` nullable. |
| `sets` | The actual logged rows. Snapshotted from prescribed_sets at session-start. Carries both prescribed (snapshot) and executed (user input) columns. |
| `pain_events` | Optional rows linked to a session, set, or exercise. CHECK requires at least one parent FK non-null. |

**Numeric columns** use `mode: 'number'` (loads are bounded under 1000 lb; JS-number precision is safe). **All FK columns have explicit indexes** — Drizzle does not auto-index FKs and neither does Postgres. **Position columns** have unique constraints with their parent so accidental dup-position rows fail loudly.

The `sets` table has a composite index `(exerciseId, setRole, position, loggedAt DESC)` that supports the prefill query.

---

## Core pipelines

### 1. History lookup → engine → plate snap → display

This is the locked pipeline order for any "what should I do next" question. Today (MVP-A) only the history lookup step is wired into the runtime; the other two are implemented and tested but not yet called by the action.

**History lookup** (`getLastCompletedSet`, `progression.ts`): selects the most recent `sets` row matching `(exerciseId, setRole, position)`, **always** filtered by:

```sql
WHERE executed_load IS NOT NULL
  AND executed_reps IS NOT NULL
  AND sessions.ended_at IS NOT NULL
```

This filter prevents **blank-row poisoning** — a newly-created session has pre-filled `sets` rows with NULL executed values, and a naive `ORDER BY logged_at DESC LIMIT 1` would return that empty row as "history." The filter rule applies to **every** history lookup, not just the prefill.

`getLastCompletedSet` also takes an optional `excludeSessionId` parameter. The session-view loader passes it the current session's id — otherwise, once that session ends, its own set becomes "the most recent completed" for the slot and the per-row "Last: …" line duplicates the Executed value shown right above it.

**Progression engine** (`suggestNextLoad`, `progression.ts`): pure function, no DB access. Takes executed sets + targets + policy + tier and produces a suggested raw load with a one-line reasoning string ("Suggested 290 lb (last: 284 × 3 @ RIR 1, +5 hit target)"). The engine is **tier-aware**: MAIN passes only the top set; SECONDARY / ISOLATION pass all working sets and require ALL to clear the top of the range to advance. Two consecutive backwards sessions trigger a 10% deload. Cautious and hold policies short-circuit before the deload check.

**Plate snap** (`snapForEquipment`, `plates.ts`): equipment-aware router. Dispatches to the right math based on the exercise's `equipmentType`:

| Equipment | Behavior |
|---|---|
| `barbell` | Subtract bar (44 lb), halve, snap plates per side, double back |
| `barbell-ez` | Same with EZ bar (25 lb) |
| `machine-plate` | Snap directly on per-side plate sums (no bar) |
| `machine-stack`, `cable`, `dumbbell`, `smith`, `bodyweight`, `band` | Pass-through |
| anything else | Pass-through |

The router exists because callers shouldn't have to remember which math each equipment uses. Never call `snapToAchievable` directly from the pipeline.

**Display** is the final step: the prescribed load + reps row in the UI, with provenance ("Last: 284 × 3 @ RIR 1") visible underneath — not in a tooltip, since this is information you need every set.

### 2. Session-start integrity

The `startSession` action accepts only a `dayId` from the form. The action looks up the day server-side to derive `programId` — **it never trusts a client-supplied programId**. There is no database trigger or composite FK enforcing this; application code is solely responsible. A bug here would silently route sessions to the wrong program and corrupt every subsequent history query that filters by `programId`.

The session-start helper (`startSessionForDay(db, dayId)` in `sessions.ts`) makes this structural — the function signature physically does not accept a `programId` parameter, so the invariant is enforced at compile time as well as at runtime.

### 3. Snapshot semantics

When `startSessionForDay` creates the session, it copies the day's prescribed sets into the `sets` table — one `sets` row per `prescribed_sets` row, with the same `setRole`, `targetMetric`, `position`, and rep/RIR targets. The `prescribed_set_id` is captured as an FK for traceability. After this point, editing the program template does **not** alter the past session's `sets` rows. History is append-only in effect.

### 4. Duplicate-on-edit for programs

When a program is edited (UI not built yet), the model is to **deep-copy** the program AND all child rows (`days`, `day_exercises`, `prescribed_sets`), mark the old program inactive via `isActive = false`, and let the user edit the copy. `sourceProgramId` tracks lineage. A shallow copy would create historical-mutation problems (past sessions reference rows whose meaning has changed); deep copy keeps history meaningful.

---

## Server actions

Four actions across three pages. All four extract their business logic into helpers in `$lib/server/sessions.ts` so the logic is unit-testable independent of the HTTP layer.

| Action | Page | Helper | What it does |
|---|---|---|---|
| `startSession` | `programs/[id]/+page.server.ts` | `startSessionForDay(db, dayId)` | Creates a session for a day, snapshots prescribed sets, applies dumb prefill. Returns 404 if the day doesn't exist. |
| `endSession` | `sessions/[id]/+page.server.ts` | `endSession(db, sessionId)` | Idempotently stamps `endedAt` if null. Returns `{updated: boolean}` for testability. |
| `updateSet` | `sessions/[id]/+page.server.ts` | `updateSetInSession(db, sessionId, setId, input)` | Validates input via Zod, writes one `sets` row. Returns 404 (no session), 409 (ended session, stale-tab guard), 400 (Zod fail) with field errors, or success. The UPDATE is scoped by `(setId, sessionId)` so cross-session injection silently no-ops. |
| Loaders | All three | inline | Read-only page data: programs list, program detail with open-session badges, session view with per-set history. |

---

## UI conventions

- **Dark theme** is always-on (not user-toggleable). Zinc-950 background, zinc-900 cards with zinc-800 borders, indigo accents, emerald for success states (logged, end session), amber for top-set + resume.
- **`color-scheme: dark`** is set in the base layer so native form controls (number spinners, scrollbars) also render dark on iOS/Android.
- **Inputs are 16px minimum** to prevent iOS Safari's auto-zoom-on-focus behavior. Enforced in the base layer; Tailwind `text-sm`/`text-xs` would override the 16px floor if applied to inputs, so don't.
- **Forms are progressively enhanced** via `use:enhance`. With no JavaScript they fall back to plain HTML POSTs, so a save still succeeds if scripts fail; with JavaScript, submissions go through `fetch` and the page updates without a full reload.
- **Provenance lives near the load field**, never in a tooltip. "Last: 284 × 3 @ RIR 1" is something you need to see every set.
- **Past sessions are read-only.** The session view detects `endedAt != null` and replaces editable forms with executed-value displays.
- **Numeric values use `font-mono` and `tabular-nums`** so loads and reps align column-wise across set rows.

---

## Development workflow

```bash
# First time
docker compose up -d              # Start Postgres
pnpm install
pnpm db:migrate                   # Apply schema
pnpm db:seed                      # Load v5 program

# Daily
pnpm dev                          # Vite dev for local development
pnpm redeploy                     # Build + restart the doclifts.service on the VM
                                  # (push code changes through to the gym app)
pnpm test                         # Full suite, ~10s
pnpm test --project server        # Server tests only, ~5s
pnpm check                        # Type check
```

The test suite includes a `doclifts_test` Postgres database. The test-db helper auto-creates it on first run; no manual setup is needed beyond having Docker running.

For schema changes:

```bash
pnpm db:generate                  # Generate migration SQL from schema
pnpm db:migrate                   # Apply to dev DB
```

Generated migration files in `drizzle/` are committed to the repo.

`pnpm redeploy` now runs the guarded deploy script (`scripts/deploy-safe.sh`): build → migrate → restart service → readiness verification. If migrate fails, deploy fails before restart.

---

## File conventions

- `src/lib/server/db/schema.ts` — all Drizzle table definitions
- `src/lib/server/db/seed.ts` — v5 program seed
- `src/lib/server/db/index.ts` — Drizzle client singleton
- `src/lib/server/progression.ts` — engine + history helpers
- `src/lib/server/plates.ts` — plate snap algorithms + router
- `src/lib/server/sessions.ts` — session-action helpers (startSession, endSession, updateSet)
- `src/lib/server/gym-config.ts` — single-gym hardware config (move to `gyms` table when multi-gym arrives)
- `src/lib/server/test-db.ts` — integration-test database bootstrap (not imported by production code)
- `drizzle/` — generated migration SQL (committed)
- `drizzle.config.ts` — Drizzle Kit config

DB code lives **only** under `src/lib/server`. Importing DB code from a client component is a build error and should stay that way.

---

## Out of scope (not built, by intent)

Per the locked design decisions, none of the following will be added without explicit user approval:

- Authentication or login (note: `csrf.checkOrigin` in `svelte.config.js` is currently disabled because there are no sessions to protect — if auth is ever added, it must be re-enabled)
- Cloud deployment
- AI/LLM integration in the app
- Mobile or PWA shells
- Sync between devices
- Charts or trend visualizations
- Rest-timer UI (rest **targets** in schema are fine — just no timer widget)
- Multi-gym support
- Wave-loading state machine
- Sleep / energy / readiness fields on sessions
- Gamification, social features, streaks

The "personal tool, not product" framing is locked.

---

## When in doubt

`planning_v2_1.md` and `planning_v2_2.md` in the repo root are the source of truth for design decisions. `CLAUDE.md` (single file at the repo root) encodes the same rules in a form aimed at AI coding assistants. If documentation and code disagree, fix the documentation — except for the locked architectural principles, which are intentionally non-negotiable.
