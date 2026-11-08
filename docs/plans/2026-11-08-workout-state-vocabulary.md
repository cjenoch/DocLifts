# Implicit state machines → one workout-state vocabulary

**Date:** 2026-11-08 · **Audited at:** `main` @ `03c9335` (0.20.0 Alpha) ·
**Status:** plan, not started · **Author:** Project Claude (audit + plan) ·
**Executes:** coding bot (Hermes/Codex) · **Reviews:** adversarial review bot ·
**Decides:** Chris (three owner decisions in §5 must be answered before Phase 1 ships)

How this is used on a phone: nothing in Phase 1 changes what the owner sees at
the gym. Phase 2 removes two controls the server already refuses and one the
server wrongly accepts. Phase 3 is a database constraint and needs a
migration rehearsal.

---

## 1. What was found

An implicit state machine is a lifecycle the code depends on but never names:
the state is derived at every use from nullable columns, booleans, FK
presence or a join, and the transitions are scattered functions with their
own guards. Nineteen were found. Counts are non-test `src/` sites that
re-derive the predicate, from grep, verified by reading.

| # | Entity | How state is encoded | Sites | Representable-but-invalid (no constraint) | Hot path? |
|---|---|---|---|---|---|
| 1 | **Session** open / ended / trashed / gone (+ "ended but editable" via `?edit=1` echoed as a client hidden field) | `ended_at` NULL?, `deleted_at` NULL? — 3 spellings (Drizzle `isNull`, raw `` sql` ` ``, JS truthiness) | **87** (69 server, 18 UI) | open+trashed (tests create it: `sessions.test.ts:287`); restore of such a row collides with `sessions_one_open_per_day` with no catch | **yes** |
| 2 | **Set** untouched / touched / completed | `executed_load/reps/rir`, `notes` NULL? — **2 variants of "touched"** (`workout-to-program.ts:42` omits `notes`) and **3 of "completed"** (`picker.ts:157` load-only; `exports/formats.ts:250` adds `reps > 0`) | **25** | load-only, reps-only, notes-only rows: "touched" for swap/bind gates, "not completed" for history, "Ready" in SetRow, "logged" in ExerciseMenu | **yes** |
| 3 | **Block** planned / free / bound / photo-unidentified / photo-identified / added / swapped-today / swapped-forever | `gym_equipment_id` NULL?, `load_convention`, `prescribed_set_id` NULL?, join to `exercises.canonical_movement='unidentified-machine'`, join to `equipment_photos.status`; read-time enum `PhotoBlockState.kind` whose `failed` value is never produced | 13 placeholder + 3 planned + 4 identity-writers | swap/bind on a photo block: UI hides it, server accepts it (`live-edit.ts:173`, `machines.ts:516` have no photo check — CLAUDE.md:40 claims a refusal that does not exist); block/sets identity drift unconstrained | **yes** |
| 4 | Open-session-per-(user, day) | existence of an open row; partial unique index | 5 queries | restore path has no 23505 catch | yes |
| 5 | Session lock ("is this workout live?") | **4 hand-rolled copies** of `lockActive` (`machines.ts:310`, `workout-sets.ts:18-24`, `photo-workout.ts:114-120`, `sessions.ts:912-924`) with 4 error shapes (`MachineInputError`, `WorkoutEditError`, `{ok:false,status}`, `null`) | 4 | — | **yes** |
| 6 | `SessionAccessMode` | `'active'` means *not trashed* (open **or** ended); `'ended-active'` means ended; there is no `'open'` | 7 callers | misnomer, not a data hole | yes |
| 7 | Program active / retired / system | `is_active` bool × `system_kind` nullable | 25 | retired version still starts sessions (`programs/[id]/+page.server.ts:30` never filters `is_active`); quick program is `is_active=true`; `updated_at` never written | no |
| 8 | Program lineage | `source_program_id` self-FK, write-once | 7 | cycles, duplicate successors, cross-user — app-only | no |
| 9 | "From now on" swap intent / result | `prescribed_set_id` kept-vs-null + `exercise_id ≠ day_exercises.exercise_id` + transient return enum + `?program=` URL param | 3 | permanently "recorded, never applied" when `applyProgramSwaps` fails; TOCTOU vs open-session check; `'Program is inactive'` error → 500 not `changed` | no |
| 10 | Gym active / archived; Machine active / archived / merged | `archived_at`, `merged_into_id` | **29** | archived gym's machines mutable by every admin fn; placeholder that was a merge party → FK 500 on identify-merge | partly |
| 11 | Equipment model global / owned / retired | `owner_user_id` NULL?, `retired_at` NULL?; 3 independent owned-insert sites | 14 + 5 | owned+retired (doc says never, no CHECK) | no |
| 12 | Photo | `status` CHECK + 6 nullable link cols + `photo_objects.state`; `'discarded'` overloaded as pre-publish | 23 (6 copies of `status IN ('uploaded','analyzed')`) | **discarded → confirmed** via `identifySessionExercise` / `?/link` (no status filter, `photo-workout.ts:246,341`); confirmed with no machine; analyzed with `created_model_id` after undo | partly |
| 13 | Merge record | `undone_at` | 5 | undo after kept archived leaves kept archived | no |
| 14 | Account deletion job | `user.deletion_requested_at` + `privacy_deletions(completed_at, last_error, attempts, owner_id)` | fence 10; job 5 with **3 different enum mappings** | `completed_at` AND `last_error` both set; `attempts` written, never read (unbounded) | no |
| 15 | Photo object / removal job | `photo_objects.state` + `write_deadline` + receipt | 5 + 3 | crash window `photos/index.ts:170→171` leaves `uploaded`+`uploading` | no |
| 16 | OAuth grant liveness | consent existence + `expires_at`/`revoked`/`session_id` on two tables + `client.disabled` | 6; full-validity predicate duplicated with different subsets (`access.ts:26-56` vs `refresh-session.ts:24-29`) | `revoked` never written; refresh path ignores it | no |
| 17 | `llm_calls` | `status` CHECK; safety path borrows `refused`+`'pending'` as in-flight | 4 (four "counts" definitions) | permanent `pending` on crash; refusals count toward one cap and not the other | no |
| 18 | Bootstrap / sentinel owner | fixed id + email literal + credential-row existence; 3 statements, no tx | 4 (1 dead export with a wrong column name) | re-run creates duplicate credential rows (no unique on `auth.account`) | no |
| 19 | Client UI modes | SetRow 8 vars, page 4 overlay axes, RestTimer 6, AddSheet role×tab×view×2 contexts, WorkoutPhotoBlock | — | `failed` photo block renders no action; two sheets open; `start()` restarts a running rest; `TrashPurgeForm` keeps `PURGE` typed after Cancel | **yes** |

Well-encapsulated counter-examples worth copying: the login throttle returns a
`ThrottleDecision` union and callers only branch on it (`login-throttle.ts`);
`suggestNextLoad` returns `{kind, load, reasoning}` and CLAUDE.md forbids
re-deriving it. The fix below is the same shape applied to the workout.

---

## 2. The decision

**Introduce one shared workout-state vocabulary — `sessionPhase`, `setStatus`,
`workoutCapabilities` — as pure functions over the existing columns, route
every hot-path predicate through it, collapse the four session locks into one,
and add a seam test that fails the build when a raw predicate reappears.**
No schema change in Phase 1.

Why this one and not the others:

- Blast radius. Rows 1, 2, 3, 5, 6 and 19 are the workout hot path and share
  one root cause: the state is spelled out at the use site. Together they are
  about 150 of the ~300 sites found. Rows 7–18 each matter, but each is a
  separate domain with its own small fix (listed in §7).
- It lifts all three experiences from the same change.
  - UX: the row, the menu, the footer and the finish-warning currently
    disagree on a notes-only or load-only set. One `setStatus` makes them
    agree. The server starts refusing what the UI already hides.
  - DX: 87 + 25 + 4 sites become two functions and one lock. `'active'` stops
    meaning "not trashed". New code has one obvious name to reach for.
  - AX: an agent cannot discover the current rule by reading; it has to grep
    three spellings and guess which variant is canonical. After this, the rule
    is one file, CLAUDE.md names it, and `llm-seam.test.ts`'s pattern enforces
    it mechanically. The false claim at CLAUDE.md:40 gets corrected.
- Safety. Phase 1 is behavior-preserving by construction: every call site is
  replaced by a function that evaluates the identical predicate. No migration,
  no data touch, no deploy risk beyond a normal release.

What this decision does **not** claim: it does not fix the photo
discarded→confirmed hole, the retired-program-starts-sessions hole, or the
deletion-job enum skew. Those are §7. It also does not add a DB `status`
column. The two-timestamp encoding works; what costs time is that 87 places
each re-spell it.

Weaknesses, stated: (a) the three "completed" variants may be deliberate; if
so, unifying them is a behavior change — hence §5. (b) A seam test built on
regex will have false positives; the allowlist must be explicit and small.
(c) The capabilities object moves decisions server-side, which means one more
field per page load; negligible, but it is a contract the client must not
re-derive around.

---

## 3. Phase 1 — behavior-preserving refactor (coding bot)

Branch: `state-vocabulary-1`. One PR. Full gate (`pwsh -File
scripts/local-tests.ps1 gate` on Predator-Doc, then CI green). Not
Markdown-only.

### 3.1 New module `src/lib/workout-state.ts` (shared; no DB imports)

```ts
export type SessionPhase = 'open' | 'ended' | 'trashed';
export type SessionLike = { endedAt: Date | null; deletedAt: Date | null };
export function sessionPhase(s: SessionLike): SessionPhase; // trashed wins over ended

export type SetStatus = 'untouched' | 'partial' | 'completed';
export type SetLike = {
	executedLoad: number | null; executedReps: number | null;
	executedRir: number | null; notes: string | null;
};
export function setStatus(s: SetLike): SetStatus;
// untouched: all four null. completed: load != null && reps != null. else partial.
export const isTouched = (s: SetLike) => setStatus(s) !== 'untouched';
export const isCompleted = (s: SetLike) => setStatus(s) === 'completed';

export type WorkoutCapabilities = {
	phase: SessionPhase;
	canLogSets: boolean;        // open, or ended with editEnded
	canEditLive: boolean;       // open: add/remove/move/swap/bind/photo
	canFinish: boolean;         // open
	canTrash: boolean;          // ended
	canSaveAsProgram: boolean;  // ended
	photoEnabled: boolean;      // open && gymId != null
	editEnded: boolean;         // ended && ?edit=1
};
export function workoutCapabilities(
	s: SessionLike & { gymId: string | null }, opts: { editEnded: boolean }
): WorkoutCapabilities;
```

`workout-edits.svelte.ts:isLogged` is deleted and its callers use
`isTouched`.

### 3.2 Server predicates `src/lib/server/workout-state-sql.ts`

Drizzle fragments, the only place the SQL spelling lives:

```ts
export const sessionIs = {
	open:    () => and(isNull(sessions.endedAt), isNull(sessions.deletedAt)),
	ended:   () => and(isNotNull(sessions.endedAt), isNull(sessions.deletedAt)),
	trashed: () => isNotNull(sessions.deletedAt),
	notTrashed: () => isNull(sessions.deletedAt),
};
export const setIs = {
	completed: () => and(isNotNull(sets.executedLoad), isNotNull(sets.executedReps)),
};
/** The locked history filter from CLAUDE.md, in one place. */
export const historyFilter = () => and(sessionIs.ended(), setIs.completed());
```

Raw-SQL call sites (`picker.ts:135-170`, `photo-workout.ts:562`) are
rewritten to Drizzle or keep raw SQL **and** get an allowlist entry in the
seam test with a comment naming the fragment they must equal. Prefer rewrite.

### 3.3 One lock

`lockActive` moves from `machines.ts` to `sessions.ts` as `lockOpenSession(db,
userId, sessionId)` (keep an export alias `lockActive` for one release). It
returns the row or throws one error type. The four copies become calls:
`workout-sets.ts:18-24` and `:73-79`, `photo-workout.ts:114-120`,
`:227-232` (this one allows ended — use `lockNotTrashedSession`), `:602-607`,
`sessions.ts:912-924` (`updateSetInSession`: lock with `lockNotTrashedSession`,
then branch on `phase === 'ended' && !options.allowEndedSession` → 409, so the
message and status are unchanged).

Error shape: each caller keeps its current outward error (route tests assert
messages). Do this by catching the one lock error and re-throwing the caller's
type where a route test pins a message. Do not change any message in Phase 1.

### 3.4 Rename `SessionAccessMode`

`'active'` → `'not-trashed'`, `'ended-active'` → `'ended'`, `'deleted-only'`
→ `'trashed'`. Mechanical rename, 7 callers + tests. Add `'open'` (ended NULL,
deleted NULL) because `endSession` currently loads `'active'` then checks
`endedAt` by hand (`sessions.ts:820-821`).

### 3.5 Session page consumes capabilities

`routes/sessions/[id]/+page.server.ts:165-207`: compute `capabilities` once;
keep the existing `workoutBar`, `photoEnabled`, `picker`, `saveAsProgram`,
`allowEndedSessionEdit` fields **derived from it** (so no component contract
changes), and add `capabilities` to the return. In `+page.svelte` replace the
12 raw `data.session.endedAt` reads (lines 103, 109, 126, 149, 175, 256, 280,
284, 331, 337, 417, 452) and the inlined touched predicate at 284 and 381 with
`data.capabilities.*` / `isTouched`. `SetRow.svelte:76-78`: `completed` =
`isCompleted(set)`; `editable` = `capabilities.canLogSets`. `ExerciseMenu`,
`WorkoutPhotoBlock` likewise. `programs/[id]/+page.svelte` and
`history/+page.svelte`: use `sessionPhase`.

### 3.6 Seam test `src/lib/workout-state-seam.test.ts`

Copy the structure of `llm-seam.test.ts`. Fail the `server` project if any
file under `src/` outside the allowlist contains:

- `isNull(sessions.endedAt)`, `isNotNull(sessions.endedAt)`,
  `isNull(sessions.deletedAt)`, `isNotNull(sessions.deletedAt)`;
- `ended_at IS` / `deleted_at IS` in a template literal;
- `.endedAt` or `.deletedAt` used in a boolean position in a `.svelte` file
  (`{#if …endedAt`, `!…endedAt`, `endedAt !=`, `endedAt ==`);
- `executedLoad != null ||` or `executedLoad !== null &&` chains.

Allowlist: `workout-state.ts`, `workout-state-sql.ts`, `db/schema.ts`, the
two `*-seam.test.ts`, `exports/formats.ts:244-251` (pending §5 decision 3),
`picker.ts` only if raw SQL is kept (pending §5 decision 2). Every allowlist
entry carries a one-line reason. The test prints the offending file:line.

### 3.7 Docs

- CLAUDE.md, new principle after "History lookups always filter incomplete
  data": **"Workout state has one vocabulary"** — name the two modules, the
  seam test, and the rule: never read `endedAt`/`deletedAt`/`executed*` as
  a boolean outside them. Correct line 40: `bindSessionMachine` has no
  photo-block refusal; the Phase 2 server guard is what adds one.
- `docs/machine-identity.md`, `docs/photos.md`: replace "active"/"live"
  wording with `open` where it means `sessionPhase === 'open'`.
- CHANGELOG under Unreleased: "No user-visible change. Internal: one
  workout-state vocabulary; seam test."

### 3.8 Tests (new, all server unless noted)

1. `workout-state.test.ts`: truth table for `sessionPhase` (4 combos incl.
   open+trashed → `'trashed'`), `setStatus` (all 16 null-combinations), and
   `workoutCapabilities` (3 phases × editEnded × gymId).
2. Equivalence tests that pin the refactor: for each replaced predicate, a
   test that runs the old inline predicate and the new function over a fixture
   of ~20 rows covering every null combination and asserts identical output.
   Delete these after the PR merges? **No** — keep them; they are the spec.
3. Lock consolidation: existing `workout-sets.db.test.ts`,
   `photo-workout.db.test.ts`, `sessions.test.ts` 404/409 tests must pass
   unmodified. If one needs a message change, Phase 1 is wrong.
4. Seam test fails before the refactor (run it first, record the offender
   count — expect ~110 — then watch it reach 0). CLAUDE.md: "revert the fix and
   watch the test fail before believing it."
5. e2e: no new e2e in Phase 1; `faster-set-entry`, `live-edit`,
   `photo-workout`, `program-bind`, `history-trash`, `csp` must stay green.

### 3.9 Acceptance

- `pnpm test --project server` and `client` green; seam test reports 0.
- `git diff --stat` shows no `.sql` and no `schema.ts` change.
- Grep: `rg "isNull\(sessions\.endedAt\)" src --glob '!*state*'` returns
  nothing.
- A reviewer can read `workout-state.ts` + `workout-state-sql.ts` in under
  five minutes and state every workout rule.

---

## 4. Phase 2 — close the guard gaps (separate PR, after Phase 1)

Behavior changes, each one making the server refuse what the UI already hides
or catching an error that is currently unhandled. Each gets a test that fails
before and passes after.

| # | Change | File | Test |
|---|---|---|---|
| 2a | `swapSessionExercise` and `bindSessionMachine` refuse a photo block (exercise is placeholder) | `live-edit.ts:173`, `machines.ts:516` | direct call on a placeholder block → refused; UI unchanged |
| 2b | `bindSessionMachine` refuses a free-weight block (type in `FREE_WEIGHT_TYPES`) — matches `+page.svelte:284` | `machines.ts:542` | as above |
| 2c | `restoreSoftDeletedSession` requires `endedAt != null` on the row, and catches 23505 → 409 "another workout is open for that day" | `sessions.ts:699` | restore an open+trashed row → 409; restore when another open → 409 |
| 2d | `softDeleteEndedSession`/`hardDelete`/`restore`: use `lockNotTrashedSession` / `FOR UPDATE` like `purge` does | `sessions.ts:675-760` | concurrent restore+hard-delete already tested (`:2662`); add restore+trash |
| 2e | `applyProgramSwaps`: map `'Program is inactive…'` to `changed`, not 500; extend the open-session check into the save transaction | `live-edit.ts:282-336` | `changed` and `invalid` outcomes (no test exists today) |
| 2f | `WorkoutPhotoBlock`: render Name-it / Read-again for `kind === 'failed'`, and produce `failed` from a failed `llm_calls` row | `photo-workout.ts:412-440`, `WorkoutPhotoBlock.svelte:26-95` | component spec + e2e |
| 2g | `ExerciseMenu`: branch for `loggedCount === 0 && photoBlock` (explain why swap is unavailable) | `ExerciseMenu.svelte:47-82` | spec |
| 2h | `RestTimer.start()`: do not restart a running rest from `savedSet` without `keep`; "Try alert" must not overwrite a live `status` | `RestTimer.svelte:54`, `:200` | e2e |

---

## 5. Owner decisions required before Phase 1 ships

Answer each with "keep" or "unify". Default if unanswered: **keep** (allowlist
the site, no behavior change).

1. `workout-to-program.ts:42` counts a notes-only set as **not** saved when
   building a program from a workout. Everywhere else notes-only is "touched".
   Keep (notes alone are not a set to template from) or unify to `isTouched`?
2. `picker.ts:157` ("exercises done on each machine") counts a set with a load
   and no reps. Everywhere else history needs both. Keep or unify to
   `setIs.completed()`?
3. `exports/formats.ts:250` (Strong CSV) additionally requires `reps > 0`.
   Keep (a 0-rep set breaks third-party import) or unify?

My read, low confidence: 1 keep, 2 unify, 3 keep. Each is a product choice
and I have no usage data to support it.

---

## 6. Brief for the adversarial review bot

You are reviewing the Phase 1 PR. Your job is to prove it changed behavior.
Assume the author is competent and the equivalence tests pass; look for what
the tests cannot see.

Attack list, in order of payoff:

1. **Predicate inversion.** For every replaced site, diff the old boolean
   against the new function on the four session combos and the sixteen set
   combos. Pay attention to `trashed` rows: old code sometimes checked only
   `endedAt` (e.g. `+page.svelte:284`) and would have treated an open+trashed
   row as editable; new code treats it as trashed. Decide whether that is a
   fix or a change, and say which.
2. **Lock semantics.** The four original locks differ: `workout-sets` refuses
   ended **or** trashed with one message; `photo-workout:114` refuses trashed
   as "not found" and ended as "has ended"; `updateSetInSession` allows ended
   with a flag. Confirm every caller still gets the same status and message.
   Grep every test file for those messages and confirm none were edited.
3. **The `'active'` rename.** Find every `loadSession(..., 'active')` call in
   the old code and confirm the new mode is `'not-trashed'`, not `'open'`,
   unless the caller then checked `endedAt` itself — in which case `'open'`
   is correct and the hand check must be gone. `endSession` is the known case.
4. **History filter.** `historyFilter()` must be exactly `ended_at IS NOT NULL
   AND deleted_at IS NULL AND executed_load IS NOT NULL AND executed_reps IS
   NOT NULL`. Confirm `progression.ts:336-337, 423-424`,
   `sessions.ts:425-428`, `machine-reports.ts`, `picker.ts`, `mcp/reads.ts`
   now call it or an equivalent. Any site that dropped `deleted_at IS NULL`
   is a regression (trashed sessions would feed prefill).
5. **Seam test honesty.** Try to add a raw `isNull(sessions.endedAt)` to a
   route file and confirm the test fails with file:line. Try the three
   spellings. Try a `.svelte` `{#if data.session.endedAt}`. If any passes,
   the seam is decorative.
6. **Client contract.** Confirm no `.svelte` file reads
   `data.session.endedAt`/`deletedAt` directly. Confirm `SetRow`'s `editable`
   derives from capabilities, and that `allowEndedSessionEdit` is still
   echoed as the hidden field (the server contract did not change in Phase 1).
7. **Dead guards.** `+page.svelte:204` checked `!data.session.deletedAt` on
   a row `loadSession 'active'` already filtered. If the author removed it,
   fine; if they routed it through capabilities, fine; if they changed what
   `saveAsProgram` shows, not fine.
8. **Schema diff.** `git diff -- drizzle src/lib/server/db/schema.ts` must be
   empty.
9. **CLAUDE.md line 40.** Confirm the false `bindSessionMachine` claim is
   corrected and not merely softened.
10. **Gate evidence.** Require the `local-tests.ps1 gate` output and the CI
    run id in the PR; do not accept a statement that it passed.

Report format: one line per finding — `severity · file:line · what changed ·
how you proved it`. Every finding needs a reproduction. For each attack you
ran that held, say what you tried.

---

## 7. Follow-ups, outside this plan (ranked by harm if left)

1. **Photo `discarded → confirmed`** (`photo-workout.ts:246-254, 341`;
   `review/+page.server.ts:126-150`): add `status IN ('uploaded','analyzed')`
   to `identifySessionExercise`'s photo lookup and to `?/link`. One line each
   plus a test. Real data hole.
2. **Retired program still starts sessions** (`programs/[id]/+page.server.ts:30-40`
   never filters `is_active`): decide whether that is a feature (resume old
   version) or a bug; today it is undocumented.
3. **Account deletion job**: unify the three `completed_at`/`last_error`
   mappings (`lifecycle.ts:377,443`, `routes/privacy/+page.server.ts:19`,
   `scripts/privacy.ts:83`) into one `deletionJobState()`; add a CHECK that
   `completed_at IS NULL OR last_error IS NULL`; read `attempts` or drop it.
4. **Bootstrap**: wrap claim in a transaction; refuse when a credential row
   already exists; delete `hasLoginCapableAccount` (dead, wrong column).
5. **OAuth validity**: one `grantIsLive()` used by both `access.ts` and
   `refresh-session.ts`; include `revoked` and `client.disabled` in both.
6. **`llm_calls` safety reservation**: use a real `'pending'` status (CHECK
   change) or sweep stale reservations.
7. **Phase 3, optional DB CHECK** on `sessions`: `deleted_at IS NULL OR
   ended_at IS NOT NULL`. Needs: pre-check query on a prod restore showing 0
   violating rows, rewrite of `sessions.test.ts:287` fixture, migration
   rehearsal per CLAUDE.md. Do not ship with Phase 1.
8. Client UI: two sheets open; `TrashPurgeForm` keeps `PURGE` after Cancel;
   `AddSheet` has no Back from `format` and no Escape; `guidedSets` points at
   a removed set.

---

## 8. Evidence trail

Audit was five parallel read-only passes over `03c9335` (workout/session,
programs, machines/catalog/photos, auth/privacy/import/LLM/MCP, client UI)
plus a schema-wide grep; every file:line above was read, not inferred. Site
counts are `rg` over non-test `src/` and will drift as `main` moves; re-run
before relying on a number.
