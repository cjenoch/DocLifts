# DocLifts Reliability Follow-ups — Closeout Report (2026-05-30)

Head commit: `c50cc95`  
Branch: `main`

## Executive status
All requested must/should tasks in the work order are now implemented and verified with local gates and CI artifacts.

---

## Task 1 — README CI claim corrected ✅
**Commit**
- `873e931` — `ci: add browser workflow with playwright cache and fix README claims`

**Result**
- README no longer claims full suite runs in primary CI.
- README now reflects:
  - server/data suite on push in `ci.yml`
  - browser tests in dedicated Browser CI workflow.

---

## Task 2 — deploy-safe fail-closed ✅
**Evidence in script**
- `scripts/deploy-safe.sh` starts with `set -euo pipefail`.
- Added forced-failure gate after migrate:
  - `DOCLIFTS_DEPLOY_FAIL_AFTER_MIGRATE=1` exits with `91`.

**Verification run**
- Command: `DOCLIFTS_DEPLOY_FAIL_AFTER_MIGRATE=1 bash scripts/deploy-safe.sh 5`
- Observed: build + migrate ran, then forced exit `EXIT:91`
- Confirmed: restart/active/HTTP verify steps did not run.

---

## Task 4 — browser tests restored in CI without hang ✅
**Commits**
- `873e931` — adds `browser.yml`
- `61269dc` — run browser workflow in Playwright container
- `c50cc95` — isolate server/client vitest invocations cleanly

**Final approach**
- Dedicated Browser CI workflow (`.github/workflows/browser.yml`)
- Uses `mcr.microsoft.com/playwright:v1.59.1-noble`
- Runs: `pnpm run test:unit --project client`
- Main CI stays fast server gate.

**Verification**
- Browser CI success: https://github.com/cjenoch/DocLifts/actions/runs/26681734925
- Main CI success: https://github.com/cjenoch/DocLifts/actions/runs/26681734937

---

## Task 5 — centralized soft-delete guard across write paths ✅
**Commit**
- `512f708` — `feat: add trash restore/purge and centralize session delete guards`

**Centralized guard helper**
- `loadSession(db, id, mode)` in `src/lib/server/sessions.ts`
  - modes: `active`, `ended-active`, `deleted-only`, `any`

**Write-path routing now through shared helper layer**
- `endSession`
- `updateSetInSession`
- `softDeleteEndedSession`
- `restoreSoftDeletedSession`
- `hardDeleteSession`
- `purgeDeletedSessionsForProgram`

**Route wiring**
- `src/routes/sessions/[id]/+page.server.ts`
- `src/routes/programs/[id]/+page.server.ts`

---

## Task 6 — 14-day consistency excludes abandoned/deleted ✅
**Commit**
- `512f708`

**Result**
- Consistency query in `src/routes/reports/+page.server.ts` excludes:
  - open/abandoned sessions (`endedAt IS NULL`)
  - soft-deleted sessions (`deletedAt IS NOT NULL`)

**Tests**
- Regression coverage added in `src/lib/server/progression.db.test.ts`.

---

## Task 7 — Trash view + Restore ✅
**Commit**
- `512f708`

**Result**
- Added Trash UI in `src/routes/programs/[id]/+page.svelte`
- Deleted sessions appear in Trash only
- Restore action clears `deletedAt` and returns sessions to active views
- Uses centralized session helper paths.

---

## Task 8 — Permanent delete + Empty Trash ✅
**Commit**
- `512f708`

**Result**
- Added permanent delete action (high-friction confirm)
- Added purge-trash action (typed confirmation + expected count check)
- Single privileged hard-delete path used by both actions.

**Cascade verification**
- FK `sets.sessionId -> sessions.id` is `onDelete: 'cascade'` in schema.
- Test verifies hard delete leaves no orphaned set rows.

---

## Local verification outputs ✅
Latest successful local run:
- `pnpm run test:unit --project server` (114 passed)
- `pnpm run test:unit --project client` (1 passed)
- `pnpm run check` (0 errors, 0 warnings)
- `pnpm run build` (success)

---

## Final CI artifacts ✅
- Main CI (server gate): https://github.com/cjenoch/DocLifts/actions/runs/26681734937
- Browser CI (browser gate): https://github.com/cjenoch/DocLifts/actions/runs/26681734925

---

## Scope/discrepancy notes
- During closeout, `pnpm test --project ...` produced cross-project side effects in CI depending on script wiring.
- Resolved in `c50cc95` by isolating workflow commands to `pnpm run test:unit --project <server|client>` and making `test:unit` explicitly `vitest --run`.

No threat-model deviations were introduced (single-user/Tailscale/no-auth posture preserved).
No soft-delete safety was relaxed; destructive paths use high-friction confirmations.

---

## Commit summary (closeout-relevant)
- `512f708` feat: add trash restore/purge and centralize session delete guards
- `873e931` ci: add browser workflow with playwright cache and fix README claims
- `61269dc` ci: run browser project in Playwright container and keep pnpm test script
- `c50cc95` ci: isolate server/client vitest projects across workflows

(Intermediate CI tuning commits also exist in history: `ebc1a42`, `466d10c`.)
