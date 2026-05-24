---
name: infra-patterns
description: DB bootstrap, seedProgram helper, resetTestDb, file conventions, and test count baseline
metadata:
  type: project
---

## Test infrastructure

- `setupTestDb()` in `src/lib/server/test-db.ts` — connects to `doclifts_test`, auto-creates it if absent, runs migrations. Returns `{ db, client, end }`. Call once in `beforeAll`.
- `resetTestDb(client)` — TRUNCATEs all app tables with CASCADE. Call in `beforeEach` for a clean slate. Order: pain_events, sets, sessions, prescribed_sets, day_exercises, days, programs, exercises.
- No transaction-rollback pattern — the project uses truncate-per-test.
- `db` type is `TestDb = PostgresJsDatabase<typeof schema>`.

## seedProgram helper

Defined inside `sessions.test.ts` (not a shared module). Returns `ProgramFixture`:
```ts
{ programId, dayId, dayExerciseId, exerciseId, prescribedSetId }
```
Options: `{ programName?, exerciseName?, initialLoad?, tier? }`. Default `initialLoad: 100`, default tier `'main'`, default targetRepsMin/Max: 3/5. Builds: program → day (position 1) → exercise → dayExercise (position 1) → 1 prescribedSet (position 1, setRole 'top').

If you need multiple exercises or non-standard positions, build raw inserts inline (that's what all the multi-exercise tests do).

## File locations

- Unit tests (no DB): `src/lib/server/*.test.ts` co-located with source
- DB integration tests: also `*.test.ts` — `sessions.test.ts`, `progression.db.test.ts`
- The `--project server` filter runs all five test files

## Test count baseline (as of 2026-05-24)

- Pre-existing: 93 tests across 5 files
- After adding 5 new tests (+ 1 bonus sub-case): 99 tests total
- Run time: ~8-10s total; DB tests ~5s

## Vitest config note

Run via `pnpm test --project server`. The pnpm script calls `vitest --run --project server`. The `--reporter=verbose` flag shows per-test results.

**Why:** Single test DB — if a second DB integration test FILE is added, force server-project file serialization or scope each to its own DB (comment in test-db.ts).
