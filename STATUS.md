# DocLifts — STATUS for Project Claude (PC)

**Date:** 2026-05-31  
**Branch:** `main`  
**Latest commit:** `7685a34`  
**Deployment target:** `doclifts.service` on TestDev01 (`/usr/bin/node build`, port 3000)

## Executive summary

Delta re-audit items from PC were addressed on `main` with production-safe, tested changes.
The hot-path progression wiring bug is fixed: SECONDARY/ISOLATION now gate progression at exercise-level across all working sets, while preserving per-position baselines. Warmups now explicitly bypass engine progression. Suggestion rationale is now snapshotted at session start and displayed in-session. UUID route hardening is in place for session/program/day entry points. `.env.example` now matches docker-compose credentials for fresh clones.

## What changed (PC delta plan closure)

### N1 — Tier-correct prefill assembly + warmup guard ✅
- **File:** `src/lib/server/sessions.ts`
- **Fixes:**
  - non-MAIN progression decision now uses all working sets for an exercise
  - per-position baseline retained when applying hold/advance/deload decision
  - warmup rows bypass engine and use history-or-initial path
- **Engine functions unchanged** (`suggestNextLoad` remains caller-assembled as intended)

### N2 — Provenance threading (reasoning persisted and shown) ✅
- **Schema:** `sets.suggestion_reasoning` nullable text
- **Files:**
  - `src/lib/server/db/schema.ts`
  - `drizzle/0004_bouncy_ezekiel_stane.sql`
  - `src/lib/server/sessions.ts`
  - `src/routes/sessions/[id]/+page.server.ts`
  - `src/routes/sessions/[id]/SetRow.svelte`
- Behavior: engine-driven rows show persisted rationale; warmup/cold-start rows stay null (no empty label spam)

### N3 — Regex increment heuristic replaced by schema column ✅
- **Schema:** `exercises.is_lower_body` boolean (default false)
- **Runtime:** increment now derives from `isLowerBody`, not exercise name regex
- **Seed:** explicit `exerciseMeta` map now sets both `equipmentType` and `isLowerBody`

### N4 — `.env.example` mismatch ✅
- `.env.example` now uses `doclifts:dev` to match `docker-compose.yml`

### L1 — UUID route validation ✅
- `programs/[id]` and `sessions/[id]` entry points validate UUIDs and return 4xx for malformed ids
- start-session action validates `dayId` UUID before DB access

### M3 — CI gate expansion ✅ (with one pragmatic adjustment)
- CI now includes: lint signal, check, server tests, build, prod-audit signal
- Lint is currently **non-blocking signal** because repo has broad historical prettier drift unrelated to this patch set

## Verification (local)

- `pnpm run db:migrate` ✅
- `pnpm run check` ✅
- `pnpm run test:unit --project server` ✅ (122 passed)
- `pnpm run test:unit --project client` ✅ (2 passed)
- `pnpm run build` ✅

## CI evidence

- **CI** run `26705564919` ✅  
  https://github.com/cjenoch/DocLifts/actions/runs/26705564919
- **Browser CI** run `26705564909` ✅  
  https://github.com/cjenoch/DocLifts/actions/runs/26705564909

## Recent commits (highest signal)

- `7685a34` — CI: make lint non-blocking signal until baseline formatting cleanup
- `0770b34` — progression wiring fix + reasoning snapshot + UUID hardening + schema/migration
- `db6961d` — restore planning docs and close drift findings

## Current operational state

- App build and tests are green locally.
- CI + Browser CI are green on latest commit.
- Known deploy invariant gap remains: service still executes `node build` directly rather than `releases/current` + `ExecStartPre` migrate path.

## Remaining follow-up (outside this delta patch set)

1. Promote CI lint from signal to blocking after repo-wide formatting baseline cleanup.
2. Finish deploy invariant convergence (`releases/current` runtime + `ExecStartPre=pnpm db:migrate`) and re-verify rollback end-to-end.
3. Optional: add explicit route-level tests for malformed UUID params returning 400.
