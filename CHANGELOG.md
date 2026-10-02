# Changelog

## 0.5.2 — a misread code can't pick the wrong machine — not yet released

- **The app no longer pre-picks a machine when the code and the name
  disagree.** If the model reads a real model code that belongs to a
  different machine (a Booty Booster placard read as gym80 4157, which is a
  barbell rack), nothing is chosen for you: the code's machine is shown
  first, then the machines whose names match what was read, with a line
  saying why. When the code and the name agree, it is pre-picked as before.
  The maker's name and product line ("Pure Kraft") don't count as agreement.

## 0.5.1 — start a workout without a program — 2026-10-02

- **Start a workout with no setup.** Home has a big "Start workout" button
  above "Create program". Pick your gym (the one you used last is already
  chosen; on your first time, just type your gym's name) and the workout
  opens, ready for you to add the first exercise. No program to build first.
- **Pick up where you left off.** While that workout is open, the button
  reads "Resume workout".
- **Last time's numbers come back.** Add the same exercise on the same
  machine next time and the weight from your last workout is filled in, with
  "Last: …" under it, just as in a program workout.
- **Exercises go in the workout's gym** unless you pick another.
- **History and Reports include these workouts**, labelled "Quick workout".
  The program list doesn't show them: there is nothing to edit.
- **Photo reading is more careful with model codes.** When any character of
  a machine's model code is hard to read, it now leaves the code blank and
  says what it could make out, instead of guessing. A wrong code is worse
  than none: on real placards this cut wrong codes from 5 to 1 in 30 reads,
  with every correct code still read.
- **For the owner:** the catalog import script now accepts a snapshot kept
  outside the repository, by its full path, and its confirmation prompt is a
  whole line.

## 0.5.0 — photos upload faster — 2026-10-02

- **Photos shrink on your phone before they upload.** A camera photo is 3 to
  5 MB; the browser now resizes it (longest side 2000 px) before sending, so
  far less goes over gym Wi-Fi or cellular. In testing a 2.5 MB photo went up
  as about 0.65 MB. The server still checks and processes every photo exactly
  as before, so what is stored and read is unchanged.
- **If resizing doesn't work, nothing breaks.** A format the phone can't
  resize, an old browser, or a resize that takes more than 4 seconds just
  sends the original photo, as before. With JavaScript off the original is
  sent, as before.
- **The button says what is happening:** "Preparing photo" while it is
  resized, then "Identifying machine…" while it uploads and the placard is
  read.
- **A dropped connection doesn't lose your photo.** If the upload never
  gets through (gym Wi-Fi), the page says so and keeps the photo you picked;
  tap Upload again.

## 0.4.7 — Home shows only your programs — 2026-10-01

- **Home lists only your own programs.** It listed every account's active
  programs, so a second user would have seen your program names (opening one
  already said "not found"). Fixed before the first invited tester gets an
  account. Every other list and lookup was audited and is owner-scoped.

## 0.4.6 — the phone can't change your password behind your back — 2026-10-01

- **Password fields no longer autocapitalize or autocorrect.** With Show on, a
  password field is plain text, and the iPhone capitalized or corrected what
  was typed, the same way in both "new password" boxes, so a different
  password from the one you meant was saved and signing in then failed.
  Every password field now has the phone's typing assists turned off, shown
  or hidden.

## 0.4.5 — fits a phone — 2026-10-01

- **The menu fits a phone screen.** "Gyms" was cut off at the left and "Sign
  out" at the right; the menu now wraps onto a second row instead.
- **"Added to Gold's Gym Friendswood as …"** has its space back (it read
  "Friendswoodas").

## 0.4.4 — photo analysis about four times faster — 2026-10-01

- **Reading a placard takes seconds, not most of a minute.** The model was
  being handed a description of the answer full of length limits and ranges,
  and with strict output that alone took 15-19 seconds per photo, sometimes
  past the time limit, which is why uploads felt stuck. It now gets a plain
  description (3-7 seconds measured); the app still checks every answer just
  as strictly before using it.

## 0.4.3 — photo analysis accepts the model's own wording — 2026-10-01

- **A placard read correctly is no longer refused for an odd word.** Your
  first two real photos were read right ("Hammer Strength Iso-Lateral Row,
  start 12 lb"; "Hammer Strength Leg Curl") and both refused, because the
  model said "iso-lateral" and "weight stack" instead of the words the app
  expects. Those and similar words now map to independent arms, selectorized,
  plate loaded or cable; anything else reads as unknown rather than throwing
  the photo's reading away.

## 0.4.2 — choose a photo you already took — 2026-10-01

- **Adding a machine from a photo offers your photo library and files, not
  only the camera.** On Android the page opened the camera directly, so a
  placard photo already on the phone could not be picked. Now the phone asks:
  take a photo, choose from the library, or browse files.

## 0.4.1 — photo analysis tolerates an incomplete reply — 2026-10-01

- **A photo whose placard was read correctly is no longer thrown away for a
  missing field.** The first real analysis in production read "Hammer
  Strength · Iso-Lateral Row · IL-ROW" perfectly and was refused because the
  model left out the product line it had nothing for. A field the model leaves
  out now counts as unknown, exactly as if it had said so; a wrong value is
  still refused.

## 0.4.0 — equipment from a photo — 2026-10-01

- **Add a machine by photographing its placard.** Under each gym on **Gyms
  and machines**, "Add a machine from a photo" opens the camera. The photo is
  read for the maker, model code and name, and you see what was read next to
  the photo, with anything uncertain marked "check".
- **You choose what is added.** The page lists matching models from the
  catalog and your own: an exact code match is chosen for you, a catalog base
  code that the placard prints as a longer code is offered as a prefix match,
  a code that differs only by a leading digit (Nautilus 9NP-L3004 vs NP-L3004)
  as a leading-digit match,
  and otherwise the closest names are listed. Link one, create your own model
  from what was read (every field editable), or discard the photo. Nothing is
  added until you do.
- **The photo stays with the machine.** A machine added from a photo shows it
  as a thumbnail on **Gyms and machines** and on the model's page.
- **Private by design.** Location, camera and time details are removed from
  the photo before it is stored or read; the photo is stored privately and
  shown only to you. Up to 20 photos a day, 10 MB each.

## 0.3.2 — machine labels, machine edit, and the researched catalog — 2026-10-01

- **The machine catalog grows from 543 to 890 models,** researched from the
  manufacturers' own pages: all but 21 now have a model code (210 had none
  before), 17 wrong codes are corrected, and 98 models now show the
  manufacturer's starting weight. Machines you already added stay linked to
  the same model.
- **A machine's label is optional when you pick its model.** Adding a machine
  on **Gyms and machines**, or from a model's page, no longer makes you invent
  a name. Leave the label blank and the machine is named after its model, for
  example "Hammer Strength Iso-Lateral Row (IL-ROW)". A label you type still
  wins, and is the way to tell two of the same model apart. With no model, a
  label is still needed, and the page says so.
- **Edit a machine's label, stack and increment.** Each machine on **Gyms and
  machines** now has an **Edit** link. Clear the label and it goes back to
  the model's name; logged history stays with the machine.
- **Adding a machine fills in the manufacturer's standard stack.** A model's
  page shows its standard weight stack (355 models have one), and adding that
  model to a gym fills the stack in for you. Type a different number if your
  gym's machine has a heavier stack; what you type always wins.
- **Placeholder product lines are hidden once their real models are in the
  catalog.** Seven entries that only named a product line (such as Cybex VR3
  or Technogym Artis) are replaced by the actual machines. They no longer
  appear in the catalog or the model picker, but any machine already linked to
  one keeps it, and its page still opens, marked "No longer in the catalog".
- **Catalog notes on each model's page.** The catalog's own remarks (298
  models have one, such as "code unknown — verify") now show on the model's
  page, and come along when you create your own copy.
- **A catalog update that adds or corrects a model code keeps your machines
  attached.** When a newer catalog gives a code to a model that had none, or
  corrects a manufacturer's code, the existing model takes the new code
  instead of a duplicate appearing beside it, so machines you already added
  stay linked to it.

## 0.3.1 — LLM adapter foundation — 2026-10-01

LLM adapter foundation (no user-visible features yet).

- **One way to ask a model for something.** `complete()` returns an object
  checked against a schema, or a typed error. OpenRouter is the first provider;
  others are a configuration addition.
- **Every call is recorded** in a new `llm_calls` table (migration 0013): who,
  what for, which model, tokens, how long, and how it ended — including calls
  that failed, timed out, or were refused. Prompts are not stored unless
  `LLM_STORE_PROMPTS=1`; the API key is never stored or logged.
- **A per-user hourly limit** (60 by default) and a 30-second timeout.
- **Nothing changes if it is not configured.** The app runs without any LLM
  setting; `pnpm llm:ping` checks a key once one is added.

## 0.3.0 — equipment catalog — 2026-10-01

- **A catalog of 543 machines from 8 manufacturers.** gym80, Matrix, Precor,
  Hammer Strength, Technogym, Life Fitness, Nautilus and Cybex, read from their
  own catalogs (or dealer listings and manuals) on 2026-09-30. Browse it under
  **Equipment** in the nav: filter by manufacturer, product line, loading type
  and body region, or search a name or model code such as `IL-ROW`.
- **Every model says how sure it is.** Rows read from a manufacturer's page or
  a manual link to their source; rows that were inferred are marked
  **unverified**, so check the placard on the machine before trusting them.
- **Add a model to your gym from its page,** with the stack size and increment
  of the machine in front of you. Stack size is recorded per machine, because
  the same model is sold with different stacks.
- **Wrong starting weight? Make it yours.** The catalog is shared and is not
  edited in place. "Create my own copy" saves your numbers for you alone; your
  own models are marked **yours** and stay private to you.
- **The model picker on Gyms and machines stays short.** It shows models from
  the manufacturers already in that gym, with "Show all manufacturers" and a
  search box for the rest.
- Live workout pages no longer carry the whole model list, which they never
  used.

## 0.2.5 — login delay notice — 2026-10-01

- **The sign-in page says when it is making you wait.** After five failed
  sign-ins each further attempt is held before the password is checked — 1,
  2, 4, 8, 16, then 30 seconds — and until now the page just hung. The
  failure that starts the delay now says how long the next attempt will be
  held; a held attempt says how long it was held and how long the next will
  be; and while a held attempt is in flight the page counts down. The message
  sits beside "That email and password do not match", not in place of it, and
  works without JavaScript. Nothing about the throttle itself changed, and an
  address with no account sees exactly the same notice as one with.

## 0.2.4 — account management and password policy — 2026-10-01

- **Change your password in the app.** `/account/password` asks for the current
  password and the new one twice. On success every other device is signed out
  and the one you are using stays signed in. No command line involved.
- **Show / Hide on every password field,** so you can see what you typed
  before submitting it.
- **Passwords have a minimum length, and nothing else.** 12 characters by
  default (`PASSWORD_MIN_LENGTH`, 8–128), no rules about symbols or digits. It
  applies when a password is set, never at sign-in, so raising it cannot lock
  anyone out of a password they already have.
- **The longest sign-in delay is now 30 seconds** (was 8), and a malformed
  sign-in setting now stops the app at startup, naming the variable, instead
  of quietly falling back to a default.
- **A sign-in page left open across a password change still works** with the
  new password.
- **Deploys refuse a setting the app would never see.** A key in the
  production env file with no matching line in `docker-compose.yml` now stops
  the deploy and names the key, instead of being silently dropped.
- Better Auth's cross-site check is pinned on in code, so it no longer depends
  on the environment the app happens to run in; and the app now exits cleanly
  when stopped.

## 0.2.3 — sign-in lockout fixed — 2026-10-01

- **Signing in works again from any browser that had visited before.** Any
  browser holding a cookie — even an unrelated one — had its sign-in rejected
  by a cross-site check before the password was ever compared, and the page
  reported it as "that email and password do not match". The password was
  correct the whole time. Sign-in and sign-out now pass the browser's real
  origin through, so the check runs and passes.
- **Every sign-in setting reaches the app.** `LOGIN_MAX_FAILURES=0` in the env
  file had no effect because the container never received it; every sign-in
  setting now has its line in `docker-compose.yml`.

## 0.2.2 — cache correctness and observability — 2026-10-01

Five changes, all from one incident: being locked out of your own account with
a correct password, and having no way to find out why.

- **The sign-in page is no longer cacheable.** `/login` was public, so the
  0.2.1 `no-store` deliberately skipped it — and because the page set no policy
  of its own, a response with no `Cache-Control` is free for a browser to store.
  Every rendered page is now `no-store` regardless of who can reach it, and
  only immutable build assets keep their caching.
- **A redirect to the login page carries `no-store` too.** An anonymous
  request to a guarded page was answered `303 -> /login` with no cache policy at
  all, because SvelteKit discards headers set on a thrown `redirect()`. The same
  storeable-redirect problem, in a new place.
- **One line per sign-in attempt.** Every attempt — success, wrong password,
  missing field, throttle — writes one structured record with the outcome, the
  status, a hashed email, a hashed user agent, the password's length, and
  whether it arrived with a stray space on the end. Never the password, never
  the address. Until this existed, a request that arrived and was rejected was
  indistinguishable from one that never arrived at all, which cost an evening
  of looking in the wrong place.
- **Stale builds detect themselves.** The client polls the deployed build's
  commit sha and reloads when it changes, instead of running old code against a
  new server.
- **`LOGIN_MAX_FAILURES=0` means no ceiling.** It had been read as "allow zero
  failures", which refused every attempt; 0 now turns the hard limit off and
  leaves only the delay.

## 0.2.1 — 2026-09-30

Hotfix for three defects found by using the released app rather than testing
it. All user-visible.

- **The back button no longer shows a signed-out user's data.** Sign in, open
  `/history`, sign out, press BACK: the browser re-rendered the page from its
  own cache, showing your workouts with no login form and nothing you could do.
  The server was correct throughout — the session was destroyed and a client
  that kept the cookie was refused — but nothing told the _browser_ not to keep
  the page. Authenticated responses now carry `Cache-Control: no-store` and
  `Vary: Cookie`.
- **There is a sign-out button.** The POST action existed since 0.2.0, worked,
  and answered 405 to GET on purpose — and nothing rendered it anywhere, so
  there was no way to log out from the UI at all. It is in the nav, as a form
  and not a link, so a prefetch or an `<img>` can never sign you out.
- **Signing in repeatedly no longer locks you out; only wrong passwords
  count.** Better Auth's limiter charges its budget _before_ checking
  credentials, so a **successful** sign-in cost one of three attempts per ten
  seconds. Four correct-password sign-ins in quick succession refused the
  fourth, and a user who signed out and straight back in could not get in.
  Sign-in is now throttled on failed attempts only, per client IP and per
  account, with a progressive delay and a clear "try again in N seconds".
- **Sessions last 30 days, sliding.** You were not logged out of your own
  training log for missing a week.
- **Tunable via env, no release needed.** `LOGIN_MAX_FAILURES`,
  `LOGIN_FAILURE_WINDOW_SEC`, `LOGIN_DELAY_AFTER_FAILURES`,
  `LOGIN_DELAY_BASE_MS`, `LOGIN_DELAY_MAX_MS`, `SESSION_EXPIRES_DAYS`. All
  optional, all defaulted, all in `.env.example` and the README's "Tuning"
  section. Change one and restart the container.

## 0.2.0 — accounts — 2026-09-30

Behavior changes since 0.1.0 that a user would notice:

- **Sign-in is rate limited, and for the first time it actually was.** The limiter is Better Auth's `onRequestRateLimit`, which runs inside `auth.handler`; the `/login` action called `auth.api.signInEmail()` directly, a server-side API call the library documents as NOT rate limited. Six consecutive wrong-password attempts to `/login` all returned 200 at a configured 3-per-10s, so password guessing was unbounded while `rateLimit: { enabled: true }` sat in the config looking like protection. The action now builds a real request for `/api/auth/sign-in/email` and hands it to the handler. Measured after the fix: 3 attempts allowed, the 4th refused with 429 and a `Retry-After`, and a correct password accepted once the window passes. The limit is per client IP, read from `X-Forwarded-For`; a second IP signing in as the same account is unaffected, because per-account lockout is a separate control that is not implemented.
- **zod `4.4.3` → `4.6.5`.** Required by the fix above, not cosmetic. Better Auth 1.7.6's IP resolution calls `z.validate`, introduced in zod 4.6. The app pinned `^4.4.3`, the build emits a bare externalized `import * as z from 'zod'` for the auth package, and that resolved to the app's copy rather than the 4.6.5 the auth stack bundles — so every sign-in returned a generic 500. DocLifts was the only consumer of 4.4.3, so nothing else moved. The `jitless` CSP fix from 0.2.0's CSP entry is unaffected: the guard is still present in `zod/v4/core/util.js` under the same config key.
- **Sign-up is closed and stays closed.** There is no `/signup` page. `DOCLIFTS_OPEN_SIGNUP` is a Better Auth policy switch with no page behind it, so setting it opens the library's endpoint and nothing else; it must stay unset until a real route exists.
- **Accounts are per-user, and no row is shared.** Every row belongs to exactly one account, enforced by the database since this release. Cross-tenant reads are 404, not 403 — a 403 confirms the resource exists. Each new account gets its own copy of the 23 starter exercises rather than a shared catalogue. Signing in shows only your own data; there is no longer any state in which two people using one install see the same workouts.
- **The Tailscale-only install gets HTTPS.** Production is served at `https://enochnvps.tail29bbdb.ts.net` through Tailscale Serve, on a real Let's Encrypt certificate, reachable only from your tailnet. The app behind it publishes on the VPS tailnet IP and trusts `X-Forwarded-Proto`/`X-Forwarded-Host` from that proxy, which is safe while nothing off-tailnet can reach the port. A public deployment must bind only to the proxy's network and the proxy must overwrite, not append, forwarded headers.
- **A fresh install starts with an operator account instead of a stranded sentinel.** Migration `0011_ownership_not_null` points pre-existing rows at a placeholder account so ownership can become `NOT NULL`. Until that account is claimed, the app serves pages, passes its healthcheck, and shows data nobody can sign in to. Startup now says so in a log banner, and `pnpm user:bootstrap` claims it — keeping the placeholder's id, so the existing rows stay attached. Your workouts appear the moment that runs.
- **`pnpm user:bootstrap` / `user:create` / `user:set-password`.** The accounts CLI, runnable outside SvelteKit. `scripts/user-prod.sh` is the production form; it needs no backup, because it touches one account row.

- **CSP `unsafe-eval` violation on `/programs/new` and `/programs/[id]/edit`.** Since 0.1.0 both program-editor routes raised a `script-src blocked eval` violation against the strict nonce CSP. The cause is zod 4's `allowsEval` probe (`zod/v4/core/util.js`), a `new Function('')` whose throw is swallowed but still reported by the browser. Fixed with `z.config({ jitless: true })` in `src/lib/program-draft.ts` — no CSP change and no dependency change. The crawl was clean over the routes it visited; it did not visit these two, which is why this survived since 0.1.0. The crawl floor in `e2e/csp.e2e.ts` now covers all ten route patterns and fails by name if one is listed but never reached.
- **Deployment is Compose-only.** The systemd unit (`deploy/doclifts.service`), `scripts/deploy-safe.sh`, `scripts/verify-doclifts-up.sh`, and the `pnpm redeploy` script are removed. The unit was already `not-found` on the host; production runs through Compose. Use `scripts/compose-prod.sh` for Compose and `scripts/migrate-prod.sh` for migrations — both pass the production env file explicitly. The old path's one unique feature, the pre-migrate dump, is preserved: `scripts/migrate-prod.sh` takes a custom-format `pg_dump`, verifies it with `pg_restore --list`, refuses to migrate if that fails, and keeps the newest 14. Rollback is a documented manual `pg_restore` in the README, not automatic.
- **Production's env file moved out of the checkout, for good.** It lives at `/srv/doclifts/.env` (or `DOCLIFTS_PROD_ENV`). The checkout's `.env` was a symlink to it, which made every tool run from the checkout — vitest, drizzle-kit, `tsx` — read production credentials by default. The symlink is gone and the checkout now has its own development `.env` with no `POSTGRES_PASSWORD`, so a bare `docker compose` there fails loudly instead of quietly reusing production. `TEST_DATABASE_URL` moved out of the production file into the development one.
- **A test run can no longer write to a real database.** `db/index.ts` refuses to build a client under vitest against any database whose name does not end in `_test`, and `vite.config.ts` forces `DATABASE_URL` to the test database before any test module loads. Both are covered by tests.
- License changed from Apache-2.0 to the Functional Source License, Version 1.1, ALv2 Future License (FSL-1.1-ALv2). Self-hosting, internal use, and non-commercial use are unaffected; offering DocLifts as a competing commercial service is not permitted until each version's two-year conversion to Apache-2.0. Release 0.1.0 and everything before it stay Apache-2.0. `CONTRIBUTING.md` now carries DCO sign-off and contribution license terms; `.mailmap` normalizes author identities.

- Progression judges every working set against its own rep range and RIR target, not position 1's. An exercise that previously advanced can now hold when a later position misses its own range.
- Backoff and top rows on secondary/isolation exercises hold at their last load and say so ("held: no progression rule applies to this set"). One target-resolution helper now serves all three prefill paths, so a null rep-range top on the machine-bound path no longer clears on reps automatically.
- Plate snap returns 0, not the empty bar, for a zero or negative target.
- Reports completion bars render with a `<progress>` element. The strict Content-Security-Policy added on 2026-09-28 blocked the previous inline width style, so every bar drew at the same width.
- "Move to Trash" on an ended session uses the destructive button style again.
- `/history` lists sessions across all programs, including archived ones, by month. `/imported-history` shows the 500 most recent imports and discloses the cap.
- Strict nonce-based Content-Security-Policy on every response.
- Emptying a program's Trash checks the confirmed count and deletes in one transaction. A session trashed or restored in between now returns a count-changed error instead of being purged unchecked, and a Trash larger than 1000 sessions can be emptied.
- `/imported-history` labels the estimated-set count and the search as covering only the records shown when the 500-record cap is in effect.
- The favicon is served from `static/` instead of being inlined as a `data:` URI, which the Content-Security-Policy blocked on every page.
- CI: Prettier is a blocking check, and an end-to-end Chromium pass against the production build fails on any Content-Security-Policy violation.
- CI runs as one workflow inside the Playwright container image, including the component tests that the separate Browser CI workflow had silently stopped running after GitHub disabled it for inactivity on 2026-08-02. No browser install step; the image tag must match the `playwright` version.

## 0.1.0 — 2026-09-15

First Apache-2.0 open-source release.

- Standalone Docker Compose demo with fictional workouts, equipment, history, and a visible demo banner.
- Localhost-only access, a separate temporary database, automatic migrations, and guarded seeding that never truncates an existing database.
- Phone-friendly workout entry, searchable exercise selection, inline set/equipment creation, same-tab drafts, and simplified Trash controls.
- Machine-specific performance history, progression suggestions, program editing, and imported-history provenance.
- Apache license and attribution, contribution guidance, and documented demo startup/reset commands.

The demo is disposable and has no authentication. Use private infrastructure and a persistent database for real training data. Historical operational notes are excluded from source archives; existing Git history is not rewritten by this release.
