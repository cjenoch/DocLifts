# DocLifts — STATUS for Project Claude (PC)

**Date:** 2026-05-31  
**Branch:** `main`  
**Latest commit:** `HEAD` (resolve at read time: `git rev-parse --short HEAD`)  
**Deployment target:** `doclifts.service` on TestDev01 (`releases/current` runtime via `/usr/bin/node .`, port 3000)

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

- `5217735` — fix: poll listening check inside verify wait loop (rollback readiness race)
- `650c6ce` — docs: mark canonical systemd unit and remove superseded override script
- `b465f11` — ops: harden deploy rollback (pre-migrate pg_dump + pg_restore) and codify release-symlink unit
- `7685a34` — CI: make lint non-blocking signal until baseline formatting cleanup
- `0770b34` — progression wiring fix + reasoning snapshot + UUID hardening + schema/migration

## Current operational state

- App build and tests are green locally.
- CI + Browser CI are green on latest commit.
- Deploy converged: `doclifts.service` runs from `releases/current` (committed `deploy/doclifts.service` matches the installed host unit; superseded override script removed).
- Rollback drilled end-to-end on the host (`DOCLIFTS_DEPLOY_FAIL_AFTER_MIGRATE=1`): forced post-migrate failure restored the pre-migrate `pg_dump`, repointed `current` to the prior release, restarted, and passed readiness (`exit 91`). Session data round-tripped intact (14 → 14). Two issues surfaced and fixed during the drill: a missing NOPASSWD sudoers entry for `systemctl` (host config, see below), and a readiness-check race where the listening probe fired before the swap loop — fixed in `scripts/verify-doclifts-up.sh` (commit `5217735`).
- Migrations run only inside `deploy-safe.sh` (the live unit has no `ExecStartPre` migrate), so every migration is preceded by the pre-migrate dump. A bare `systemctl restart` never migrates.

**Host-config dependency (not in repo):** rollback requires a NOPASSWD sudoers entry for `systemctl restart/is-active doclifts.service` at `/etc/sudoers.d/doclifts`. Without it the rollback fails closed at the restart step. Required on any rebuilt host.

## Remaining follow-up (outside this delta patch set)

1. Promote CI lint from signal to blocking after repo-wide formatting baseline cleanup.
2. Optional: add explicit route-level tests for malformed UUID params returning 400.
3. Low/latent (unchanged from audit): M2 program-delete FK semantics (decide before a program-edit/delete flow ships); L2 DB CHECK constraints on enum-ish text columns; L3 `programs.updatedAt` $onUpdate; L4 post-23505 retry.

Note: item 2 from the prior list (deploy convergence + rollback re-verify) is DONE — see Current operational state.
