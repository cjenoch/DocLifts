---
name: bug-shapes
description: Bug classes defended by tests — orphan-set failure mode, index-drift, insert-order navigation, snapshot mutation
metadata:
  type: project
---

## Bug shape 1: Snapshot mutation (Test 1)

**What:** A `prescribed_sets` row is mutated after a session is started. If `startSessionForDay` didn't copy values into the `sets` row at session-start time, re-reading the sets row would reflect the new template values rather than the values in force when the session was created.

**Test:** Updates `targetRepsMin`, `targetRepsMax`, `initialLoad` on the originating `prescribed_sets` row, re-reads the `sets` row, asserts the prescribed* columns are unchanged.

**File:** `sessions.test.ts`, describe: `'startSessionForDay: snapshot immutability after template edit'`

## Bug shape 2: Orphaned-set navigation failure (Test 2)

**What:** `nextSetIdInSession` joins through `prescribed_sets` via `prescribedSetId`. If `prescribedSetId` is NULL (e.g. from `onDelete: 'set null'` when a prescribed_sets row is deleted), the inner join drops that sets row. `findIndex` returns -1, and the function returns null rather than the true next set.

**This is a documented, accepted failure mode** (see sessions.ts lines 243-256 comment). The test pins this behavior so it can't silently change.

**File:** `sessions.test.ts`, describe: `'nextSetIdInSession: orphaned set (prescribedSetId is NULL)'`

## Bug shape 3: null initialLoad must produce null prescribedLoad (Test 3)

**What:** `initialLoad: null` on `prescribed_sets` means the template author left load unset. The prefill fallback chain is `history.executedLoad ?? initialLoad`. When both are null, `prescribedLoad` in the resulting sets row must be null — not 0, not undefined coerced to something.

**File:** `sessions.test.ts`, describe: `'startSessionForDay: null initialLoad cold start'`

## Bug shape 4: Insert-order vs. position-order navigation (Test 4)

**What:** `nextSetIdInSession` must use `ORDER BY dayExercises.position` to navigate, not insert order. With non-contiguous positions (1 and 10), and prescribed_sets for position-10 inserted before position-1, the test proves navigation follows the declared position column, not DB insertion sequence.

**File:** `sessions.test.ts`, describe: `'nextSetIdInSession: ordering with non-contiguous exercise positions (1 and 10)'`

## Bug shape 5: Prefilledloads index-drift (Test 5)

**What:** In `startSessionForDay`, `prefilledLoads[i]` and `prescribed[i]` are parallel arrays. A drift (e.g. wrong sort order on one, or a different query path) would misroute loads — exercise 1's load ends up on exercise 2's sets. Four prescribed sets at distinct loads (100, 80, 60, 40) make any mis-pairing immediately visible.

**Test:** Asserts `prescribedSetId` → `prescribedLoad` pairwise correctness for all four rows, and that all four prescription IDs are referenced exactly once.

**File:** `sessions.test.ts`, describe: `'startSessionForDay: pairwise prescribedSetId and prescribedLoad correctness across exercises'`

## Recurring reminder: blank-row poisoning

Separate from the above — already well-covered in `progression.db.test.ts` and `sessions.test.ts` (dumb-prefill block). The filter is `executed_load IS NOT NULL AND executed_reps IS NOT NULL AND sessions.ended_at IS NOT NULL`. Any new history query must apply all three.
