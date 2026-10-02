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
- **The gate is `pnpm test:e2e`** (`e2e/csp.e2e.ts`). It serves the production build, loads every route plus a client-side navigation in Chromium, and fails on any CSP violation or any app element carrying a `style` attribute. **"Every route" is enforced, not assumed:** `ROUTE_PATTERNS` lists every pattern and a test fails by name if any is listed but never reached — that assertion is what caught a shipping `unsafe-eval` violation on the two program-editor routes, which the earlier five-route crawl never visited. Add a route to that table when you add a route. Run it after any change to the CSP, to `app.html`, or to dependencies that render UI. It needs `pnpm build` first and a Chromium Playwright can launch (`PW_EXECUTABLE_PATH` if not the bundled one). **Locally it skips itself, with one warning line, when either is missing; set `CI=1` to make that a failure.** CI always runs it in required mode.
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

### LLM calls go through `complete()` only

**No provider SDK is called anywhere except through `complete()`**
(`src/lib/server/llm/index.ts`). One seam, like the auth proxy. Nothing outside
`src/lib/server/llm/` imports `ai`, `ai/*`, `@ai-sdk/*` or `@openrouter/*`;
`src/lib/server/llm-seam.test.ts` fails the server project if anything does.
A feature that wants a model calls `complete(db, userId, { purpose, system,
messages, schema, kind })` and gets a typed object back.

What the seam guarantees, and what a second path would silently lose:

- **A `llm_calls` row on every path** — ok, schema miss, provider error,
  timeout, cap refusal, not configured — written before the typed error is
  thrown, so the error's `callId` names a row that exists.
- **The per-user hourly cap** (in-memory, the login throttle's shape) and the
  timeout.
- **No secrets, no prompts.** The API key is never logged, stored, or put in an
  error. Prompt text is stored only with `LLM_STORE_PROMPTS=1`; otherwise only
  `prompt_hash`.
- **Lazy config.** `process.env` is read on the first call, never at import or
  boot, so the app runs and CI passes with no LLM variable set. A missing key is
  `LlmNotConfigured` for the caller, not a boot failure. There is no default
  model id: `LLM_MODEL` is required when the layer is used.

- **Send a plain schema; validate with zod.** `wireSchema` (optional) is the
  JSON schema the provider receives, while `schema` still validates the reply.
  Use it whenever the zod schema carries constraints (lengths, ranges,
  defaults, preprocess): strict structured output compiles all of them, and
  the derived photo schema took 15-16 s per call against 3.7-7 s plain (0.4.4).
  `photos/candidate-wire.test.ts` is the pattern for keeping the two in step.
- **Replies are lenient where meaning is preserved, strict where it is not.**
  A missing key reads as unknown and a synonym maps to its enum value (0.4.1,
  0.4.3); a wrong type is still a `schema_error`. Real models omit and reword.

Adding a provider is a `case` in `llm/provider.ts` and a dependency. See
`docs/llm.md`.

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

Since T3, and enforced by the database since migration 0011, **every row of
user data belongs to exactly one user**. There is exactly one exception, and it
is not user data: the **global equipment catalog** in `equipment_models` (see
below). No other table has shared or global rows, and none may gain them.

The eight directly-owned tables, the ones 0011 makes `user_id NOT NULL`:
`programs`, `gyms`, `exercises`, `sessions`, `sets`, `pain_events`,
`workout_log_imports`, `program_draft_requests`. Since 0.3.1 (migration 0013)
`llm_calls` is a ninth, created `user_id NOT NULL` from the start; only
`complete()` writes it.

Everything else is owned through a parent chain. Resolve it; never widen it.

| Table                    | Owned by                                                          |
| ------------------------ | ----------------------------------------------------------------- |
| `days`                   | `program_id` → `programs.user_id`                                 |
| `day_exercises`          | `day_id` → `days` → `programs.user_id`                            |
| `prescribed_sets`        | `day_exercise_id` → `day_exercises` → `days` → `programs.user_id` |
| `session_exercises`      | `session_id` → `sessions.user_id`                                 |
| `imported_workouts`      | `import_id` → `workout_log_imports.user_id`                       |
| `gym_equipment`          | `gym_id` → `gyms.user_id`                                         |
| `equipment_models`       | `owner_user_id` (direct, nullable — see the catalog exception)    |
| `exercise_equipment_map` | through its parent exercise/gym rows                              |

### The one exception: the global equipment catalog

`equipment_models.owner_user_id` is nullable (it has been since 0009, and 0011
deliberately left it so). Since 0.3.0 (migration 0012) the NULL rows are the
manufacturer catalog. The rule is exact:

- **Global rows (`owner_user_id IS NULL`) are read-only catalog data.** They are
  written by exactly one path, `pnpm catalog:import` (`scripts/catalog-import.ts`),
  from a dated snapshot in `data/catalog/`. No app route, action, or `lib/server`
  function inserts, updates, or deletes one. A user who wants different numbers
  gets an owned copy (`/equipment/[id]/edit` → "create my own copy").
- **Owned rows (`owner_user_id = userId`) are user data**, under every rule in
  this section: D5 signatures, D6 404s, cross-tenant tests.
- **Reads are `owner_user_id IS NULL OR owner_user_id = userId`.** Another user's
  owned row is a 404, exactly like a missing id; a global row is visible to all.
  Two predicates in `catalog.ts` encode it, and the difference matters:
  `modelVisibleTo` (lists, search, pickers, new links, photo matching) also
  excludes **retired** global rows; `modelReadableBy` (one model by id, e.g.
  `/equipment/[id]` and machines already linked) does not, so a retired model
  still renders for the machines that point at it. Never widen a list to
  `modelReadableBy`, and never narrow a by-id read to `modelVisibleTo`.
- **Retirement, not deletion (since 0.3.2, migration 0015).** The importer sets
  `retired_at` on every global row a snapshot no longer contains, and clears it
  when a later snapshot brings the row back. Catalog rows are never deleted,
  because `gym_equipment` and `equipment_photos` may reference them. A snapshot
  is the whole catalog: importing a partial CSV would retire everything it
  leaves out.
- **Writes only ever target owned rows:** every UPDATE/DELETE from the app
  carries `owner_user_id = userId` in its WHERE, never `IS NULL`.
- The importer never touches a row whose `owner_user_id` is not null, and the
  partial unique index `equipment_models_catalog_code_unique` covers only
  global rows, so an owned copy may reuse a catalog code.

Nothing about the catalog widens any other table: `gym_equipment` rows that
point at a global model are still owned through `gym_id` → `gyms.user_id`.
See `docs/catalog.md`.

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

**A fixture that is always fresh is not a neutral fixture — it is an invisible
filter over the bug space.** Every auth e2e signed in with an empty cookie jar,
which is precisely the condition under which the sign-in 403 does not reproduce,
so 34 e2e tests passed while the owner could not sign in from any device that
had ever visited. At least one auth e2e must run in a context that already holds
an unrelated cookie before sign-in.

**The served build runs in production's mode, not the test runner's.** Even
with a cookie, the harness could not reproduce that 403 — because
`startTestServer` spawned the build with `...process.env`, which carries
Vitest's `NODE_ENV=test` and `TEST=true`, and Better Auth switches its origin
check off in test mode (`skipOriginCheck` defaults to `isTest()`). So every e2e
ran against a build with a security check the container always runs. The
harness now sets `NODE_ENV=production` and drops `TEST`, keeping `VITEST` for
the database-name guard. `e2e/sign-in-origin.e2e.ts` holds the canary: a
cookie-bearing sign-in without `Origin` must be refused 403. And the check no
longer depends on the environment at all: `auth-core.ts` pins
`advanced.disableOriginCheck: false`, proven by an in-process test that runs in
test mode and fails without it. Production's CSRF protection must never rest
on `NODE_ENV` being set correctly. Any library that
branches on the environment is a place where the harness and production can
silently differ; when a test cannot reproduce a production failure, diff the
environment before concluding the bug is elsewhere.

**A served build is stopped with the `stop()` that `startTestServer` returns,
and nothing else.** SIGTERM does not stop it: adapter-node closes the HTTP
server and waits for the event loop to drain, and the Postgres pool never lets
it. Four files that called `server.kill()` left five `node build/index.js`
processes per run while the suite stayed green. `stop()` SIGKILLs and awaits
`exit`; `startTestServer` stops its own child when startup fails; and
`e2e/global-setup.ts` fails the run, naming the file, if any spawned server is
alive at the end.

**Every handler status gets its own reason, and only 401 counts as a
failure.** The 0.2.1 catch-all mapped every non-2xx to "that email and password
do not match" and recorded all of them against the throttle, so a security
rejection displayed as a wrong password AND made the next attempt slower. A
status you cannot tell apart on the page is a status you cannot diagnose.

**An enum variant with no producer is a question, not dead code.** The
`reason: 'origin'` variant was deleted as "nothing produces this" — and the
reason nothing produced it was the bug it was pointing at. Find the answer
before removing the question.

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
Duplicating rows is the deliberate cost of having no cross-tenant table. (The
equipment catalog is the single shared table, and it is reference data that no
user can write; it is not a precedent for sharing user data.)

`0001`/`0011`: migration 0011 backfills every pre-existing row to one
placeholder owner, the sentinel `00000000-0000-4000-8000-000000000001`. It is
claimed by `pnpm user:bootstrap`, which keeps that id — so the backfilled rows
stay attached — and gives it a real email and a credential row. Until bootstrap
runs, the data is owned by an account nobody can sign in as.

## Shipping and production

Owner rules (2026-10-01). They govern how a change reaches `main` and
production, not what the change is.

**`main` moves only on a green gate, twice.** Push `main` only after the full
local gate passes the way CI runs it — `pnpm lint`, `pnpm check`,
`pnpm exec drizzle-kit check` (with `DATABASE_URL` set), the `server`, `demo`
and `client` projects, `pnpm build`, and `pnpm test:e2e` under `CI=1` so a
missing prerequisite fails instead of skipping — **and** CI is green on the
branch. Watch it with `gh run watch`; do not infer it.

**Owner-approved exception (2026-10-01): Markdown-only changes.** When every
changed file is Markdown (`*.md`), the local gate is `pnpm lint` only, plus CI
green on the branch. Any other file in the diff, even one, means the full
gate above. Changes to `CLAUDE.md` or `.claude/` still need the owner to read
the diff before they reach `main`.

**No force-push to `main`, and no squash.** History on `main` is a record. A
wrong commit gets a fix-forward commit that says what it fixes.

### Development-push mode (owner decision, 2026-10-01)

In force now. It governs `scripts/compose-prod.sh`, `scripts/migrate-prod.sh`,
`scripts/user-prod.sh` and `scripts/catalog-prod.sh`.

- **The assistant may run the production wrappers itself**, including typed
  confirmations (`IMPORT`), but only after all three:
  - a verified backup;
  - a dry run, where the wrapper has one;
  - totals that match what it expected.

  A mismatch means stop and report, never confirm.

- **Quiet check before any deploy:** no open workout for any user, and no
  activity in the last 30 minutes. Otherwise wait and retry.
  - **There is no request log.** The web log carries only app events
    (`login_attempt`, `password_change`, `photo_upload`, config lines), so
    the check is the open-workout query, the most recent write time, and
    the app events in the log:

    ```sh
    q() { sudo -n scripts/compose-prod.sh exec -T db psql -U doclifts -d doclifts -tAc "$1"; }
    # 1. Open workouts with activity in the last 6 h. Must be 0.
    q "select count(*) from (select s.id from sessions s
         left join sets st on st.session_id = s.id
         where s.ended_at is null and s.deleted_at is null
         group by s.id
         having greatest(s.started_at, max(st.logged_at)) > now() - interval '6 hours') b"
    # 2. Time since the most recent write anywhere. Must be over 30 min.
    q "select now() - greatest(
         (select max(logged_at) from sets), (select max(started_at) from sessions),
         (select max(ended_at) from sessions), (select max(created_at) from equipment_photos),
         (select max(created_at) from llm_calls), (select max(updated_at) from programs),
         (select max(updated_at) from auth.session))"
    # 3. App events in the last 30 min. Must be 0, not counting the
    #    assistant's own scratch-account checks.
    sudo -n scripts/compose-prod.sh logs web --since 30m \
      | grep -cE '"event":"(login_attempt|password_change|photo_upload)"'
    ```

  - **An open workout with no activity for 6 hours does not block a
    deploy.** Query 1 counts only workouts active within 6 hours (its
    start, or its latest saved set).

- **Migrations** only after the full chain passes on a restore of the nightly
  dump, with a verified dump taken immediately before (`migrate-prod.sh`
  takes and verifies it).
- **The owner reads the diff first** for any change to sign-in, sessions,
  origin or CSRF settings, or the tunnel configuration.
- **Keep the previous image until the owner signs off the release.** Before
  any production build:

  ```sh
  docker tag doclifts-web:vps doclifts-web:pre-<version>
  ```

  Delete `pre-<version>` only after the owner's sign-off, not merely after the
  assistant's checks.

- **If post-deploy checks fail, roll back to `pre-<version>` and report:**

  ```sh
  DOCLIFTS_WEB_IMAGE=doclifts-web:pre-<version> \
    sudo -n scripts/compose-prod.sh up -d --wait web
  ```

  Do not retry forward unattended. A fix ships as a new release, through the
  gate, after the owner has seen the report.

- **A release with an owner-only check still owed** (a real-phone test, a
  first real use) is recorded as "deployed, acceptance pending", in the
  runbook and the CHANGELOG, until he signs it off.
- **Test users are told this is a test system.**
- **This mode ends** at the first paying customer, or the first user promised
  uptime. Then the rule below returns.

**When development-push mode ends:** nothing touches production without the
owner's explicit "go" in the current session. A "go" from an earlier session,
a handoff, or a plan is not one. The image rule above still applies.

In either mode, run the `*-prod.sh` wrappers on the VPS over SSH, never from
another machine against its Docker socket.

**Secrets never appear in chat, commits, logs, or docs.** Not passwords, not
`BETTER_AUTH_SECRET`, not database URLs with credentials, and that includes
"just for the record" quotes in a release log. Passwords reach the CLI through
`--password-stdin` from the owner's own shell, never typed into a command line
by an assistant. A log line may carry a length or a hash of a secret, never the
value.

**Every key in the production env file needs a passthrough line in
`docker-compose.yml`.** Compose enumerates the container environment
explicitly, so a key added to `/srv/doclifts/.env` without a matching
`environment:` entry is silently absent in the container — and every check
still passes, because the env file looks right. That is how the 0.2.2 deploy
kept the default ceiling of 10 with `LOGIN_MAX_FAILURES=0` in the env file. A
new tunable is not done until it has its line. `scripts/compose-prod.sh` enforces
it: before any `up`/`create`/`run` it runs `scripts/check-env-passthrough.sh`,
which refuses the deploy and names every env-file key that `docker-compose.yml`
never references as `${KEY…}`. (By name, not against rendered `compose config`:
the rendered output carries values, and `POSTGRES_PASSWORD` is consumed only by
interpolation.) The `LOGIN_*` and `PASSWORD_MIN_LENGTH` compose defaults are also
unit-tested against the code defaults.

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
- `src/lib/server/catalog.ts` — equipment model reads (`modelVisibleTo`, browse, picker) and the owned-row writes (edit, copy). The only place model visibility is decided.
- `src/lib/server/catalog-import.ts` + `scripts/catalog-import.ts` (`pnpm catalog:import <csv> [--dry-run]`) — the only writer of global catalog rows. `data/catalog/` holds the dated snapshots; `docs/catalog.md` describes them.
- `scripts/catalog-prod.sh` — runs the importer against production (verified dump, dry run, typed confirmation). Mirrors `migrate-prod.sh`. Takes a committed CSV by a path relative to the repo root, or (0.5.1) a readable CSV outside the repo by absolute path, bind-mounted read-only at `/import/catalog.csv`; anything else is refused. The path rules are `resolve_catalog_csv` in `scripts/catalog-csv-path.sh`, tested by sourcing only that file (`catalog-prod.test.ts`); the wrapper is never run by a test.
- `src/lib/server/llm/` — the LLM seam: `complete()` and `usageForUser()` (`index.ts`, `usage.ts`), lazy env config (`config.ts`), the provider switch (`provider.ts`), the per-user cap (`cap.ts`). The only importer of `ai` / provider SDKs. `scripts/llm-ping.ts` (`pnpm llm:ping`) is its smoke test. See `docs/llm.md`.
- `src/lib/server/photos/` — equipment from a photo (0.4.0): `store.ts` (S3 or memory, `PHOTO_STORE`), `process.ts` (sharp: orient, 1600 px, metadata stripped), `analyze.ts` (`EquipmentCandidate`, `CANDIDATE_WIRE_SCHEMA`, the one `complete()` call), `match.ts` (exact, leading-digit, prefix, name; through `modelVisibleTo`), `confirm.ts` (link / create / discard). Images are served only by the guarded `/photos/[id]/image` route. See `docs/photos.md`.
- `src/lib/photo-client.ts` — resize on the phone before upload (0.5.0): `photoClientSettings` is the only place its numbers and progress labels live (`enabled`, `maxEdgePx`, `jpegQuality`, `skipBelowBytes`, `timeoutMs`, `labels`). `resizeForUpload` never throws and falls back to the original file; the server's `processPhoto` stays the authority.
- `compose.demo.yml` — isolated, localhost-only temporary demo; does not mount production data or read `.env`.
- `src/lib/server/db/index.ts` — Drizzle client singleton
- `src/lib/server/progression.ts` — engine + history helpers
- `src/lib/server/plates.ts` — plate snap algorithms + router
- `src/lib/server/quick-workouts.ts` — workouts with no program (0.5.1): `ensureQuickProgram` (the one hidden system program per user, `programs.system_kind = 'quick'`, idempotent through `programs_one_quick_per_user`), `startQuickSession` (gym checked first, then `startSessionForDay`, then `sessions.gym_id`), the gym step's reads. System programs never appear on Home, the program page or the editor.
- `src/lib/workout-ui.ts` — `workoutUi`, the only place the quick-workout strings and defaults live ("Start workout", "Quick workout", the placeholder name, rest seconds). Tests read the strings from it.
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
