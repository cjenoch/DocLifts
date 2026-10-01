# Project rules for AI coding assistants

This file is read by Claude, Cursor, and other AI coding tools when working in this repo. Decisions encoded here are locked from planning v2.2. Do not deviate without explicit user approval.

## Stack

- **Framework:** SvelteKit (Svelte 5)
- **Runtime:** Node 24 LTS
- **Database:** PostgreSQL 16, self-hosted in Docker for dev
- **ORM:** Drizzle (TypeScript-native, SQL-shaped)
- **Forms:** plain HTML POSTs to SvelteKit server actions, Zod-validated server-side.
- **Styling:** Tailwind CSS
- **Formatter:** Prettier (with `prettier-plugin-svelte` and `prettier-plugin-tailwindcss`). Config in `.prettierrc`: tabs, single quotes, no trailing commas, 100-char print width.
- **Testing:** Vitest
- **Package manager:** pnpm

TypeScript strict mode is non-negotiable.

## Svelte conventions

- Use **Svelte 5 runes** (`$state`, `$derived`, `$effect`, `$props`). Do NOT use legacy `$:` reactive labels or Svelte 4 component syntax. LLM training data mixes Svelte 4 and 5 patterns; default to 5.
- Use **SvelteKit server actions** (`+page.server.ts`) for form submissions unless there's a strong reason not to.
- DB code lives **only** under `src/lib/server`. Importing DB code from a client component is a build error and should stay that way.
- Use `+page.server.ts` for server-only code, not `+page.ts`.

## Architectural principles (DO NOT BREAK)

These are locked from planning v2.1/v2.2 and reflect substantive design decisions, not preferences.

### Snapshot semantics

- Past sessions preserve what was prescribed at the time. History is append-only and immutable in effect.
- When a session starts, prescribed values (`prescribed_load`, `prescribed_reps_min`, `prescribed_reps_max`, `prescribed_rir`, `set_role`, `target_metric`) are copied from `prescribed_sets` into the `sets` row. Once written, they don't change — even if the program template is later edited.
- **One deliberate exception:** binding or rebinding a machine to an occurrence in a _live_ session (`prefillOccurrence` in `machines.ts`) rewrites `prescribed_load` and `suggestion_reasoning` on that occurrence's sets, because the prescription must come from that machine's own history. It is gated: refused once any executed value or note is saved on those sets, and never on an ended session. Rep range, RIR, role and metric are still never rewritten. Don't "fix" this path back to immutable (see `docs/machine-identity.md`).

### Programs are duplicate-on-edit, not mutate-in-place

- Editing a program **deep-copies** the program AND all child rows (`days`, `day_exercises`, `prescribed_sets`), marks the old program inactive, user edits the copy.
- A shallow copy would create historical-mutation problems. Always deep copy children.
- `programs.sourceProgramId` (self-FK, nullable) tracks lineage.

### History lookups always filter incomplete data

**All** history lookups — the live MVP-B prefill, `consecutiveBackwards` calculation, history views — use these filters:

```sql
WHERE executed_load IS NOT NULL
  AND executed_reps IS NOT NULL
  AND sessions.ended_at IS NOT NULL
```

The blank-row poisoning bug is real: pre-created session rows with null executed values can be returned as "history" by naive `ORDER BY logged_at DESC LIMIT 1` queries. Don't reintroduce it. (See `planning_v2_2.md` §3.)

### No prescribed loads in the program template

- `prescribed_sets` stores **structure** (set roles, rep ranges, rest, tier) and `initialLoad` (cold-start only).
- Current target loads come from history + progression engine, not from the template.
- Don't add a "current load" column to `prescribed_sets`.

### Pre-fill query match key

- Match by `(exercise_id, set_role, position)`, not just `(exercise_id, set_role)`.
- Position matters because two-working-set exercises have different intents at different positions (set 1 RIR 3 vs set 2 RIR 1).

### Progression engine is tier-aware

The engine is **wired into the runtime prefill** (`startSessionForDay`) as of MVP-B — it is not dormant. Don't "wire it in"; it's already on the hot path.

- **MAIN**: top-set-driven. The caller passes only the top set to `suggestNextLoad`.
- **SECONDARY / ISOLATION**: all-sets-driven. The caller gathers all working positions for the exercise and calls the engine once with the full set array. The rule requires ALL working sets to clear top of range before advancing; a single clearing position must NOT advance the exercise.
- **Warmups DO NOT use the progression engine.** Warmups bypass `suggestNextLoad` entirely. Their prefill uses the last completed `executed_load` for the slot (filtered per the history-filter rule), falling back to `initialLoad` when no history exists — the same source as working-set dumb prefill, without the engine on top. The invariant that matters is _no engine progression on warmups_, not the source of the number. (Earlier revisions said warmups "always use `initialLoad`"; tightened so warmup prefill tracks the actual last warmup load instead of resetting to cold-start each session.)

### Engine returns a typed decision; callers read it, never re-derive it

suggestNextLoad returns `{ kind: 'advance' | 'hold' | 'deload', load, reasoning }`. Callers branch on `kind` and use `load`/`reasoning` directly. Do NOT infer the decision by comparing the returned load against a recomputed baseline or by reimplementing the deload math in the caller — that reintroduces a drift trap where the caller's arithmetic and the engine's can diverge. A test asserts `kind` and `reasoning` stay in sync; keep it.

### `consecutiveBackwards` is computed from executed outcomes

- NOT from prior suggestions. User overrides are first-class; suggestion history doesn't reflect what actually happened.
- MVP simplification: load-only check (no reps/RIR clearance inspection). See `progression.ts` `computeConsecutiveBackwards()` comment for tightening path.
- **MVP-B wires this in.** `computeConsecutiveBackwards` and `suggestNextLoad` are live in `startSessionForDay`'s prefill. (MVP-A was dumb prefill only — last completed `executed_load` filtered per the history rule, or `initialLoad` on cold start — with the engine implemented but not called. That phase is past; the engine now drives the prefilled load.) For non-MAIN tiers, `consecutiveBackwards` is computed per working position and aggregated with `Math.min` across positions — the exercise only counts a session as backwards if every working position regressed.

### Session-start integrity: `programId` from day, never from client

- The server action that creates a session MUST compute `programId` by looking up the chosen day row, NEVER trust a client-supplied `programId`.
- The DB stores `sessions.programId` as a denormalization of `days.programId` for query convenience. There is no trigger or composite FK enforcing the invariant — application code is solely responsible.
- A bug here corrupts the history filter (queries by program_id will silently return wrong sessions), and you won't notice until you're looking at trends weeks later.

### Progression policy taxonomy

- `'standard'` — default. Engine progresses linearly per tier rules (top set + bump, all sets clear + bump).
- `'cautious'` — engine holds load; user must manually advance after 2-3 clean sessions at RIR 0-1. Used for shoulder press, DB lateral raise, band external rotations (right-shoulder fragility per v5 hard rules).
- `'hold'` — engine never suggests progression. Used for **wave-loaded lifts** (deadlift) where the engine's linear progression is wrong every wave-shift week. User inputs target directly per the wave plan.

### Pipeline order

```
history lookup → progression engine → plate snap → display
```

This order is locked. The engine produces an ideal raw load; plate snap reduces to physical reality. Never snap before the engine — you'd snap a stale value, then the engine would propagate snap rounding.

### Plate snap is equipment-type-aware — use the router

The pipeline calls **`snapForEquipment(load, equipmentType)`**, not `snapToAchievable` directly. The router dispatches to the correct math:

| `equipmentType` | Snap behavior                                                  |
| --------------- | -------------------------------------------------------------- |
| `barbell`       | Subtract bar (44 lb), halve, snap plates per side, double back |
| `barbell-ez`    | Same as barbell with EZ bar weight (25 lb)                     |
| `machine-plate` | Snap directly on per-side plate sums (no bar)                  |
| `machine-stack` | Pass-through (load IS the displayed value)                     |
| `cable`         | Pass-through                                                   |
| `dumbbell`      | Pass-through (post-MVP could snap to gym DB inventory)         |
| `smith`         | Pass-through                                                   |
| `bodyweight`    | Pass-through                                                   |
| `band`          | Pass-through                                                   |
| (anything else) | Pass-through                                                   |

Never call `snapToAchievable` directly from the pipeline. Always go through the router. (See `planning_v2_2.md` patch notes.)

### Calling `mainPrefills` directly requires the machine identity

`mainPrefills` takes an optional `PerformanceIdentity`. `startSessionForDay`
supplies it implicitly, so every path through the session-start pipeline is
fine by default. Calling `mainPrefills` directly in a test without it silently
returns no history when a machine is bound: history is machine-scoped, the
identity filter matches nothing, and the result looks like a cold start — or
like a scoping bug. It is neither. Pass
`{ gymEquipmentId, loadConvention }` whenever a machine is bound.

### Engine output is suggestion, never auto-applied

- The user override path is one tap. Never bake a load into the prescribed field without giving the user an editable surface.
- Show provenance on every suggested load. Rendered in SetRow under the load field as the reasoning text itself (e.g. `+5: top set hit 5 reps at RIR 1`), persisted via `sets.suggestion_reasoning` (snapshotted at session-start like the rest of the prescription). No `Suggested:` prefix — the reasoning line is self-explanatory (owner decision, 2026-09-14).
- Provenance goes near or under the load field, NOT in a tooltip. Tooltips are for things you don't need to see; provenance you need every session.

### Content-Security-Policy is strict, and style attributes are the trap

`svelte.config.js` sends a nonce-mode CSP with no `unsafe-inline`: `script-src` and `style-src` are `'self'` plus a per-request nonce, and there is no `style-src-attr`. Facts that follow from that:

- **Nonces never cover style attributes.** A `style="width: 50%"` attribute falls back to `style-src` and is blocked. The header looks correct, the page still returns 200, and the only symptom is a wrong layout. That is how the 2026-09-28 CSP change shipped with every `/reports` bar drawn at the same width. Render dynamic values through elements and attributes (`<progress value max>`, `<meter>`, classes, `<details open>`), never through an inline style. Svelte's `style:` directive is fine (it writes through the CSS object model, which CSP does not govern).
- **Dev mode hides the break.** SvelteKit adds `unsafe-inline` to `style-src` under `vite dev` so Vite can inject styles. Only a production build shows CSP behavior.
- **Small imported assets become `data:` URIs.** Vite inlines imports under its size limit, and `img-src 'self'` blocks them. Put icons and images in `static/`.
- **The gate is `pnpm test:e2e`** (`e2e/csp.e2e.ts`). It serves the production build, loads every route plus a client-side navigation in Chromium, and fails on any CSP violation or any app element carrying a `style` attribute. **"Every route" is enforced, not assumed:** `ROUTE_PATTERNS` lists all ten patterns and a test fails by name if any is listed but never reached — that assertion is what caught a shipping `unsafe-eval` violation on the two program-editor routes, which the earlier five-route crawl never visited. Add a route to that table when you add a route. Run it after any change to the CSP, to `app.html`, or to dependencies that render UI. It needs `pnpm build` first and a Chromium Playwright can launch (`PW_EXECUTABLE_PATH` if not the bundled one). **Locally it skips itself, with one warning line, when either is missing; set `CI=1` to make that a failure.** CI always runs it in required mode.
- **One tolerated exception, by name:** SvelteKit's own `#svelte-announcer` live region raises a `style-src-attr` violation on every page. The framework hides it through the CSS object model anyway, so it has no visible effect. The e2e test ignores that single violation and asserts the announcer stays visually hidden after navigation. Do not widen the CSP for it, and do not add a second exception without the same proof.

### No `$env/dynamic/*` reads at module scope in server code

On adapter-node, `$env/dynamic/private` is populated by SvelteKit's
`Server.init()`, which runs at **server startup** — after the server entry has
already imported the module graph. Any read at module scope is therefore
`undefined`, silently, for **every** variable and not just the one you were
thinking about.

Two things make this dangerous rather than merely broken:

1. A `??` fallback converts a missing-variable error into a **plausible wrong
   value**. `auth.ts` read `env.PUBLIC_ORIGIN` this way from T1a; `baseURL`
   silently became `http://127.0.0.1:3000`, Better Auth's `isAuthPath()` matched
   no request against it, and SvelteKit 404'd the entire `/api/auth/*` tree —
   with the healthcheck green throughout.
2. Nothing catches it until a request goes through the real HTTP handler. Every
   check passed for four rounds because sign-in called `auth.api` directly and
   never touched the handler path. Proven twice now; the served-build e2e is
   the only gate that finds it.

**The rules:**

- Read `process.env` for any value a server module needs **at construction**
  time. Server-only code doing this is not a smell — nothing in `src/lib/server/`
  is ever bundled to the client, and the CLI already works this way.
- **Never fall back to a default for a required production value. Throw.**
  (`resolveBaseURL()` in `auth.ts` is the reference implementation.)
- Prefer passing configuration in as an explicit argument, as `createAuth()` and
  the `users.ts` operations already do. Module-scope reading is the fallback
  case, not the default.

**Corollary for hooks:** `handle` order is load-bearing. The guard returns
`resolve(event)` immediately for any allowlisted path, so
`sequence(guard, betterAuth)` means `svelteKitHandler` never runs. It is
`sequence(betterAuth, guard)`. The allowlist entry is still correct — it is what
stops the guard demanding a session for Better Auth's own endpoints — it just
must not come first.

### Migrations: name everything, apply before you trust it

Three rules, all from the 0009 round where three separate defects were
invisible in the SQL and obvious only after applying it.

**1. Every constraint is explicitly named, and names stay under 63 bytes.**
In hand-written migration SQL, never write an inline `UNIQUE` or rely on
Postgres's default name. In TS, give the constraint an explicit name wherever
drizzle-kit allows one (`unique('...')`, `index('...')`) so the snapshot and
Postgres agree by construction. The 63-byte ceiling is a silent trap:
Postgres truncates identifiers without warning, and drizzle-kit does not
check, so the snapshot and the database disagree from the first apply.
`exercise_equipment_map`'s FK is already in this state.

**2. Migrations are append-only once applied anywhere real.** The migrator's
"already applied" check reads only the most recently applied row's
`created_at` and compares it to each file's timestamp — a renamed, renumbered,
or back-dated migration is silently _skipped_, not rejected. An unapplied
migration may be deleted and regenerated freely; an applied one may not be
edited. Fix a wrong-but-unapplied file by regenerating, never by patching
old migrations.

**3. A generated migration is verified by applying it, not by reading it.**
Apply the full chain to a fresh `pg_dump` of production, then confirm the
resulting schema against the intended change: tables, columns, constraints
_by name_, indexes, and row counts. Two of the three defects in the 0009 round
were syntactically fine and semantically absent.

## Schema discipline

- Volume aggregates (when added post-MVP) MUST filter `target_metric = 'reps'` to avoid mixing planks (seconds) into weight × reps math.
- All position columns have UNIQUE constraints with their parent (program × day_position, day × exercise_position, day_exercise × set_position).
- All FK columns have explicit indexes declared. Drizzle does NOT auto-index FK columns; Postgres doesn't either.
- All numeric columns use `mode: 'number'`. JS-number precision is safe for load weights bounded under 1000 lbs.
- `pain_events` requires at least one of (sessionId, setId, exerciseId) non-null via CHECK constraint.

## Every row is owned

Since T3, and enforced by the database since migration 0011, **every row belongs
to exactly one user**. There are no shared or global rows in the application
tables, and no exception carved out for any of them.

The eight directly-owned tables, the ones 0011 makes `user_id NOT NULL`:
`programs`, `gyms`, `exercises`, `sessions`, `sets`, `pain_events`,
`workout_log_imports`, `program_draft_requests`.

Everything else is owned through a parent chain. Resolve it; never widen it.

| Table                    | Owned by                                                          |
| ------------------------ | ----------------------------------------------------------------- |
| `days`                   | `program_id` → `programs.user_id`                                 |
| `day_exercises`          | `day_id` → `days` → `programs.user_id`                            |
| `prescribed_sets`        | `day_exercise_id` → `day_exercises` → `days` → `programs.user_id` |
| `session_exercises`      | `session_id` → `sessions.user_id`                                 |
| `imported_workouts`      | `import_id` → `workout_log_imports.user_id`                       |
| `gym_equipment`          | `gym_id` → `gyms.user_id`                                         |
| `equipment_models`       | `user_id` (direct)                                                |
| `exercise_equipment_map` | through its parent exercise/gym rows                              |

### D5 — the signature rule

Every function that reads or writes application data takes the owner's id as a
required second argument, after the db handle:

```ts
loadSession(db, userId, sessionId, 'active');
createGym(db, userId, formData);
```

Not optional. Not defaulted. Not threaded through some other object. The rule is
mechanical so it can be checked by reading the signature, which is what the T4
sweep did: 14 call sites across 7 route files, all conforming.

### D6 — a foreign resource is a 404, never a 403

Requesting another user's row returns **404, identical to an id that never
existed.** Not 403, not a distinct message, not an empty list. A 403 confirms
the resource exists, which is an enumeration oracle.

The practical consequence: an owner predicate riding on a URL id is not enough.
`where(eq(days.id, dayId))` inherits ownership from upstream and is only safe
because the caller checked first. Join to the owner and filter on
`programs.user_id` — as `loadSessionDay` does — so the function is safe on its
own terms.

And "owned by someone else" is **never a server error**. A defensive `error(500)`
on an unreachable FK branch is wrong; return not-found.

### The cross-tenant test requirement

**Every** function that can reach another user's rows needs a test proving it
cannot, in the same shape every time:

```ts
it('returns the owner their own rows, and nothing to another user', async () => {
	const { alice, bob } = await withTwoUsers(db);
	const mine = await loadSessionSets(db, alice, sessionId);
	expect(mine).toHaveLength(1); // positive FIRST
	const theirs = await loadSessionSets(db, bob, sessionId);
	expect(theirs).toEqual([]);
});
```

**Positive assertion first.** A test that only asserts the refusal passes
against a function that always returns nothing — which is how a broken
implementation reads as a working one.

**Assert the state change, not the response shape.** For any state-changing
action, assert what the state became — the row is gone, the next request is
refused, the counter moved — rather than that the response looked right. A
redirect proves the action _ran_, not that it _worked_.

Both halves of the 0.2.0 release shipped a test that passed while the feature
was broken in production:

- The sign-out test asserted `303 -> /login` and a following `303` on
  `/history`. The action redirects to `/login` whether or not Better Auth
  accepted the sign-out, and SvelteKit 303s an unauthenticated `/history`
  regardless — so it passed in every run while logout did nothing at all.
- The rate-limit test asserted a transport status, and SvelteKit answers form
  actions with an outer `200` and carries the real status in the action
  envelope.

So the assertions that would have caught both: the `auth.session` row is
deleted, and a client that _kept_ the cookie is refused. Neither is observable
from the response the action returns.

**An action with no rendered control is untested code; every action has an e2e
that reaches it from a page.** `src/routes/logout/+page.server.ts` existed
since T2, worked, and answered 405 to GET on purpose — and nothing rendered it
anywhere, so there was no way to log out from the UI at all. Found only by
using the app. The e2e posted to `/logout` directly, so it was green the whole
time.

**Assert the numbers a user would state, not the framework's internal ones.**
The rate-limit e2e watched Better Auth's counter at 3 per 10 seconds, which was
both the wrong control and, on the wire, a lockout: the counter charges
successes, so four correct-password sign-ins in quick succession refused the
fourth. The replacement asserts what the user would say — fifteen correct
sign-ins in a row, no waiting — and fails at the fourth under the old
config. A test that pins an implementation's number is a test that will
happily pass while the behaviour is wrong.

**Never exercise a control against the owner's account, email, or address.**
Use `scratch-test@doclifts.invalid`. On 2026-09-30 a throttle verification sent
ten wrong passwords at the owner's email key and locked him out of a working
password for fifteen minutes. A scratch account existed the whole time. The same
night, `user:create` had no `--password-stdin`, so making that scratch account
required putting a secret in the process list — it has one now.

**A test that cannot fail proves nothing, and SvelteKit's defaults hide it.**
The version.json assertion originally accepted the literal `'dev'`, and it
passed with the entire `version` block deleted from `svelte.config.js` because
`'dev'` is the framework's own default. Always revert the fix and watch the
test fail before believing it.

**In `hooks.server.ts`, never set response headers and then `throw redirect()`.**
The headers are lost. SvelteKit's `respond` catches the `Redirect` and builds the
response itself with `redirect_response(e.status, e.location)` — a bare
`Response` with only a location — so everything the hook set is discarded with
the unwound stack. That is why the 0.2.1 `no-store` never reached the wire on
any `303`. Build and return the `Response` with its headers explicitly; see
`redirectWithNoStore`. The e2e asserts `no-store` on an unauthenticated `303`,
so a refactor that reintroduces the throw fails CI.

**`event.setHeaders` is not idempotent.** Applying the same header twice throws
`"cache-control" header is already set` and turns every page into a 500. It
looks like an infrastructure failure rather than a crash, and `waitForServer`
now prints the child's last 40 lines so the real cause is in the failure
message instead of one hand-run away.

**`event.setHeaders` cannot reach a thrown `redirect()`.** SvelteKit's
`respond` builds that response itself (`redirect_response(e.status,
e.location)`) and discards everything the hook set, so an unauthenticated
request to a guarded page was answered `303 -> /login` with no cache policy at
all. Returning a `Response` from `handle` does work — see
`redirectWithNoStore` in `src/lib/server/redirect-no-store.ts`.

**A control that counts the wrong thing is worse than no control.** Every
value here was chosen without usage data. The refusal log is the instrument
that corrects them: no refusals means the numbers are generous, refusals on a
real person means loosen. Do not tune them from a reading of the code.

### Where the data comes from

`exercises` is owned, so the 23-exercise starter list is **copied per user**
(`src/lib/server/starter-exercises.ts`), not referenced from a shared catalogue.
Duplicating rows is the deliberate cost of having no cross-tenant table.

`0001`/`0011`: migration 0011 backfills every pre-existing row to one
placeholder owner, the sentinel `00000000-0000-4000-8000-000000000001`. It is
claimed by `pnpm user:bootstrap`, which keeps that id — so the backfilled rows
stay attached — and gives it a real email and a credential row. Until bootstrap
runs, the data is owned by an account nobody can sign in as.

## Out of scope

Per owner decision (2026-09-26): the feature-gate list is retired. There is no standing
out-of-scope list anymore. Multi-gym support was explicitly approved and shipped
(`/gyms`, `gyms` + `gym_equipment` tables). Treat new features like any other change:
follow the architectural principles above, and confirm with the owner before large
builds — but no item is pre-banned. The "personal tool, not product" framing is locked.

## File conventions

- `src/lib/server/db/schema.ts` — all Drizzle table definitions
- `src/lib/server/db/seed.ts` — guarded fictional demo seed CLI; requires `DOCLIFTS_DEMO=1` and a `doclifts_demo` database. Never use it to seed production.
- `src/lib/server/demo.ts` — transactional fictional fixtures; refuses populated non-demo databases and never truncates existing data.
- `src/lib/server/auth-core.ts` — `createAuth(db, opts)`, the Better Auth configuration with **no `$env`/`$app` imports**, so it runs outside SvelteKit. `auth.ts` is only the SvelteKit singleton that supplies the secret and build phase. Do not move configuration back into `auth.ts`: that is what made the T5 CLI unrunnable.
- `src/lib/server/starter-exercises.ts` — the 23 exercises copied into every new account by the auth create hook.
- `src/lib/server/users.ts` — `createUser(auth, db, input)` / `setPassword(auth, db, input)`. The auth instance is an explicit argument because the CLI must build its own outside SvelteKit.
- `scripts/user-prod.sh` — runs `pnpm user:*` against production on the Compose network, in the builder image (the runtime image has no `tsx`). Mirrors `migrate-prod.sh`'s env handling.
- `compose.demo.yml` — isolated, localhost-only temporary demo; does not mount production data or read `.env`.
- `src/lib/server/db/index.ts` — Drizzle client singleton
- `src/lib/server/progression.ts` — engine + history helpers
- `src/lib/server/plates.ts` — plate snap algorithms + router
- `src/lib/server/sessions.ts` — action helpers (`startSessionForDay`, `endSession`, `updateSetInSession`). The route `+page.server.ts` files are thin wrappers around these.
- `src/lib/server/workout-sets.ts` — in-session set mutation (append set, remove-empty-last-set) for the inline logging UX. Locks the session row, validates done/deleted state, uses a client-supplied `requestId` as the set PK for idempotency, tags appended sets as `machine`-sourced copies (provenance: "Copied from the previous set. Adjust to what you lift."). Never renumbers existing `position`s.
- `src/routes/sessions/[id]/AddWorkoutExercise.svelte` — client-side quick-add a new exercise to a live session (machine picker + machine-type-aware equipment preselect).
- `src/lib/request-id.ts` — idempotency token helpers (client generates a per-submit UUID; server keys on it so a double-submit can't double-append).
- `src/lib/server/gym-config.ts` — plate inventory config (single-gym hardcoded; superseded for equipment picking by the shipped `gyms`/`gym_equipment` tables, but still the plate-snap inventory source)
- `src/lib/server/test-db.ts` — integration-test DB bootstrap. Not imported by production code.
- `scripts/backup-db.sh` — daily `pg_dump` to `/srv/backups/doclifts/`, 30-day rotation. Installed in user crontab (`0 3 * * *`). Cron log at `/srv/backups/doclifts/cron.log`.
- `scripts/compose-prod.sh` — the ONLY sanctioned way to run production Compose. It passes
  `/srv/doclifts/.env` explicitly via `--env-file`, so the checkout's own `.env` is never
  consulted. Production's env file lives outside the repository and must never be
  symlinked into it.
- `scripts/migrate-prod.sh` — applies pending migrations to production, with a verified
  pre-migrate `pg_dump` (custom format, mode 600, verified with `pg_restore --list`) and
  a refuse-to-migrate failure path. Builds `DATABASE_URL` from `POSTGRES_PASSWORD`; never
  require a hand-exported one.
- The systemd / release-symlink deployment path (unit, `deploy-safe.sh`,
  `verify-doclifts-up.sh`, `pnpm redeploy`) is REMOVED. The unit was `not-found` on the
  host; production runs through Compose. Its one unique feature — the pre-migrate dump —
  now lives in `scripts/migrate-prod.sh`.
- `drizzle/` — generated migration files (committed to repo)
- `drizzle.config.ts` — Drizzle Kit config. `drizzle-kit check` requires `DATABASE_URL` and does **not** fail loudly without it, so it is wired into `ci.yml` rather than left to a local run. Run it locally with an explicit `DATABASE_URL`; a silent skip reads as a pass.

## When in doubt

Re-read this `CLAUDE.md` file in the repo root. It is the source of truth for locked decisions and assistant operating constraints in this codebase.
