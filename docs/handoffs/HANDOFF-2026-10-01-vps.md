# Handoff: DocLifts, 2026-10-01 (VPS session)

**From:** Claude Code on the VPS · **To:** Project Claude · **Supersedes:**
`HANDOFF-doclifts-lockout-closed.md` (2026-10-01 01:36) and everything before it.

One working day took the app from 0.2.3 (a login lockout just closed) to
**0.4.6**: account management, an 890-model researched equipment catalog,
an LLM layer, and adding a machine by photographing its placard. The owner
used it at two gyms that afternoon. Every release went through the full gate
twice (local in CI order, and CI) and was checked on production afterwards.

---

## 1. Live now

```
production   0.4.6  fb0fabf  (main = origin/main, tagged)
web          rebuilt 2026-10-01 21:04 UTC, healthy
db           never recreated today; 17 migrations (0000-0016)
user data    31 sessions / 454 sets, unchanged by every deploy
             4 gyms, 9 machines, 15 photos (incl. the scratch account's)
catalog      890 active global models + 7 retired, 8 brands
photos       Linode Object Storage us-ord-10, bucket doclifts-s3-storage, private
LLM          OpenRouter. LLM_VISION_MODEL=google/gemini-2.5-flash-lite
             (photos, ~2.5 s, ~$0.0002/call). LLM_MODEL=stealth/space-bunny-alpha
             (text; temporary, nothing uses it yet). LLM_TIMEOUT_MS=60000
tests        server 628, demo 3, client 23, e2e 97; CI jobs: test + docker
```

Tags: 0.2.4, 0.2.5, 0.3.0, 0.3.1, 0.3.2, 0.4.0, 0.4.1, 0.4.2, 0.4.3, 0.4.4,
0.4.5, 0.4.6. The runbook records for every deploy are in
`docs/release-0.2.0.md` §16-§22; user-facing notes are in `CHANGELOG.md`.

## 2. What shipped

| Release     | What                                                                                                                                                                                           | Runbook |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 0.2.4       | `/account/password`, Show/Hide on password fields, `PASSWORD_MIN_LENGTH` (12, length only), 30 s login-delay cap, malformed config stops the boot, deploys refuse env keys compose never reads | §16     |
| 0.2.5       | `/login` says when the throttle is holding an attempt, and counts down                                                                                                                         | §17     |
| 0.3.0       | Global equipment catalog (migration 0012): `/equipment` browse and detail, add a model to a gym, owned copies                                                                                  | §18     |
| 0.3.1       | LLM layer (0013): `complete()` is the only way to call a model; an `llm_calls` row on every path; per-user hourly cap; lazy config                                                             | §19     |
| 0.3.2       | Optional machine label and machine Edit; importer promotes, recodes and retires instead of duplicating; model notes and standard stack (0014, 0015); the researched 2026-10-01 catalog         | §20     |
| 0.4.0       | Equipment from a photo (0016): upload, EXIF strip and resize, private S3, vision analysis, catalog match (exact, leading-digit, prefix, name), review, link, create or discard                 | §21     |
| 0.4.1-0.4.6 | Fixes from first real use: missing keys, camera-only picker, enum synonyms, plain wire schema (4x faster), phone nav, password-field typing assists                                            | §22     |

Specs these came from: `docs/handoffs/REPLY-login-spec.md` (§2),
`SPEC-0.3.0-catalog-0.3.1-llm.md` and `SPEC-0.4.0-equipment-photo.md`. The
last two live on the VPS in `/home/chris/code/specs/`. Deviations from each
are stated in the runbook sections and in `docs/catalog.md`, `docs/llm.md` and
`docs/photos.md`.

## 3. The catalog

`data/catalog/equipment_models_seed_2026-10-01.csv` (890 rows) was researched
by five agents, one per brand group. Every new or changed code came from a
page fetched that day and cited in `source`. The brief and the per-brand
change logs are committed in `data/catalog/research-2026-10-01/`.

- Without a code: 210 -> 21. Guessed (`inferred`): 69 -> 10. With a starting
  resistance: 11 -> 98. With a standard stack: 26 -> 355.
- 17 wrong codes corrected, 9 of them via `replaces_code`.
- Re-importing a snapshot is safe and idempotent. Rows are promoted or
  recoded in place, so gym links never break, and models missing from a
  snapshot are retired, never deleted. Rehearsed on a production restore
  before it ran.
- Owner decision: Hammer Strength rows may cite lifefitness.com as the
  manufacturer's page.

## 4. Operating model (what worked; keep it)

- **One committer.** The VPS session commits and pushes from the work tree
  `/home/chris/code/DocLifts-work`. The desktop session is read-only. The
  deploy checkout `/home/chris/code/DocLifts` never commits; it only
  fast-forwards to `main`.
- **Gate twice before `main` moves:** the full local gate in CI order (with
  `PW_EXECUTABLE_PATH=/usr/bin/google-chrome`, since Ubuntu 26.04 has no
  Playwright browsers), then CI on the branch. CI only runs for `main` and
  PRs, so branches are run with `gh workflow run CI --ref <branch>`.
- **Production commands are the owner's.** Claude Code's auto-mode safety
  check blocks the assistant from `compose-prod.sh up`, `catalog-prod.sh`
  imports and editing its own permissions, even with the owner's "go".
  `migrate-prod.sh` ran once. The split that worked: the assistant prepares
  and states the exact commands, the owner runs them over SSH, and the
  assistant runs the read-only checks (version.json, logs, psql counts,
  Playwright on the scratch account) and tags.
- **Parallel agents:** one git worktree and one throwaway Postgres container
  (127.0.0.1:5543x) per agent. The demo test database names are fixed, so a
  shared container corrupts runs. Research agents need private scratch
  directories (one ran another's `build.py`). Every agent claim was
  spot-checked before it was trusted: about 60 catalog codes re-fetched, CI
  runs looked up, migrations re-read.
- **Migrations** are verified by applying the full chain to a restore of the
  nightly dump in a scratch database, and recording row counts and names
  before and after. Never against production.
- **Scratch account** `scratch-test@doclifts.invalid` for every production
  check. It has its own gym, "Scratch photo check gym". Its password is reset
  per session through `user-prod.sh set-password --password-stdin` and never
  printed.

## 5. Open, in the owner's priority order

1. **Phone-first quality (held by the owner, agreed in principle).** Today's
   phone bugs were spec gaps, not later additions: no spec said anything
   about phones, keyboards or narrow screens, and the 0.4.0 spec prescribed
   `capture="environment"`. Proposed:
   - a CLAUDE.md rule, "The phone is the primary device": input attributes
     (`autocomplete`, `autocapitalize`, `inputmode`, `spellcheck`); a file
     input never forces the camera; every route works at 390 px; rendered
     text checked as rendered;
   - extend the CSP crawl to check every route at 390 px for overflow,
     wrapped or off-screen controls, and missing input attributes;
   - audit existing inputs; set entry should bring up the numeric keypad.

   Specs should carry a "how this is used on a phone" line from now on.

2. **Photo matching, cheap fixes.**
   - Manufacturer aliases before matching: the gym80 logo reads as
     "Dyumbo"/"Gymbo", and the product line gets taken for the maker ("Pure
     Kraft", "FIRE KRAFT").
   - **Corrected:** this said "4157 Booty Booster was read correctly". It
     was not: the placard is gym80 **4352** PURE KRAFT BOOTY BOOSTER
     (https://gym80.de/en/product/4352/), and gym80 lists 4157 as a POWER
     CURL BARBELL RACK. The model misread the code at confidence 1.0. 4352 is
     added in the 2026-10-01b snapshot; see `docs/photos.md`, "Known gaps".
3. **Machine-only photos (no placard): design, not built.** Keep it cheap:
   - Stage 1 is the same single call: with no placard, describe maker
     (logo, frame), machine type, plate or stack, and arms.
   - Stage 2 runs only without a code: a text-only call picks the top 3 from
     that maker's catalog names (about $0.0001, under 1 s).
   - Rank by what is already at that gym; gyms buy whole lines.
   - Image-similarity search is deferred until stages 1-2 show their misses.
   - The owner is collecting whole-machine photos at Sunrise Center Lincoln
     as the test set.
4. **Upload speed.**
   - Resize on the phone before upload: a camera photo is 3-5 MB, the server
     keeps about 240 KB.
   - Show progress ("Uploading… Reading the placard…").
   - Possibly send the model 1024 px instead of 1600 px, after testing on
     real placards.
5. **Smaller items.**
   - Catalog retirement is catalog-wide, so a partial CSV would retire the
     rest. Optionally scope it to the manufacturers present.
   - Half-pound standard stacks (36 Life Fitness) are rounded down; the
     exact figure is in the note.
   - `vite.demo.config.ts` points the server test project at
     `doclifts_demo_test` too. It's harmless, but unexpected.
   - The owner's five photos at `analyzed` are waiting on his review.
   - **CI for docs, a `ci.yml` change for a later full-gate release.**
     Markdown-only changes now need only `pnpm lint` locally (CLAUDE.md,
     owner exception 2026-10-01), but CI still runs the whole suite on
     them. Two changes to make:
     - a docs-only CI path;
     - removing the duplicate run on `main` after a fast-forward of a
       branch CI already passed.

## 6. Housekeeping for the owner (no code)

- **S3 key scope.** Check in Linode Cloud Manager that the key is limited
  to `doclifts-s3-storage`.
- **Delete when happy:** `/srv/doclifts/.env.pre-0.4.0`,
  `/srv/doclifts/.env.bak-pre-0.2.4-minlen`, and `~/s3key.txt` and
  `~/orkey.txt` (both now copies of values in the env file).
- **`LLM_MODEL`** is still the stealth model, marked temporary. Nothing
  calls the text model yet.
- **Old images and folders.** The images `pre-trash-20260914`,
  `history-20260913` and `pre-ui-20260914`, and
  `~/doclifts-history-20260913/` (it holds a `migrate.env`: check it for
  credentials before deleting).

## 7. Rules earned today (all in CLAUDE.md or the docs named)

- **Check it on the phone, at the gym.** Five of today's bugs passed every
  test and were found in the owner's first ten minutes of real use (§22).
- **Verify every report, including your own scripts'.**
  - The 0.2.4 checks first "failed" because the check script clicked the
    layout's Sign out instead of the form's submit.
  - One research agent ran another's `build.py` from a shared directory.
  - A merge audit found 9 corrected codes that would have duplicated rows,
    which is why `replaces_code` exists.

  Re-checking cost minutes each time and caught all three.

- **Hand the model a plain schema and validate strictly yourself**
  (`docs/llm.md`, `wireSchema`): strict structured output compiles every
  constraint.
- **The catalog read rule has two predicates.** `modelVisibleTo` (lists,
  new links, matching) excludes retired models; `modelReadableBy` (by id)
  does not (CLAUDE.md).
- **Never write secrets into docs.** The owner's password had been quoted in
  two older release records. It's removed from the tree, and he has since
  changed it.

## 8. Verify anything here

```bash
ssh to the VPS, then:
  cd /home/chris/code/DocLifts && git log --oneline -1          # fb0fabf or later
  curl -s https://enochnvps.tail29bbdb.ts.net/_app/version.json
  sudo -n scripts/compose-prod.sh logs web --since 10m | grep -E 'llm_config|login_config'
  gh run list --branch main --limit 3
```
