# DocLifts — STATUS for Project Claude (PC)

**Date:** 2026-05-30  
**Branch:** `main`  
**Latest commit:** `9bc7093`  
**Deployment target:** `doclifts.service` on TestDev01 (`/usr/bin/node build`, port 3000)

## Executive summary

DocLifts is currently healthy in production and green in CI. The immediate production instability (stale-chunk 500s) was mitigated and service recovered. Browser CI is restored to a deterministic container-based flow. Front-page program listing now correctly shows only the active Sunrise program after deactivating duplicate Reports fixture programs in DB.

## Verified current state

- **Service:** `doclifts.service` active/running and listening on `0.0.0.0:3000`
- **Local health probe:** `curl http://127.0.0.1:3000/` returns **HTTP 200**
- **Front page data:** only `Sunrise Center 4-Day Program v5` appears
- **Reports fixture cleanup:** `Reports Program` rows set `is_active=false` (2 rows)

## Local quality gates (latest run)

- `pnpm run check` ✅
- `pnpm run test:unit --project server` ✅ (118 passed)
- `pnpm run test:unit --project client` ✅ (3 passed)
- `pnpm run build` ✅

## CI evidence (latest)

- **CI** run `26689459997` ✅  
  https://github.com/cjenoch/DocLifts/actions/runs/26689459997
- **Browser CI** run `26689459993` ✅  
  https://github.com/cjenoch/DocLifts/actions/runs/26689459993

## Recent high-signal commits

- `a4f5b5f` — deploy-safe fail-closed + atomic release flow + docs/env sync
- `527b1ae` — centralized program-scoped deleted-session guards + consistency test
- `cd0ab99` — browser workflow + SetRow browser tests
- `4f90736` — playwright lockfile-version extraction fix
- `bdb9247` — restore stable browser workflow + status refresh
- `3272aae` — temporary home filter to hide non-Sunrise programs
- `9bc7093` — remove temporary home filter after DB deactivation cleanup

## Documentation audit (requested)

I re-checked documentation updates against current code and runtime:

- **README.md**: broadly aligned with current split CI model and pnpm usage. ✅
- **CLAUDE.md**: aligned with locked architecture constraints and current implementation direction. ✅
- **APP_DOCS.md**: corrected one stale statement claiming progression/snap were not runtime-wired; now reflects current runtime prefill pipeline wiring. ✅
- **STATUS.md**: fully refreshed (this file) to replace stale historical narrative with current operator handoff truth. ✅

## Known follow-ups (not blockers for current operation)

1. **Systemd runtime path invariant not yet fully adopted**  
   Deploy script manages `releases/current`, but `doclifts.service` still uses `ExecStart=/usr/bin/node build`. This is operationally working, but not yet the stronger invariant path documented for release symlink runtime.

2. **Historical journal docs contain old timeline details**  
   `journal/*.md` still includes historical notes (expected) and should be treated as chronology, not live runbook truth.

## Operator notes for PC

- Current prod is up and serving.  
- CI + Browser CI are both green on latest push.  
- Program list issue is fixed at data layer (fixtures deactivated), not permanently hardcoded in app query logic.
- If next step is hardening deploy invariants, prioritize migrating systemd `ExecStart` to `releases/current` with `ExecStartPre=pnpm db:migrate` drop-in and re-verify rollback path end-to-end.
