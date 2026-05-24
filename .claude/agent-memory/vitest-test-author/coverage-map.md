---
name: coverage-map
description: Which modules have strong coverage, which are thin, and where to focus next
metadata:
  type: project
---

## Well-covered (as of 2026-05-24)

### `src/lib/server/sessions.ts`
File: `sessions.test.ts` — 32 tests after the 2026-05-24 session.
- `startSessionForDay`: programId integrity, snapshot semantics, dumb prefill, blank-row safety, null-initialLoad cold start, pairwise prescribedSetId/load correctness
- `endSession`: stamps endedAt, idempotent, nonexistent session, does not affect other sessions
- `updateSetInSession`: happy path, empty strings → null, whitespace notes → null, 404/409/400 error paths, cross-session injection guard
- `nextSetIdInSession`: same-exercise advance, cross-exercise boundary, last-set → null, unknown setId → null, duplicate-exercise-in-day (prescribedSetId join), non-contiguous positions (1 and 10), orphaned set (prescribedSetId = NULL → null)

### `src/lib/server/progression.ts` (pure logic)
File: `progression.test.ts` — 17 tests.
- `suggestNextLoad`: policy gating (hold/cautious/standard), deload trigger, MAIN tier top-set-only, SECONDARY/ISOLATION all-sets, edge cases
- `defaultIncrement`: upper/lower body

### `src/lib/server/progression.ts` (DB-backed)
File: `progression.db.test.ts` — 22 tests.
- `getLastCompletedSet`: all history-filter invariants, excludeSessionId, position/setRole matching, cross-exercise isolation
- `computeConsecutiveBackwards`: all history-filter invariants, lookback param, cross-exercise isolation

### `src/lib/server/plates.ts`
File: `plates.test.ts` — 23 tests.
- `snapToAchievable`: barbell decomposition, snap-down behavior, custom bar weight
- `snapPerSidePlates`: machine-plate mode
- `snapForEquipment` router: all equipment types including pass-throughs

## Thin / uncovered areas

- `src/lib/server/sessions.ts` — `startSessionForDay` does NOT test: session started when a previous session for the same day is still open (concurrent session guard, if any)
- Programs duplicate-on-edit logic — no test file yet for the deep-copy-on-edit flow (CLAUDE.md §Programs duplicate-on-edit). This is a gap if that code exists.
- `src/lib/server/gym-config.ts` — not tested (hardcoded config, low risk but uncovered)
- Volume aggregates / `target_metric = 'reps'` filter — not tested yet (post-MVP per CLAUDE.md)
- SvelteKit route actions in `+page.server.ts` — thin wrappers; tested indirectly through helpers, not directly
