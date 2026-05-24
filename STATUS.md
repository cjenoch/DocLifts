# DocLifts — Status & Handoff Summary

**Date:** 2026-05-24 · **Branch:** `main` · **Tests:** 88 passing

## What this is

DocLifts is a personal lifting log built as a SvelteKit + Drizzle + Postgres app. It tracks training sessions structured around the v5 program: programs → days → exercises (with tier + progression policy metadata) → prescribed sets → executed sets. History is append-only in effect; snapshot semantics copy prescribed values from the template into the `sets` table at session-start, so past sessions preserve what was prescribed at the time even if the template is later edited.

The app is built for personal use only — Chris uses it on his phone at the gym via Tailscale, hitting a production build (adapter-node) served by systemd on the VM. Real-use rollout begins **Tuesday 2026-05-27**.

## Current state (2026-05-24)

- **Schema + migrations:** stable. Single migration in `drizzle/`.
- **Seed:** v5 program seeded with cautious progression policy on shoulder-fragility lifts.
- **Server actions:**
  - `startSession` (programs/[id]) — creates session, snapshots prescribed sets, applies dumb prefill (last executed load OR `initialLoad`).
  - `endSession` and `updateSet` (sessions/[id]) — stamps `endedAt` idempotently, edits one set per submit with Zod validation and a stale-tab guard (409 on ended sessions).
- **UI:** dark zinc/indigo palette, thumb-driven entry on iPhone 12 (16px input font to suppress iOS Safari auto-zoom). Past sessions are read-only; editable rows only while the session is open.
- **End-to-end dry run completed** via Playwright against the prod build — full flow works, persistence holds, read-only past view renders correctly. After the adapter-node deploy (2026-05-24), drove `startSession` → `updateSet` → reload via curl against the live systemd service: all four executed fields persisted exactly, hostile-Origin probe confirmed CSRF off as designed, Zod validation rejected garbage with structured field errors. The manual iPhone Safari input check (typed load differing from prefill persists after save) was run against the **dev server** and passed — but **not** yet against the adapter-node production build on port 3000, which is the artifact going live and so far only curl-verified. See Known gaps.
- **MVP-A** behavior throughout — dumb prefill only, no progression engine wired in, no plate snap applied at runtime (both are implemented and tested, deliberately deferred to MVP-B per planning).

## Test coverage (88 server tests)

| File | What it covers |
|---|---|
| `progression.test.ts` | Pure-function engine: tier branches (MAIN top-set, SECONDARY/ISOLATION all-sets), policy gating, 10% deload + 0.5 lb rounding, edge cases. |
| `plates.test.ts` | `snapForEquipment` router, `snapToAchievable`, `snapPerSidePlates`, round-trip on every v5 deadlift increment, EZ-bar path. |
| `progression.db.test.ts` | History-filter rule: defends the **blank-row poisoning** regression class called out in planning v2.2 §3. Covers `getLastCompletedSet` + `computeConsecutiveBackwards`, including the `excludeSessionId` path so a past-session view doesn't pull its own row as "last." |
| `sessions.test.ts` | Session-start integrity (programId derived from day, never client), snapshot semantics, dumb prefill, endSession idempotency, updateSet 404/409/400 paths, cross-session injection no-op. |

DB tests share one `doclifts_test` database; `vite.config.ts` forces server file serialization to avoid races on the `exercises.name` unique constraint. The test-db helper auto-creates the DB + applies migrations on first run.

## Architectural principles (locked from planning v2.1 / v2.2)

These are non-negotiable without explicit user approval. Full text with rationale is in `CLAUDE.md` (single file at repo root — the duplicate at `src/lib/server/CLAUDE.md` was removed).

- **Snapshot semantics** — prescribed values copy into `sets` at session-start and don't change if the template is later edited.
- **Programs are duplicate-on-edit**, not mutate-in-place. Edits deep-copy program + days + day_exercises + prescribed_sets, mark the old one inactive, `sourceProgramId` tracks lineage.
- **History lookups always filter incomplete data** — `executed_load IS NOT NULL AND executed_reps IS NOT NULL AND sessions.ended_at IS NOT NULL`. Blank-row poisoning is a real bug class.
- **No prescribed loads in the template** — `prescribed_sets` has `initialLoad` (cold-start only). Current loads come from history + engine.
- **Engine is tier-aware** — MAIN top-set-driven, SECONDARY/ISOLATION all-sets-driven. Warmups bypass the engine.
- **Session-start integrity** — `sessions.programId` is derived from `days.programId`; never trust a client-supplied value. Application-enforced (no DB trigger or composite FK).
- **Pipeline order** — `history → engine → plate snap → display`. Plate snap always goes through `snapForEquipment(load, equipmentType)`.

## Known gaps before rollout

| Priority | Gap |
|---|---|
| Medium | **Real-device check against the production build** still pending. The manual iPhone Safari input check passed against the dev server, but the build going live (adapter-node, port 3000) is a different artifact and has only been curl-verified. Before rollout: open `http://testdev01:3000` on the iPhone, log a full set, confirm it renders and persists. |
| Medium | **Two stale open sessions** sit in the DB, showing as "Resume" in the program list. End or delete them before the first real workout — otherwise starting a day that has a stale session shows "Resume" instead of "Start." |
| Low | **`pnpm redeploy` does not run migrations.** Harmless today (no pending schema change); but once MVP-B touches the schema, a redeploy without `pnpm db:migrate` leaves the running code expecting a schema the DB lacks. Chain `pnpm db:migrate &&` into redeploy before then. |
| Medium | `snapForEquipment` is tested but **not wired into the runtime pipeline**. Cold-start `initialLoad` shows unsnapped at the gym. Not a crash, just mental plate math. |
| Medium | Progression engine (`suggestNextLoad`) tested but not wired in. MVP-A is dumb prefill only — intentional per planning, becomes MVP-B work. |
| Low | Pain event UI doesn't exist. Schema does. Either build a one-button "log pain" affordance, or accept paper. |

**Resolved this session:**
- DB backup gap (was high priority) — daily `pg_dump` cron now writes gzipped dumps to `~/backups/doclifts/` with 30-day rotation. First backup verified.
- Backup restore drill (was low priority) — restored the 2026-05-24 dump into a throwaway `doclifts_restore_test` DB on 2026-05-24, all 8 application tables matched live row counts, spot-checks confirmed program/day/session/set data intact. Backup is verifiably restorable.
- **`nextSetIdInSession` join correctness** — comment hardening over three review passes (commits `a85c0ee`, `217f44e`); also re-verified end-to-end in production via the redirect-fragment in the verify run.
- **Gym deploy moved off `pnpm dev`** (was Low priority) — production build via `@sveltejs/adapter-node`, served by `doclifts.service` systemd unit on port 3000. CSRF origin check disabled for the single-user Tailscale threat model (re-enable on adding auth). Verified end-to-end. Commit `a9b3f6f`.

## Recent work this session

1. **Dark mode + modern UI** (`46f17a9`) — zinc/indigo palette, subtle borders + accent glows, 16px input floor to prevent iOS Safari auto-zoom on focus.
2. **Pure-function tests** (`752f0a4`) — progression engine + plate snap router. 44 tests, run in ms.
3. **DB integration tests for the history filter** (`257f055`) — blank-row poisoning regression coverage. Added `test-db.ts` helper that auto-bootstraps `doclifts_test`.
4. **Session-start helper + tests** (`fb816b6`) — extracted action body into `startSessionForDay(db, dayId)`; the signature itself enforces the integrity invariant (no `programId` parameter).
5. **endSession + updateSet helpers + tests** (`5c16e3c`) — same playbook. Covers the actions hit dozens of times per real session, including the cross-session injection no-op.
6. **CLAUDE.md dedup + stack fixes** (`7a25cb4`) — removed the byte-identical copy at `src/lib/server/CLAUDE.md`; corrected the Stack section (Prettier not Biome; plain HTML POSTs + server-side Zod, not superforms); added `sessions.ts` and `test-db.ts` to the file conventions list.
7. **End-to-end dry run** via Playwright at iPhone 12 viewport. Found and fixed one bug: the past-session view duplicated "Last: …" with "Executed: …" because `getLastCompletedSet` was returning the just-ended session's own row.
8. **"Last:" duplication fix** (`41f4429`) — `getLastCompletedSet` now accepts an optional `excludeSessionId`; the session-view loader passes the current session id. Two new tests cover the exclusion behavior. Re-verified visually in the browser.
9. **`nextSetIdInSession` comment hardening** (`a85c0ee`, `217f44e`) — softened a "1:1 by construction" overclaim into a named failure mode (nullable FK orphan → innerJoin drops the set → `findIndex` misses → scroll to top instead of advancing). Three sequential code-review passes; reviewer's polish taken because the comment is load-bearing context for future LLM-assisted edits in this area.
10. **Switch gym deploy to adapter-node + systemd** (`a9b3f6f`) — autostart was `pnpm dev`; now it's a built adapter-node artifact (`node build`) under `doclifts.service` with `EnvironmentFile=.env` for `DATABASE_URL`. Added `pnpm redeploy` script (build + restart). Disabled `csrf.checkOrigin` (single-user / Tailscale / no auth — `svelte.config.js` carries the re-enable trigger comment).

The verify run also surfaced a "1 of 5 sets had wrong value" finding which on further investigation turned out to be a Playwright/Chromium mobile-emulation artifact (input.value silently reverts to the prefill on number inputs when `isMobile: true, hasTouch: true`). Confirmed not reproducible in desktop context or in production build, so not a real-app concern. Real Mobile Safari on the iPhone is a different rendering engine and won't behave this way. The subsequent real-device check on the dev server confirmed correct saves with no value reversion, consistent with an emulation-only artifact; the equivalent check on the production build is the remaining loop-closer (see Known gaps).

## File map

```
src/lib/server/
  db/
    schema.ts          # Drizzle tables (v2.2 schema)
    seed.ts            # v5 program seed
    index.ts           # Drizzle client singleton
  gym-config.ts        # Single-gym hardware config (bars, plates)
  plates.ts            # Plate snap math + equipment router
  progression.ts       # Engine + history helpers
  sessions.ts          # Action helpers: startSessionForDay, endSession, updateSetInSession
  test-db.ts           # Integration-test DB bootstrap
  *.test.ts            # Unit + integration tests (5 files)

src/routes/
  +page.svelte         # Programs list
  programs/[id]/       # Program detail + startSession action (thin wrapper around sessions.ts)
  sessions/[id]/       # Session view + endSession/updateSet actions (thin wrappers)
  layout.css           # Tailwind + base dark theme (incl. 16px input floor)

drizzle/               # Migration SQL (one migration)
docker-compose.yml     # Postgres 16 for dev
CLAUDE.md              # Rules for AI assistants (single file at repo root)
planning_v2_*.md       # Source of truth for design decisions
```

## Commands worth knowing

```bash
pnpm dev                  # Vite dev server (allowedHosts includes .ts.net + testdev01)
pnpm redeploy             # Build + restart doclifts.service (does NOT migrate — run pnpm db:migrate first after a schema change)
pnpm test                 # Full suite (both projects, ~10s)
pnpm test --project server   # Server only (~5s)
pnpm check                # svelte-check / TypeScript
pnpm db:migrate           # Apply migrations to dev DB
pnpm db:seed              # Apply v5 program seed
```
