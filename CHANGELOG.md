# Changelog

## 0.18.1 Alpha — visible builds and one workout view system — not deployed

- Shows the release and loaded build on the sign-in page and signed-in header.
- Checks for a newer build when a tab opens or regains focus; an update prompt
  offers an explicit Refresh app button. No automatic refresh interrupts a set.
  Account includes Check for updates; a failed check never claims to be current.
- Removes the obsolete global Simple/Advanced switch, context and storage code.
  Workout View/Customize controls remain. Home and Account explain where to find
  the four layouts; program controls stay available without a global mode.
- No database, auth, progression, MCP or tunnel changes. Owner phone verification
  remains pending after deployment.

## 0.18.0 Alpha — workout layouts — deployed, acceptance pending

- Four workout views: Guided with an available private machine photo, compact
  Set table, dense Notebook and Tap sets. Quick workouts start Guided; planned
  workouts start in Set table. Switching preserves unsaved entries.
- Customize RIR (follow the set prescription, show or hide), notes, previous
  performance and optional weight/reps buttons. Choices belong to each account
  and program in the current browser; they do not sync between devices.
- Edit workout reveals the existing exercise and set controls. Changes apply
  to this session; the program editor and existing From now on swap remain
  available for future workouts.
- The clock opens rest settings: duration, an optional chime (off by default),
  pulse, small shake or text only. Reduced motion disables animation. Background
  and locked-phone alerts are not guaranteed.
- One set-save implementation serves all views. The timer is extracted and
  superseded set-entry markup is removed. No database migration, auth, MCP,
  progression or tunnel change. Owner gym acceptance is pending after deployment.

Deployed October 4, 2026 on `f1eff6f` (tag `0.18.0`) after PR23, full local
lint/types/Drizzle/build, 902 server tests (+2 expected private-data skips),
42 component tests and 176 browser tests. Exact-head CI37212527852 passed.
The fresh encrypted snapshot ca7887f8 restored with matching database totals,
24 photo hashes, seven SQLite integrity checks and scratch login/history.
Recovery images including pre-0.18.0 and earlier releases are retained.
Public Alpha scratch checks passed all four layouts, distinct drafts, hidden
zero RIR/notes, saving/reload, append/remove empty set, timer settings, 320/390px
fit and finish/history. No schema, auth or tunnel changes. Owner gym/phone
acceptance is pending; automated checks do not confirm actual phone audio.

## 0.17.0 Alpha — Simple and Advanced views — deployed, acceptance pending

- Adds a Simple / Advanced switch on signed-in screens, remembered separately
  for each account in the current browser. Simple is the default.
- Simple emphasizes weight, reps/seconds and Save set; notes and RIR stay one tap
  away. Switching views and saving collapsed controls preserve existing values
  and unsaved entries. Load-suggestion explanations stay visible.
- Program tools fold away in Simple while programs remain accessible. Fresh
  accounts can explore starter programs; the gym and empty-workout steps explain
  how to get to a first recorded set.
- Advanced exposes effort and program controls. No database, auth, API or
  progression changes. View choices do not yet sync across devices.

Deployed October 4, 2026 on `0633b6a` after full local checks: 901 server tests
(2 expected private-data skips), 40 component tests, 174 browser tests,
lint/types/Drizzle/build; exact-head CI37192805430 and CodeQL passed. The fresh
pre-0.17.0 dump restored with matching counts and an encrypted off-host snapshot
completed. Previous images remain retained. Public Alpha scratch checks passed
view switching, distinct set values/zero RIR/notes, saving while collapsed,
reload persistence, first-workout guidance, finish/history and 320/390px layout.
Owner phone acceptance remains pending. No schema, auth or tunnel changes.

## 0.16.4 Alpha — consent app identity — deployed, acceptance pending

- The consent page labels apps as unverified and explains that their names are
  self-supplied. A familiar name is not proof of identity.
- Shows the actual callback destination from the signed authorization request,
  including scheme and port, as plain text. Callback query values are not displayed.
- Browser regression covers an app named Muse selecting a misleading destination
  from multiple registered callbacks, and refuses a tampered signed destination.
- Existing consent, PKCE, scopes, CSRF, refresh and revocation controls remain.
  No schema or tunnel changes. Backups precede additional client acceptance work.

- Deployed October 3, 2026 on `12e1caf` after full local checks (901 server,
  40 component, 172 browser tests), exact-head CI37168910677 and CodeQL. Fresh
  backup restored with matching counts. Public scratch checks passed the identity
  display at three viewport widths, signed-destination tampering, deny/allow,
  PKCE exchange, refresh, eight-tool discovery and revocation. Recovery images
  retained; owner screen review remains pending.

## 0.16.3 Alpha — bulk and imported history for agents — deployed, acceptance pending

- Adds `list_workout_sets` for bulk app history with workout and historical
  exercise/machine context, reducing per-workout requests.
- Adds account-scoped `list_imported_workouts`, returning notebook workouts and
  their structured sets together in bounded pages. Existing app sessions stay separate.
- Preserves source-line provenance, uncertain dates, load conventions and explicit
  versus estimated set evidence. Notebook text requires optional `notes:read`;
  entire source documents and unrecognized JSON fields are never exported.
- Dictionary and tool descriptions explain both history collections, mixed test
  data, possible overlap and incomplete entries. No schema, auth or tunnel changes.

- Deployed 2026-10-03 on d56be47 after full local gate (901 server, 40 component,
  171 browser tests) and exact-head CI37165497476. Public tunnel checks passed
  for both history readers, pagination, notes excluded/included by consent,
  refresh/revocation and ordinary login/history. Real Muse imported/bulk tool calls are confirmed, with optional notes access
  authorized. Owner interpretation review and other clients remain separate checks.

## 0.16.2 Alpha — OAuth resource compatibility — deployed, acceptance pending

- OAuth clients such as Muse can omit the authorization resource parameter.
  DocLifts supplies its single MCP resource before provider validation and signing,
  keeping consent, authorization codes and tokens bound to that resource.
- Explicit resource values and signed continuations are never rewritten.
  Wrong targets, tampered requests, consent and revocation checks remain enforced.
- Browser regression coverage exercises login, consent, SDK reads, refresh and
  revocation with and without an explicit resource. No schema or tunnel changes.

- Deployed2026-10-03 on3d1c4a6 after full local and CI gates. Public missing-resource
  consent/read/refresh/revoke and normal login/history passed. Real Muse acceptance pending.

## 0.16.1 Alpha — MCP live — deployed, acceptance pending

- The production acceptance checks read the current Alpha test-account file and
  validate credentials before opening a browser or making network requests.
- 0.16.0 was rolled back when its check referenced a retired scratch password
  file. Discovery and registration passed; the check stopped before submitting
  sign-in. The corrected account path passes on the restored app.
- MCP application code is unchanged. The owner then authorized fixing forward
  without routine approval holds or automatic rollback, retaining two recovery
  images. Fresh backups and release gates still apply. Signup stays closed.
- Deployed 2026-10-03 using the unchanged, gated app build 1e52b4c. Public
  discovery, consent, native PKCE exchange/refresh, six SDK tools, optional-note
  exclusion and revocation passed. Saved/reloaded sets and photo upload/read/
  discard also passed. Real-agent acceptance is pending; the owner can connect.

## 0.16.0 Alpha — read-only agent access — rolled back 2026-10-03

- Six account-scoped MCP tools expose workouts, programs, equipment and a data
  dictionary. Notes require separate permission; photos and pain records are excluded.
- OAuth authorization code with PKCE, account consent, rotating refresh tokens
  and immediate revocation from Account → Connected agents.
- Historical exercise and machine labels accompany prescribed/executed values.
  Bounded pagination and read-only transactions constrain agent reads.
- Sign-in leads with “Document your Lifts” and preserves the validated return path
  to agent consent. Browser forms retain origin protection through an explicit
  boundary with one cookie-free native OAuth token-exchange exception.
- Retired the disposable demo stack, shared demo login and seed command.
  Rewrote the README around the hosted Alpha and current functionality.
- Planned endpoint: https://doclifts-mcp.runthe.ai/mcp through the existing tunnel.
  Auth, CSRF and tunnel diffs require owner review before release. Signup stays closed.
- See [MCP specification](docs/mcp-alpha.md). Client-specific acceptance remains pending.
- Owner approved PR #12 and tunnel deployment on 2026-10-03. Main 1e52b4c was
  deployed after a fresh restore/migration rehearsal with unchanged counts.
  Public discovery and registration passed. The acceptance harness then failed
  on a missing test-password file before sending a sign-in; no app auth failure
  was established. Restored runtime 38ff199, original environment/tunnel/edge
  rules and removed the new MCP DNS record. Public sign-in/history verified.
  Additive OAuth tables remain; training data was not restored or overwritten.

## 0.15.2 Alpha — image safety live — accepted 2026-10-03

- The production test explicitly selects Exercises when the picker opens on
  Machines, and finishes a leftover scratch workout before starting its check.
  Two complete runs passed consecutively on the restored release.
- Application safety code remains unchanged. Signup remains closed.
- Deployed 2026-10-03 at 38ff199 after owner approval. New uploads are screened
  with OpenRouter before storage; local and per-user A/B modes are available.
- Public browser, saved-set, photo, local scanner and runtime protection checks
  all passed. Owner tested uploads, confirmed acceptable speed and accepted
  the release on 2026-10-03. Temporary recovery image tags are retired.

## 0.15.1 Alpha — deployment verification — rolled back 2026-10-03

- The rollout check reads the exact build id through the real browser session.
  The previous Python probe was refused at the public edge despite successful
  browser checks, triggering a rollback. The corrected probe passes the restored
  build and fails an intentionally incorrect build id.
- Image-safety application code is unchanged from 0.15.0.
- Approved retry verified the deployed build in the browser, then rolled back
  when the test assumed the picker opened on Exercises. The same assumption
  failed on restored 0.14.1; this was a test-script defect.

## 0.15.0 Alpha — image safety — rolled back 2026-10-03

- New photos require a safety pass before storage or identification. Refusals
  leave no photo or workout block; manual set logging continues.
- Switch between a private CPU classifier, OpenRouter Llama Guard, or stable
  per-user A/B. All modes fail closed and record metadata-only decisions.
- Harmless fixtures test rejection without a harmful-image collection.
  Real harmful-image detection accuracy is not yet established.
- Signup remains closed. See [image safety](docs/photo-safety.md).
- Briefly deployed after owner approval. Public scratch sign-in, saved set,
  photo screening/upload/read/discard and local scanner checks passed. The final
  Python version probe received 403, so the release was rolled back as required.
  Production is pinned to 0.14.1; a browser verified the restored build.

## 0.14.1 — Cloudflare Tunnel deployment — accepted 2026-10-03

- Optional `public` Compose profile runs a pinned tunnel connector alongside
  the app, with a private read-only config directory and no new public port.
- Live at https://doclifts.runthe.ai with edge security headers, private-page
  cache bypass, HTTPS redirect and managed firewall protection.
- Scratch-account sign-in, saved set and photo checks passed through the tunnel.
  Private-address rollback passed in 8.1 seconds, then public sign-in passed again.
  Owner approved both 0.14.0 and 0.14.1 on 2026-10-03.

## 0.14.0 — public-address preparation — accepted 2026-10-03

- The browser address is controlled by runtime `PUBLIC_ORIGIN`, with no
  cross-origin CSRF exceptions or forwarded host/protocol trust.
- `CLIENT_IP_HEADER` selects the trusted proxy header. Login throttling,
  Better Auth and attempt logs use the same normalized address; IPv6 uses /64.
- Failures against an email can delay its owner, but only an IP can trigger
  a hard refusal. Successful sign-in still clears both counters.
- App responses include security headers and private, no-store caching,
  including direct auth responses. HTTPS responses start with one-day HSTS.
- This release prepares the existing deployment; the tunnel and public DNS
  cutover remain separate, reviewed steps.

## 0.13.1 — free weights remember their weight format in programs — 2026-10-03

- **Fixed:** a program saved from a quick workout showed no weight for free
  weights (dumbbells, barbells, bands, bodyweight). The quick workout records
  them in the format you chose (for example per arm), but a program workout
  started them with no format, so last time's numbers were not found. A
  program workout now starts each free weight in the format you last logged
  it in, and fills in last time's weight from that history.

## 0.13.0 — faster set entry — 2026-10-03

- **One tap per set.** Each set shows its weight and reps before you type
  anything (reps start at the bottom of the target range), and a big ✓ saves
  exactly what is shown. The next set to log scrolls into view; the keyboard
  stays closed.
- **− and + beside weight and reps.** Weight moves by the machine's own step
  when it is known, otherwise 5 lb (2.5 lb for plates per side); reps by 1,
  timed sets by 5 seconds. RIR stays, smaller and optional.
- **Rest timer.** Saving a set starts a 90-second rest in the workout bar.
  Tap it to dismiss, or "+30 s" for more. It keeps the right time if the page
  reloads. On screen only: no sound or notification yet.
- Every number above is one line in `src/lib/workout-ui.ts`.

## 0.12.0 — save a workout as a program — 2026-10-03

- **A finished workout can become a program.** Its page has "Save as
  program": start a new program from it, or add it as a new day of one you
  already have. The program editor opens on that day, filled in: the
  exercises in the order you did them, the sets you logged, and the reps you
  actually did as the range (10, 9 and 8 become 8 to 10). Nothing is saved
  until you review and save, and the workout itself is not changed.
- **A quick workout finishes on its own page**, where "Save as program" is,
  instead of going straight to Home.
- A machine still named "Unidentified machine" has to be named in the editor
  before the program can be saved.

## 0.11.0 — the program editor, rebuilt for a phone — 2026-10-03

- **Three short screens in place of one long form.** Program: name,
  description and the list of days (add, rename, reorder, remove). Day: its
  exercises as one line each, like "Leg press · 3 × 8–12 · RIR 2", and which
  day it alternates with. Exercise: its sets.
- **Four fields for a normal exercise:** sets, rep range, reps in reserve and
  rest (short or long). Changing one rewrites all its sets. "Customize sets"
  edits each set on its own for warm-ups, a top set with backoffs, timed sets
  or starting loads; an exercise like that opens there directly.
- **An exercise picker** replaces the long dropdown: search, tap, or create a
  new exercise (equipment and lower body are asked only then). Tier and
  progression are under "Advanced".
- **Your draft is kept** while you move between screens and if the page
  reloads. A new program starts from "Start blank" or one of the four
  templates. Review and save work as before.

## 0.10.0 — change a workout while you do it — 2026-10-03

- **Each exercise in an open workout has a ⋯ menu:** move it up or down,
  swap it, or remove it. These change today's workout only.
- **Remove:** with nothing logged, the exercise goes at once, with five
  seconds to Undo. With logged sets, choose "Skip the rest" (empty sets go,
  logged ones stay) or remove it and its sets after a confirm that says how
  many logged sets will be deleted. Neither counts as a failed workout for
  your progression.
- **Swap:** pick another exercise; the sets and targets stay and the weights
  come from that exercise's own history. In a program workout you choose
  "Just today" or "From now on". From now on updates the program when you
  finish, and the finished workout says whether it did. An exercise with a
  logged set can't be swapped, and the menu says why.

## 0.9.0 — four starter programs — 2026-10-03

- **Start from a template.** Creating a program now offers four starting
  points: Traveling PPL, Barbell Strength (4 days), Machine Full Body (two
  workouts alternated, 3 days a week) and Machines and Dumbbells (4 days).
  Each opens as a draft you can edit; nothing is saved until you save it.
- Exercises you already have are reused when the name, equipment and
  lower-body setting match; the rest are added for you. No starting weights:
  your history supplies them.

## 0.8.1 — choose a program exercise's machine in the sheet — 2026-10-03

- **In a program workout,** a planned machine exercise has a "Choose machine"
  button (or "Change machine"). It opens the add sheet on the gym's machines
  of that type: tap the one you're at, check the weight format, and confirm
  "Use … for this exercise?". You can also add a machine by name there. The
  old equipment form and its checkbox are gone.
- As before, the machine can't be changed once a set is logged; the button
  disappears then.

## 0.8.0 — the add sheet: machine first, exercise in a tap — 2026-10-03

- **A new way to add to a workout.** "Add exercise" opens a full-screen sheet
  with two tabs. **Machines** lists this gym's machines, recent first, then by
  body region, with a photo and what you did on each last time. Tap the
  machine, then its exercise: two taps for a machine you know. **Exercises**
  shows your recent exercises and the rest by body region, with last time's
  top set.
- **Free weights need no equipment.** Dumbbells, barbells, bodyweight and
  bands are added in one tap, with no gym or equipment to choose, and last
  time's numbers follow you to any gym.
- **Create by typing.** Type a name that doesn't exist yet and tap Create:
  pick the equipment and body region from chips.
- **Asked once.** "How do you record weight?" is asked the first time you use
  an exercise on a machine, then remembered.
- **Exercises page.** From your account: rename an exercise, set its body
  region, or hide it from the sheet. Past workouts keep the names they had.
- An empty workout no longer opens the add form by itself, so "Photo next
  machine" stays in reach.

## 0.7.0 — fix your gym list: remove, change model, merge — 2026-10-02

- **Remove a machine or a gym.** On the machine's edit page, and for a gym on
  the Gyms page. One you added by mistake is deleted; one with history leaves
  your lists but stays on your past workouts. Each gym has an "Archived"
  section to bring a machine back; removed gyms have their own.
- **Change a machine's model.** Search for the right model on the machine's
  page. The machine keeps its history. If the new model has a standard stack,
  you're offered it with one tap. A model that records weight differently
  (plate-loaded instead of a stack) replaces the machine instead, so the two
  kinds of numbers never mix.
- **Same machine as…** merges two rows that are really one machine, with a
  preview of what moves. Undo merge puts them back exactly.
- Nothing can be removed, changed or merged while an open workout uses it.

## 0.6.2 — saving a set after naming a machine works — 2026-10-02

- **Fixed:** after an exercise was named from a photo (Use this, or a repeat
  visit naming itself), its sets showed no numbers from last time and could
  not be saved until the page was reloaded. They now pick up the machine
  straight away. Numbers typed but not yet saved when the naming lands are
  cleared; saved sets are never affected.
- Brings 0.6.1 (below), which was rolled back for this.

## 0.6.1 — machines you've used before name themselves — rolled back 2026-10-02, ships in 0.6.2

- **Repeat visits name themselves.** Photograph a machine you've logged on
  before at this gym, and when the photo is read the exercise names itself:
  the same machine, the exercise and weight format you used last time, and
  last time's numbers filled into the sets you haven't logged yet. This
  happens only when the code on the placard matches exactly and the name
  agrees; anything less still asks.
- **Undo.** Any exercise named from a photo shows where its name came from,
  with Undo, while the workout is open. Your logged sets stay as they are.
- **Other machine.** The "Use this" card links to the photo's review page, to
  pick a different model.

## 0.6.0 — photograph the machine, log your sets, name it later — 2026-10-02

- **Photo next machine.** A green button at the bottom of an open workout.
  The photo opens a new exercise at once, as "Unidentified machine", and you
  can log sets on it straight away while the photo is read.
- **One tap to name it.** When the photo is read and the machine is found, the
  exercise shows the machine, a suggested exercise name and how weight is
  recorded, with **Use this** and **Later**. If the gym already has that
  machine, the exercise joins it, so its history stays in one place. Your
  logged sets are never changed.
- **When the read fails** (no placard, no signal, the daily limit), nothing is
  lost: one quiet line, "Could not read this photo. Name it now or later",
  with Read again and Name it.
- **Name it later.** You can finish a workout with machines still to name. The
  finished workout and Home say how many are left; the photo's review page
  names them, even after the workout.

## 0.5.5 — the app shell: tabs, an account page, a home-screen icon — 2026-10-02

- **Tabs at the bottom.** Workout, Gyms, History and Reports, one row at the
  bottom of the screen, clear of the iPhone's home indicator. Equipment lives
  under Gyms. During an open workout the tabs step aside for the workout's own
  bar (Pause, Add exercise, Finish workout).
- **One account button.** The round button at the top right, showing your
  email's first letter, opens the new Account page: your email, Change
  password, and Sign out. They are no longer in the menu.
- **Add it to your home screen.** DocLifts has an icon and opens full screen,
  without the browser's bars, when added from Safari's Share menu.
- **A first screen that says what to do.** A new account sees three steps and
  one button, Start workout. Gyms, History and Reports say what will appear
  there before there is anything. "Imported workout history" shows only when
  you have some.
- **Every page has a title** in the form "Page · DocLifts", and the sign-in
  page says what DocLifts is.

## 0.5.4 — security updates from the first code scan — 2026-10-02

- **SvelteKit 2.61.1 → 2.70.3**, which also brings `devalue` 5.8.1 → 5.9.4.
  This closes a slow-request flaw any visitor could trigger, signed in or not
  (GHSA-29g2-3rmr-qm68), and the `devalue` advisories. Nothing in the app
  changes.
- **CI runs with a read-only token**, stated in the workflow instead of
  relying on the repository's default setting.

## 0.5.3 — photo uploads are timed — 2026-10-02

- **For the owner: photo uploads are timed.** Each upload's log line now
  says how long each step took, in milliseconds: preparing the photo
  (`processMs`, and `processWaitMs` for any wait before it), storing it
  (`storePutMs`), the model's read (`modelMs`) and
  the whole request (`totalMs`). `scripts/photo-timings-report.sh` prints
  the median, p90 and max per step for the last week (counts and times only).
  The first report is due a week after this is deployed; it decides whether
  storing and reading should run side by side.
- **The read starts from the photo already in memory.** The upload hands
  the prepared photo straight to the model instead of fetching it back from
  storage. Re-analyze on the review page still fetches it. Nothing else
  changes: the steps run in the same order as before.
- **Very large photos are refused up front.** A photo over 50 megapixels
  (a phone photo is about 12) is turned away with a message saying its size
  and the limit, before the server tries to open it. A file that is small
  but claims to be a huge picture can no longer make the server run out of
  memory.
- **At most two photos are prepared at once.** Others wait their turn (a
  fraction of a second in practice); the wait is logged as `processWaitMs`.

## 0.5.2 — a misread code can't pick the wrong machine, and Trash on History — 2026-10-02

- **The app no longer pre-picks a machine when the code and the name
  disagree.** If the model reads a real model code that belongs to a
  different machine (a Booty Booster placard read as gym80 4157, which is a
  barbell rack), nothing is chosen for you: the code's machine is shown
  first, then the machines whose names match what was read, with a line
  saying why. When the code and the name agree, it is pre-picked as before.
  The maker's name and product line ("Pure Kraft") don't count as agreement.
- **Trash is on History.** A workout you move to Trash, quick or from a
  program, now shows under "Trash" at the bottom of History, with the date,
  "Quick workout" or the program's name, and how many sets you logged. Restore
  puts it back in your history; Delete permanently asks first, then removes
  it for good. Until now a quick workout in Trash could not be brought back
  from the app. The program page's own Trash is unchanged.
- **Move to Trash no longer shows an error when it worked.** It used to say
  "Could not complete that action" and stay on the workout, even though the
  workout had gone to Trash. It now takes you to History (a quick workout) or
  the program page.

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
