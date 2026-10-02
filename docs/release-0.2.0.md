# Release 0.2.0 — runbook

**Executed by Chris with Hermes present.** Every step has a command (or an
observation) and an expected value, plus an abort condition. No step says "check
that it works."

**Read this first, because it will look like a bug.** After bootstrap,
`/history` shows **fewer** sessions than the database holds, and that is
correct. `/history` filters `deleted_at IS NULL`, so soft-deleted rows are
deliberately hidden.

> **Treat the numbers in this document as a dated measurement, not a
> specification.** They were read on 2026-09-30 immediately before the release.
> **Production is a live database and this document will go stale** — a session
> logged later changes the totals, which is normal and not a fault.
>
> The invariant is the _arithmetic_, and that is what step 8 verifies. The real
> filter is in `historyForMonth` (`src/lib/server/history.ts`): sessions that are
> `deleted_at IS NULL` **and join a `days` row and a `programs` row**. There is
> **no `ended_at` condition** — an unfinished session still appears, which is
> correct: you want to see a session you started and did not finish.
>
> ```text
> total_sessions            ==  the raw `select count(*) from sessions`
> history_shows             ==  total_sessions - soft_deleted
>                        (and: history_shows must be unchanged by the release)
> ```
>
> The one historical trap: the T5-era figures of 29-visible-across-four-months
> are **no longer reproducible** and should not be compared to. The current
> data shows 9 + 12 across 2026-05 and 2026-06, because the nine unfinished
> sessions and the one soft-deleted row move the picture. **Do not raise an
> alarm about any absolute number here. Reconcile the arithmetic, or stop and
> say so.**

**Production is at migration 8 of 11.** This release applies 0008, 0009, 0010
and 0011 in a single transaction.

**The `Secure` cookie and the Tailscale Serve check need a real browser on the
tailnet.** Not a phone on cellular, not a machine off the tailnet.

> **Standing rule for every step in this runbook, and every release after it:
> no test, probe, or control is ever exercised against the owner's account,
> email, or address.** Every sign-in check, wrong-password check, throttle
> check and session purge uses the scratch account,
> `scratch-test@doclifts.invalid`, created with `--password-stdin` from the
> owner's shell. On 2026-09-30 a throttle check aimed at the owner's email
> locked him out of a working password for fifteen minutes while the scratch
> account sat unused. If a step seems to need the owner's account, stop and ask.

---

## 1. Pre-flight

All of these must hold **before** anything is merged.

```bash
# a. CI green on the release sha
cd /home/chris/code/DocLifts
gh run list --branch feat/accounts-t1a --limit 3
```

Expected: the most recent run on the sha being released is `success`.

```bash
# b. main unchanged since the branch base
git fetch origin
git log --oneline origin/main -1
git merge-base --is-ancestor origin/main HEAD && echo "main is an ancestor: safe to fast-forward"
```

Expected: `main is an ancestor: safe to fast-forward`. **If it is not**, `main`
moved during the branch. Stop and reconcile before merging — a merge commit
here means the migration verification in step 3 was done against a tree nobody
will deploy.

```bash
# c. production containers healthy
scripts/compose-prod.sh ps
```

Expected: `db` and `web` both `Up`/`healthy`. A container that is `Up` but not
`healthy` is a problem **now**, not after the deploy.

```bash
# d. compose config renders
scripts/compose-prod.sh config > /dev/null && echo "config OK"
```

Expected: `config OK`. This validates the required `ORIGIN` variable, so a
missing env entry fails here rather than at boot.

```bash
# e. production env has the required variables — NAMES ONLY
sudo grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' /srv/doclifts/.env | tr -d '=' | sort
```

Expected, exactly these three:

```
BETTER_AUTH_SECRET
POSTGRES_PASSWORD
PUBLIC_ORIGIN
```

And the origin value (not a secret):

```bash
sudo grep '^PUBLIC_ORIGIN=' /srv/doclifts/.env
```

Expected: `PUBLIC_ORIGIN=https://enochnvps.tail29bbdb.ts.net`

**Do not print `BETTER_AUTH_SECRET`.** Confirm the name is present and move on.

```bash
# f. Tailscale Serve configured, returning the current app over HTTPS
sudo tailscale serve status
curl -sk -o /dev/null -w "%{http_code}\n" https://enochnvps.tail29bbdb.ts.net/
```

Expected: the `|-- / proxy http://100.118.77.26:3000` line, and `200`.

`curl -k` is required on the VPS itself: the issuing root is not in the system
store there, so verification fails even though the handshake and the response
are both correct. A real tailnet browser has the chain. **Do not add a CA to the
system store to make this pass.**

The backend must be the **tailnet IP**, not `127.0.0.1`. The app does not listen
on loopback; proxying to loopback returns 502 for every request.

**Abort if:** CI is not green, `main` is not an ancestor, either container is
unhealthy, `config` fails, any of the three variables is missing, or Serve is not
returning 200. None of these are fixed by continuing.

---

## 2. Merge and tag

**Requires Chris's explicit authorization.** Nothing before this point has
changed production.

```bash
git checkout main && git pull --ff-only
git merge --ff-only feat/accounts-t1a
git push origin main
git tag 0.2.0 && git push origin 0.2.0
```

**Abort if** `--ff-only` refuses. That means `main` diverged and step 1b was
wrong; reconcile before merging rather than creating a merge commit.

---

## 3. Migrate production

```bash
scripts/migrate-prod.sh
```

Expected, in order: a `pg_dump` written and verified with `pg_restore --list`,
then migrations 0008–0011 applied in one transaction.

**Verify — capture the pre-migration counts, then compare after.** Do this
_before_ running `migrate-prod.sh`; it is the baseline step 3 compares against:

```bash
scripts/compose-prod.sh exec -T db psql -U doclifts -d doclifts -tAc "
  select 'programs='||count(*) from programs
  union all select 'gyms='||count(*) from gyms
  union all select 'exercises='||count(*) from exercises
  union all select 'sessions='||count(*) from sessions
  union all select 'sets='||count(*) from sets
  union all select 'pain_events='||count(*) from pain_events
  union all select 'workout_log_imports='||count(*) from workout_log_imports
  union all select 'program_draft_requests='||count(*) from program_draft_requests;"
```

Write those numbers down. Then migrate, then re-run the same command and
compare.

> **Do not compare against a hard-coded baseline.** Production is a live
> database: a workout logged between writing this runbook and running it changes
> the counts, and a frozen baseline turns that normal event into a false abort
> mid-migration. This already happened once — the T5 baseline said `sessions 30,
sets 435`, and by 2026-09-30 evening production held **31 sessions and 454
> sets** because a session was logged at 16:44 that day. The migration does not
> touch row counts, so _any_ difference between your two readings is a real
> problem; comparing to a number written down days ago is not a verification, it
> is a coincidence waiting to fail.

**Verify — counts unchanged across the migration:**

```bash
scripts/compose-prod.sh exec -T db psql -U doclifts -d doclifts -c "
  select 'programs' t, count(*) from programs
  union all select 'gyms', count(*) from gyms
  union all select 'exercises', count(*) from exercises
  union all select 'sessions', count(*) from sessions
  union all select 'sets', count(*) from sets
  union all select 'pain_events', count(*) from pain_events
  union all select 'workout_log_imports', count(*) from workout_log_imports
  union all select 'program_draft_requests', count(*) from program_draft_requests
  union all select 'auth.user', count(*) from \"auth\".\"user\"
  union all select 'auth.account', count(*) from \"auth\".\"account\"
  order by 1;"
```

Expected: **identical to the pre-migration reading above**, plus two new rows:

```
auth.user                1
auth.account             0
```

**`auth.account` is 0 here and that is correct** — it becomes 1 in step 7, after
bootstrap. **Every other count must be byte-identical to your pre-migration
reading.** 0008–0011 add columns and a NOT NULL constraint; they insert no
application rows.

**Verify — the eight ownership columns are `NOT NULL`, and nothing is stranded:**

```bash
scripts/compose-prod.sh exec -T db psql -U doclifts -d doclifts -c "
  select table_name, column_name, is_nullable
  from information_schema.columns
  where column_name = 'user_id'
    and table_schema = 'public'
  order by table_name;"
```

Expected: eight rows, every `is_nullable` = `NO`
(`programs`, `gyms`, `exercises`, `sessions`, `sets`, `pain_events`,
`workout_log_imports`, `program_draft_requests`).

```bash
scripts/compose-prod.sh exec -T db psql -U doclifts -d doclifts -c "
  select id, email, email_verified from \"auth\".\"user\";"
```

Expected: one row, id `00000000-0000-4000-8000-000000000001`, email
`owner@localhost`, `email_verified` false. That is the **unclaimed sentinel** —
correct at this stage.

**Abort if** any count differs, any column is nullable, or there is more than one
`auth.user` row. **Nothing has been deployed yet, so the database is the only
thing that has changed: restore the dump** per `docs/migrations.md` and stop.

---

## 4. Preserve the current image (BEFORE step 6 builds over it)

Step 6 runs `--build` with the **same tag**, `doclifts-web:vps`, which
**overwrites** the image that is running right now. Without this step, "roll the
image back" has nothing to roll back to and the abort path below is a sentence
rather than a command.

```bash
sudo docker tag doclifts-web:vps doclifts-web:pre-0.2.0
sudo docker image inspect doclifts-web:pre-0.2.0 --format '{{.Created}}'
```

Expected: `2026-09-29T16:07:09Z`. Anything else means the running image is not
the one this release replaced — stop and work out what is actually running
before continuing.

`pre-0.2.0` is kept until the post-release step, and deleted there alongside
the env backup.

## 5. Pre-check the rendered environment (before `up`)

The new image **throws at boot** on a missing origin or secret. That is the
behaviour we want, but it presents as a failed release unless we look first.

```bash
scripts/compose-prod.sh config \
  | grep -E 'PUBLIC_ORIGIN|ORIGIN:|PROTOCOL_HEADER|HOST_HEADER|BETTER_AUTH_SECRET' \
  | sed -E 's/(BETTER_AUTH_SECRET:).*/\1 <redacted>/'
```

Expected — all five present, with both origins identical:

```text
      BETTER_AUTH_SECRET: <redacted>
      HOST_HEADER: x-forwarded-host
      ORIGIN: https://enochnvps.tail29bbdb.ts.net
      PROTOCOL_HEADER: x-forwarded-proto
      PUBLIC_ORIGIN: https://enochnvps.tail29bbdb.ts.net
```

**Abort if any line is missing or the two origins differ.** Do not run `up`.
This check earned its place: it is what caught `BETTER_AUTH_SECRET` never being
passed into the container at all, which would have failed the deploy at boot
with an error that reads like a code problem rather than a compose problem.

## 6. Deploy the image

```bash
scripts/compose-prod.sh up -d --build --wait web
```

**Verify — container healthy and the guard is live:**

```bash
scripts/compose-prod.sh ps
curl -sk -o /dev/null -w "history anon -> %{http_code} -> %{redirect_url}\n" \
  https://enochnvps.tail29bbdb.ts.net/history
```

Expected: `web` is `healthy`; `/history` returns **303** redirecting to
`/login`. The pre-0.2.0 build answered 200 to an anonymous `/history` — if you
see 200, the old image is still running.

**Verify — the startup warning is present, because bootstrap has not run yet:**

```bash
scripts/compose-prod.sh logs web | grep -A12 "NO LOGIN-CAPABLE ACCOUNT"
```

Expected: the banner, naming `scripts/user-prod.sh bootstrap`. It must say the
sentinel exists. This warning is the only signal that the data is currently
invisible; the healthcheck is green either way.

**Abort — roll back to the preserved image.** This is a command, and it
resolves to the tag from step 4:

```bash
DOCLIFTS_WEB_IMAGE=doclifts-web:pre-0.2.0 scripts/compose-prod.sh up -d --wait web
```

`DOCLIFTS_WEB_IMAGE` exists because the image name in `docker-compose.yml` is
parameterised; its default is unchanged, so ordinary invocations are unaffected.
Verify the rollback took: `scripts/compose-prod.sh ps` and an anonymous
`/history` returning **200** again (the old build has no guard).

**And read this before rolling anything back.** The database migration
in step 3 is **compatible with the old image only insofar as the old code ignores
the new `user_id` columns.** That is true: the pre-0.2.0 build has no auth at
all and no ownership predicates, so it still runs and still serves every page.

So the consequences are asymmetric:

- **Roll back the image alone** → a **working but ownership-unaware** app. It
  boots, serves, and ignores who owns what. On a single-user install that is
  not an outage; it is a silent loss of the isolation this release added.
- **Restore the database** → the **full rollback**, back to migration 8 and
  pre-0.2.0 behavior, with the data as it was.

Rolling the image back without restoring the database is _not_ a full rollback.
Say which one was done.

---

## 7. Bootstrap the account

```bash
scripts/user-prod.sh bootstrap --email '<Chris's real email>' --password '<password>'
```

Use a real email address — `owner@localhost` fails Better Auth's email
validation. The password is not echoed; it is not retained anywhere.

**Verify:**

```bash
scripts/compose-prod.sh exec -T db psql -U doclifts -d doclifts -c "
  select u.id, u.email, u.email_verified, a.provider_id,
         left(a.password, 12) as credential_prefix
  from \"auth\".\"user\" u
  join \"auth\".\"account\" a on a.user_id = u.id;"
```

Expected: exactly one row. `id` is **still** `00000000-0000-4000-8000-000000000001`
— the id is preserved deliberately, because every migrated row already points at
it. `provider_id` is `credential`. The password is a **hash** (a `$2b$`/`$argon2`
prefix), never plaintext.

```bash
scripts/compose-prod.sh restart web
scripts/compose-prod.sh logs web | grep "NO LOGIN-CAPABLE ACCOUNT"
```

Expected: the grep finds **nothing**. The warning is gone.

**Abort if** the id changed, if there is more than one `auth.account` row, or if
the stored credential is readable as a password.

---

## 8. Real browser over Tailscale Serve

Do this in an actual browser on the tailnet. This is the only step that cannot
be automated, and it is the one that proves the browser-visible behavior.

1. Open `https://enochnvps.tail29bbdb.ts.net/login` over the tailnet. Sign in.
2. **Verify the cookie is `Secure`:** DevTools → Application → Cookies →
   `better-auth.session_token`. `Secure` must be checked, and `HttpOnly` too.
   (Headers alternative: `curl -skI` on the sign-in response and read
   `Set-Cookie`.) A non-`Secure` cookie here means the forwarded-proto handling
   is wrong and the session would travel in clear over HTTP.
3. **Verify `/history` shows every ended, non-deleted session** — and check it
   against a count you take _now_, not a number written down earlier:

   ```bash
   scripts/compose-prod.sh exec -T db psql -U doclifts -d doclifts -c "
     select
       (select count(*) from sessions) as total_sessions,
       (select count(*) from sessions where deleted_at is not null) as soft_deleted,
       (select count(*) from sessions s
          join days d on d.id = s.day_id
          join programs p on p.id = s.program_id
         where s.deleted_at is null) as history_shows;"
   ```

   Expected: `history_shows` = `total_sessions` − `soft_deleted`, and
   `history_shows` identical to your step-3 baseline. On 2026-09-30 that was
   31 / 1 / 30.

   `/history` is a single-month view, so step through each month and add them
   up. The sum must equal `visible`, and `visible + soft_deleted` must equal the
   total from step 3. **The database holds more sessions than the page shows,
   and that is correct** — the view filters `deleted_at IS NULL`, so soft-deleted
   rows are deliberately hidden (see the top of this document).

   > The absolute numbers moved and will move again: the 29-vs-30 explanation at
   > the top of this document was measured on 2026-09-30, and a session logged
   > that same afternoon took the total to 31. What is invariant is the
   > _arithmetic_ — visible + soft-deleted = total — and that is what this step
   > checks. A month count that does not reconcile against the query is a real
   > problem; a month count that differs from this document is not.

4. **Create a gym** through the form. This exercises the CSRF path: behind
   Tailscale Serve, SvelteKit only accepts the POST if `PROTOCOL_HEADER` and
   `HOST_HEADER` are honored. A 403 here means the forwarded headers are not
   reaching the app.
5. **Log out.** The cookie is cleared and `/history` returns **303** to `/login`.

**Abort if** the cookie lacks `Secure`, if any month count differs, if the gym
form returns 403, or if logout leaves `/history` reachable.

---

## 9. Rate limit

**Measured on 0.2.0, not read from config** — 3 attempts per 10 seconds, per
client IP, from Better Auth 1.7.6's `getDefaultSpecialRules()` defaults. A
minor Better Auth upgrade could change this; re-measure rather than trusting
this number.

```bash
for i in 1 2 3 4; do
  curl -sk -o /dev/null -w "attempt $i -> %{http_code}\n" \
    -X POST https://enochnvps.tail29bbdb.ts.net/login \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    --data-urlencode 'email=<Chris's real email>' \
    --data-urlencode 'password=deliberately-wrong'
done
```

Expected: attempts 1–3 return **400** (allowed, credentials wrong), attempt 4
returns **429**.

**This run is over Tailscale Serve, which is the point.** Tailscale Serve sets a
single-value `X-Forwarded-For`. Better Auth resolves a **multi-value**
`X-Forwarded-For` with no `trustedProxies` configured to _no IP at all_, and a
null IP **disables rate limiting entirely** — silently. So a proxy that appends
to the chain instead of overwriting it turns this control off without any error.
Tailscale Serve overwrites, so this passes. **A public proxy must not be assumed
to.**

If attempt 4 is not 429, stop and diagnose before releasing publicly.

---

## 10. Post-release

```bash
# a. record the migrations as applied to production, with today's date
$EDITOR docs/migrations.md      # move 0008-0011 into "applied to production"

# b. move the Unreleased section to 0.2.0 with the release date
$EDITOR CHANGELOG.md

# c. update the case-study copy in the enoch-ai repo
cd /home/chris/code/enoch-ai && $EDITOR <case-study file>

# d. delete the env backup taken during T6
sudo rm -f /srv/doclifts/.env.pre-t6-backup
```

(d) is last on purpose: that backup is the only record of the pre-T6 production
env, and it should survive until the release is confirmed good.

Commit the doc changes and push. The release is complete when CI is green on
`main` at tag `0.2.0`.

---

## Note on the healthcheck and the guard (settled before T7)

**It passes.** Here is the proof, because this was the most likely way for the
release to fail while working perfectly.

The container healthcheck is:

```yaml
healthcheck:
  test: ['CMD-SHELL', 'wget -qO- http://127.0.0.1:3000/ >/dev/null 2>&1 || exit 1']
```

It hits **`/`**, and `/` is **not** in the guard's `ALLOWLIST` — so under 0.2.0 an
unauthenticated `GET /` returns **303 → /login**, not 200. A check that followed
redirects to a login page would still see 200 at the end, and a check asserting
200 on the _first_ hop would fail on a healthy container and make `--wait`
report a failed deploy with a working app behind it.

**Measured, in the live container, with its own wget, against a server that
really returns 303:**

```text
HTTP/1.1 303 See Other
Location: /login
HTTP/1.1 200 OK
...
$ wget -qO- http://127.0.0.1:4099/ >/dev/null 2>&1; echo exit=$?
exit=0
```

So the chain is: `wget` follows the 303 to `/login`, `/login` **is** allowlisted,
returns 200, and `wget` exits 0. `--wait` is satisfied.

Two things worth knowing, because they would have made this look broken:

1. **The host's `wget` is GNU 1.25; the container's is BusyBox 1.37.** They are
   different programs. This was tested _inside_ the running container rather
   than from the host, where a GNU result would have proven nothing about the
   healthcheck that actually runs.
2. **`/health` is allowlisted but does not exist** — it returns 404. The
   allowlist entry is aspirational, not a live endpoint. Nothing depends on it:
   the healthcheck targets `/`, which works. Left alone rather than "fixed",
   because adding a route to satisfy an unused allowlist entry is scope this
   release does not need. If a real `/health` is ever wanted, it is one line —
   but it must return 200 with no DB access, or it becomes a worse healthcheck
   than the redirect chain it would replace.

## 11. After the release — things deliberately not done

### A password rotation is followed by a session purge

Measured 2026-09-30: Better Auth's `updatePassword` does **not** revoke existing
sessions. An account whose password is rotated keeps every session it already
had, so a leaked password stays useful until each session expires on its own.

So a rotation is two steps, in this order:

```bash
# 1. the new password
printf '%s' "$(pass show doclifts)" | scripts/user-prod.sh set-password \
  --email you@example.com --password-stdin

# 2. revoke everything signed in under the old one
sudo scripts/compose-prod.sh exec -T db psql -U doclifts -d doclifts \
  -c "DELETE FROM \"auth\".\"session\" WHERE user_id = '<uuid>';"
```

Do both, or the rotation is only half a rotation. Prefer `--password-stdin`: a
password given as an argument sits in the process list for the life of the
command and is written to shell history.

Recorded so they are not rediscovered as oversights:

- **Rate-limit storage is in-memory.** One container, so it works. It resets on
  restart and does not share across replicas. Set `rateLimit.storage:
'database'` — which adds a table and needs a migration — before any second
  replica.
- **The limiter is per-IP only.** There is no per-account lockout: N failures on
  one email from different IPs are not counted together. Per-IP is the right
  first line; per-account is the second, and it is not implemented.
- **`trustedProxies` is not configured.** Required before a public deployment,
  so a spoofed `X-Forwarded-For` cannot select a fresh rate-limit bucket. See
  the T8 items.
- **`DOCLIFTS_OPEN_SIGNUP` is unset, and must stay unset** until a `/signup`
  route exists. Setting it now opens Better Auth's endpoint with no page behind
  it.
- **The public cutover is a separate piece of work.** The safety of trusting
  `X-Forwarded-Proto`/`X-Forwarded-Host` today depends entirely on the app
  binding the tailnet IP so nothing off-tailnet can forge them. At cutover the
  app must bind only to the proxy's Docker network, and the proxy must overwrite
  both forwarded headers.

## 12. 0.2.1 hotfix

No migration. Three defects, all found by using the released app on the
tailnet rather than by any test — every one of them had a green suite.

### Before deploying

```bash
# Preserve the running image, since the build overwrites the tag.
sudo -n docker tag doclifts-web:vps doclifts-web:pre-0.2.1
sudo -n docker image inspect doclifts-web:pre-0.2.1 --format '{{.Created}}'
```

Rollback is the concrete command, same shape as 0.2.0's:

```bash
DOCLIFTS_WEB_IMAGE=doclifts-web:pre-0.2.1 \
  sudo -n scripts/compose-prod.sh up -d --wait web
```

### The three defects

1. **BACK after sign-out showed the signed-out user's `/history`.** The
   browser re-rendered from its own cache; the session was already dead.
   Nothing set `Cache-Control`, and a response without one is heuristically
   cacheable. Fixed in the guard, so static assets and `/login` keep their
   normal caching.

2. **No sign-out control existed.** The action had been there since T2 and was
   never rendered. Fixed in the layout, as a POST form.

3. **The rate limiter charged successful sign-ins.** Better Auth consumes the
   bucket before checking credentials, so four correct sign-ins in quick
   succession refused the fourth. This is what a user reported as "hit back
   and can't log in again". Replaced with a failure-only throttle in
   `src/lib/server/login-throttle.ts`; Better Auth's counter remains as a
   60-per-60s volume backstop.

### On the wire, after `up -d --build --wait web`

- BACK after sign-out lands on `/login`, not a cached page
- `/login` while signed in redirects to `/`
- the sign-out control is visible in the nav
- five sign-out/sign-in cycles, none waiting
- one wrong password then the correct one works immediately
- a refusal names a positive number of seconds

### Post-release

Delete `doclifts-web:pre-0.2.1` once the above passes. The throttle's
in-memory counters are cleared by the restart, so the deploy is also a reset.

### Deployed 2026-09-30

`0.2.1` = `62c3d6e`, tagged and pushed. CI run [36784882502](https://github.com/cjenoch/DocLifts/actions/runs/36784882502) green on that sha, including the 17 CSP tests that are skipped locally.

No migration. `web` was rebuilt and recreated; `db` was untouched (same container
ID across the deploy).

All five browser checks passed over Tailscale Serve:

| Check                                             | Result                                       |
| ------------------------------------------------- | -------------------------------------------- |
| sign-out control visible on an authenticated page | yes, reads "Sign out"; a form, not a link    |
| sign out, press BACK                              | lands on `/login`; no workout data rendered  |
| `/login` while signed in                          | 303 to `/`                                   |
| five sign-out / sign-in cycles, no waiting        | 5/5, 4.2s total                              |
| one wrong password, then the correct one          | wrong rejected 400, correct accepted at once |

Corroborating headers, measured on the same deploy:

```
GET /history (authenticated)   200  cache-control: no-store, must-revalidate
                                       vary: Cookie
GET /_app/immutable/…css        cache-control: public, max-age=0, must-revalidate
GET /history (no cookie)        303 -> /login
GET /history (stale cookie)     303 -> /login   (after sign-out)
session cookie                  Max-Age=2592000  (30 days)
```

The throttle was then exercised on production: ten wrong passwords from one
address refused a subsequent **correct** password with a positive wait, and the
structured line appeared as designed —

```json
{
	"event": "login_throttle",
	"kind": "refuse",
	"key_type": "email",
	"count": 10,
	"retry_after_s": 876
}
```

— with no address and no password in it. That test left the email key at its
ceiling, so the container was restarted to clear the in-memory counters (the
documented reset, and a reminder that the numbers are per-process), and sign-in
was re-verified afterwards.

`doclifts-web:pre-0.2.1` deleted after all five passed.

## 13. 0.2.2 — cache correctness and observability

No migration. Ships before the 0.2.3 account work.

### Before deploying

```bash
sudo -n docker tag doclifts-web:vps doclifts-web:pre-0.2.2
```

Rollback:

```bash
DOCLIFTS_WEB_IMAGE=doclifts-web:pre-0.2.2 \
  sudo -n scripts/compose-prod.sh up -d --wait web
```

The build stamps its commit sha into `/_app/version.json`, so set
`DOCLIFTS_BUILD_SHA` in the production env before building:

```bash
DOCLIFTS_BUILD_SHA=$(git rev-parse --short HEAD) sudo -n scripts/compose-prod.sh up -d --build --wait web
```

### Production env after deploy

`LOGIN_MAX_FAILURES=0` — failures slow, never lock. One account on a tailnet
has no attacker to throttle, and a ceiling reachable by a typo is a
self-lockout.

### Three checks after `up -d --build --wait web`

```bash
# 1. /login is uncacheable, and the assets still are
curl -sI https://enochnvps.tail29bbdb.ts.net/login | grep -i cache-control
#   cache-control: no-store, must-revalidate
curl -sI https://enochnvps.tail29bbdb.ts.net/_app/version.json | grep -i cache-control
#   cache-control: public, max-age=0   (NOT no-store, or detection never fires)

# 2. version.json carries the build id
curl -s https://enochnvps.tail29bbdb.ts.net/_app/version.json
#   {"version":"<sha>"}

# 3. one wrong password from the SCRATCH account writes exactly one line
sudo -n scripts/compose-prod.sh logs web --since 1m | grep login_attempt
#   {"event":"login_attempt","ok":false,...,"reason":"bad_credentials",...}
```

### Then the experiment

Chris signs in once from the Safari that failed, with the password he uses
now. Paste the `login_attempt` line(s) verbatim into the record.

- `ok: true` — the cache defect was the cause.
- `ok: false` — the line's `status`, `reason`, `pw_len` and `pw_edge_ws` say
  what actually happened, and 0.2.3 is designed against that.

**Do not clear Safari's cache or cookies before this retry.** That is the
instrument; fixing it destroys the evidence.

### Scratch account

```
scratch-test@doclifts.invalid
```

Created with its own 23 exercises and zero access to any of the owner's rows —
ownership is `NOT NULL`, so a cross-tenant read is a 404 by design. Every
throttle test, probe and control runs against this account. Never the owner's.

### Post-release

Delete `doclifts-web:pre-0.2.2` once all three checks pass. A restart clears
the in-memory throttle counters, so deploying is also a reset.

---

## 14. 0.2.2 — DEPLOYED 2026-10-01

```
0.2.2   01dfeb9
CI      green on main and on the 0.2.2-rc branch
web     1562e49ffce2 -> c4325bf2c124
db      7f866d5b8f80 (never recreated)
```

### Six checks, all passed

```
1  GET  /login            200  cache-control: no-store, must-revalidate
                              vary: Cookie
2  GET  /history (no cookie) 303  cache-control: no-store, must-revalidate
                              location: /login
3  GET  /_app/version.json     {"version":"01dfeb9"}      (not "dev")
4  GET  /_app/immutable/entry/start.CRByK2Mj.js
                              cache-control: public,max-age=31536000,immutable
5  POST /login wrong pw on the SCRATCH account
                              exactly one line:
                              {"event":"login_attempt","ok":false,"status":401,
                               "reason":"bad_credentials","pwLen":28,
                               "pwEdgeWs":false, hashed email/IP/UA only}
6  POST /login x13 wrong pw    every one 200 — never refused:
                              .11s .11s .11s .11s 1.11s 2.11s 4.17s 8.14s
                              8.12s 8.11s 8.12s 8.12s 8.12s
                              then the CORRECT password: 200, ok:true,
                              and the next wrong one back to .11s
```

Check 6 is the one that matters: the old ceiling was 10, so attempt 11 through
13 would each have been a hard refusal under 0.2.1. They were not, and the
correct password still worked afterwards. `LOGIN_MAX_FAILURES=0` behaves as
`0 disables the ceiling` — which required the fix in `01dfeb9`, because the
comparison read `count >= maxFailures` and would have refused every sign-in,
forever, with no typo required.

### Two defects found during the deploy, not before it

**The setting never reached the container.** `LOGIN_MAX_FAILURES=0` was written
to `/srv/doclifts/.env`, the deploy succeeded, and checks 1–4 all passed — while
the throttle still had its default ceiling of 10 in force, because compose
enumerates the container environment explicitly and does not read that file into
it. `printenv` inside the running container showed no `LOGIN_*` at all. Every
tunable now has an explicit passthrough line in `docker-compose.yml`.

**`setHeaders` is not idempotent** (see `CLAUDE.md`) — caught by the harness,
which now prints the child's last 40 lines instead of reporting a bare timeout.

### Post-release state

```
accounts   chris@enoch.ai, scratch-test@doclifts.invalid
sessions   0 and 0 (the scratch session from check 5/6 purged)
data       31 sessions / 454 sets / 2 gyms / 4 programs / 94 exercises
throttle   ceiling disabled, delay curve live (1s 2s 4s 8s)
password   the owner's, unchanged (value deliberately not recorded)
```

`pre-0.2.2` deleted. The `.env.pre-0.2.2` backup removed after verification.

---

## 15. 0.2.3 — DEPLOYED 2026-10-01

```
0.2.3   908e70b  (= 0.2.3-rc1, promoted after §3.5 passed)
CI      green on 0.2.3-rc1 and on main
web     c4325bf2c124 -> dbc0e9de3d55
db      7f866d5b8f80 (never recreated)
```

The lockout. A cookie-bearing sign-in was answered **403 before the password was
compared**, and the login action relabelled it "that email and password do not
match" and counted it against the throttle. Measured in production, one
variable at a time:

```
no cookie                  -> 200 ok:true
any cookie (bogus token)   -> 403
a REAL valid session token -> 403
an unrelated "theme=dark"  -> 403
```

The cookie's value is irrelevant; its presence is the whole trigger. Every
browser that had ever visited the site was locked out of a password that had
always been correct.

Cause, in `better-auth/dist/api/middlewares/origin-check.mjs:137`:

```js
if (headers.has('cookie')) return await validateOrigin(ctx);
```

No cookie skips validation; any cookie forces it; the proxy stripped `Origin`,
so validation could not pass. The comment justifying that strip was written when
`baseURL` still fell back to `http://127.0.0.1:3000` — an origin no browser
sends. The fallback was fixed later and the comment outlived the condition.

Fix: forward `Origin` and `Referer` on **both** paths, so Better Auth's
trusted-origin check runs against the real origin instead of being dodged.

### Post-deploy wire checks

```
Cookie: theme=dark + correct password
  {"ok":true,"status":200,"reason":"ok","pwLen":22,"pwEdgeWs":false}

no cookie + correct password
  {"ok":true,"status":200,"reason":"ok","pwLen":22,"pwEdgeWs":false}

wrong password + the cookie
  {"ok":false,"status":401,"reason":"bad_credentials",
   "errorCode":"INVALID_EMAIL_OR_PASSWORD","pwLen":19}
  throttle: no line — count 1 is below DELAY_AFTER_FAILURES=5

sign-out destroys the session row
  8 -> 9 sessions -> POST /logout -> 8
```

### The owner's own device

```
{"event":"login_attempt","ok":true,"status":200,"reason":"ok",
 "ipHash":"14466d64","emailHash":"af8d3714","pwLen":13,"pwEdgeWs":false,
 "uaHash":"8e0ede7d"}
```

`14466d64` = 100.106.175.83 = iphone-12. `af8d3714` = chris@enoch.ai.
`pwLen` 13 = the owner's password length, no edge whitespace. Same device, same account,
same password as every 403 in the log above — now `ok: true`.

**The password was correct the whole time.**

### Post-release

```
accounts   chris@enoch.ai (2 sessions), scratch-test@doclifts.invalid (0)
data       31 sessions / 454 sets / 2 gyms / 4 programs — untouched
throttle   ceiling disabled (LOGIN_MAX_FAILURES=0), delay curve live
```

`pre-0.2.3` deleted after all checks passed.

### Still open

The behaviour-level reproduction of the 403 does not exist. The mechanism tests
assert CONSTRUCTION and fail without the fix, but nothing reproduces the 403
in the harness — SvelteKit consumes the `cookie` header before the action
runs, and calling the proxy directly returns 401 rather than 403. Closing that
is a standing task, not a done item.

### Rules earned (CLAUDE.md)

- A fixture that is always fresh is not neutral; it is an invisible filter over
  the bug space. Every auth e2e signed in with an empty cookie jar, which is
  exactly where the bug did not reproduce.
- Every handler status gets its own reason; only 401 counts as a failure.
- An enum variant with no producer is a question, not dead code. `origin`
  was deleted as "nothing produces this" — the reason nothing produced it was
  the bug it pointed at.

## 16. 0.2.4 — account management and password policy — DEPLOYED 2026-10-01

```
0.2.4   5b9884d
CI      green on main (run 36814739727)
web     image 7e7148dc13a2 -> 71dc97ff7ed4
db      7f866d5b8f80 (never recreated)
config  login_config: LOGIN_MAX_FAILURES 0, LOGIN_DELAY_MAX_MS 30000, ceiling disabled
        PASSWORD_MIN_LENGTH=12 now explicit in the env file (equal to the
        compose default, so the container was not recreated for it)
```

All five checks passed on the scratch account: sign-in from a browser holding
an unrelated cookie; password change with a second session present (that
session sent to `/login`, exactly one scratch session row left, old password
refused, new one accepted); Show/Hide on `/login`; the hint read "At least 12
characters". `pre-0.2.4` deleted afterwards.

A first scripted run of check 4 reported a failure that was the script's own:
a bare `button[type="submit"]` selector clicked the layout's sign-out button,
which comes before the form's. Scope a submit to its form
(`form:has(#new-password) button[type="submit"]`).

No migration. Spec: `docs/handoffs/REPLY-login-spec.md` §2. **Nothing in this
section runs without the owner's explicit "go" in the current session.**

### What changes for the operator

- **A malformed `LOGIN_*` or `PASSWORD_MIN_LENGTH` now stops the container at
  boot**, naming the variable. 0.2.1–0.2.3 warned and fell back to the default.
  Read the values before deploying (step 2 below).
- `LOGIN_DELAY_MAX_MS` default 8000 → **30000**, in code and in the compose
  default. If the env file does not set it, the delay curve now runs 1, 2, 4,
  8, 16, then 30 s per further failure.
- `PASSWORD_MIN_LENGTH` (default 12, whole number 8–128) is new. **The number is
  Chris's**: the length he will actually type. It applies when a password is
  set — `/account/password` and `user:*` — never at sign-in, so raising it does
  not lock out the current password.
- `scripts/compose-prod.sh` refuses `up` if the env file sets a key
  `docker-compose.yml` never reads.
- Better Auth's origin check is pinned on (`disableOriginCheck: false`), so it
  no longer depends on `NODE_ENV`.

### Before deploying

```bash
# 1. CI green on main at the release sha (gh run list --branch main).

# 2. The tunables, by name and value only — never print the whole env file,
#    it holds secrets. Each LOGIN_* must be a non-negative number;
#    PASSWORD_MIN_LENGTH a whole number from 8 to 128.
sudo -n grep -E '^(LOGIN_|PASSWORD_MIN_LENGTH|SESSION_EXPIRES_DAYS)' /srv/doclifts/.env

# 3. Every key in the env file has a passthrough (compose-prod.sh also runs
#    this before `up`; running it first means a refusal is not a surprise).
sudo -n bash scripts/check-env-passthrough.sh /srv/doclifts/.env

# 4. Preserve the running image.
sudo -n docker tag doclifts-web:vps doclifts-web:pre-0.2.4
```

Rollback:

```bash
DOCLIFTS_WEB_IMAGE=doclifts-web:pre-0.2.4 \
  sudo -n scripts/compose-prod.sh up -d --wait web
```

### Deploy

```bash
sudo -n scripts/compose-prod.sh up -d --build --wait web
```

### Checks — scratch account only

```bash
# 1. The values in force, as the process read them.
sudo -n scripts/compose-prod.sh logs web --since 5m | grep login_config
#   {"event":"login_config","LOGIN_MAX_FAILURES":0,...,"LOGIN_DELAY_MAX_MS":30000,"ceiling":"disabled"}

# 2. The build id.
curl -s https://enochnvps.tail29bbdb.ts.net/_app/version.json
#   {"version":"<release sha>"}
```

3. **Sign in as the scratch account from a browser that has visited before**
   (the 0.2.3 condition). The log line must be `ok:true`.
4. **Change the scratch account's password at `/account/password`**, typed in
   the browser, while a second scratch session exists (a second browser or
   private window). Expect a `password_change` line with `ok:true`, the
   second session sent to `/login` on its next page, and exactly one scratch
   session row:

   ```bash
   sudo -n scripts/compose-prod.sh exec -T db psql -U doclifts -d doclifts -tAc "
     select count(*) from auth.session s join auth.\"user\" u on u.id = s.user_id
     where u.email = 'scratch-test@doclifts.invalid'"
   #   1
   ```

5. On `/login`, **Show** reveals the password and **Hide** masks it again.

`pre-0.2.4` is deleted only after all five pass.

### Then the owner

Set `PASSWORD_MIN_LENGTH` in `/srv/doclifts/.env` to the number he chooses,
restart `web`, confirm the number in the hint on `/account/password` ("At least
N characters" — read from the value Better Auth enforces), and change his own
password at `/account/password`. No CLI in the loop.

### The 0.2.3 open finding, closed

The 403 now reproduces in the harness. The served build inherited Vitest's
`TEST=true`, and Better Auth turns its origin check off in test mode. The
earlier explanation — SvelteKit consuming the `cookie` header — was wrong. The
harness now runs the build as `NODE_ENV=production` without `TEST`, the check
is pinned on in code, and `e2e/sign-in-origin.e2e.ts` holds the
behaviour-level test, which fails with the `Origin` forward reverted.

## 17. 0.2.5 — login delay notice — DEPLOYED 2026-10-01

Deployed together with 0.3.0 and 0.3.1 as `fd916d3` (see §18 for the
deploy record); merged to `main` as `997908b`. The steps below were not run
separately. Branch `feat/0.2.5-throttle-notice`. No migration, no new env key, no compose change. Spec:
`docs/handoffs/REPLY-login-spec.md` §1 item 4 — "When the throttle delays or
refuses, the page says so with the number of seconds. Never a silent wait."
0.2.2 shipped the refusal half; this is the delay half. **Nothing in this
section runs without the owner's explicit "go" in the current session.**

### What changes for the user

With `LOGIN_MAX_FAILURES=0` the delay curve is the only live throttle, and
since 0.2.4 it runs 1, 2, 4, 8, 16, then 30 s per attempt after the 5th
failure. Until now each of those attempts was a submit that hung with nothing
on the page.

- **The wait is announced before it happens.** The failure that crosses the
  threshold (the 5th, at defaults) still says "That email and password do not
  match.", and beside it, in a separate notice: "Several sign-in attempts have
  failed recently, so each new attempt is held before your password is
  checked. The next will be held for 1 second."
- **A held attempt says how long it was held**, and how long the next one
  will be: "This one was held for 2 seconds. The next will be held for 4
  seconds." On every failure that went through the throttle check — 401, 403
  and the handler's 429 — each still with its own message.
- **With JavaScript, the hang counts down**: "Held: your password will be
  checked in 16 seconds." … "Checking your password…". The form still posts
  natively; without JavaScript the server-rendered notice already gave the
  number.
- **Nothing about the throttle itself changed**: same keys, same curve, only
  401 counts. The numbers come from the same IP and email keys, which count
  failures for any address, so an address with no account gets the same
  notice as one with — no new enumeration signal. The refusal (ceiling on)
  is unchanged and still says how long to wait.

### Before deploying

```bash
# 1. CI green on main at the release sha (gh run list --branch main).

# 2. Preserve the running image.
sudo -n docker tag doclifts-web:vps doclifts-web:pre-0.2.5
```

Rollback:

```bash
DOCLIFTS_WEB_IMAGE=doclifts-web:pre-0.2.5 \
  sudo -n scripts/compose-prod.sh up -d --wait web
```

### Deploy

```bash
sudo -n scripts/compose-prod.sh up -d --build --wait web
```

### Checks — scratch account only

```bash
# 1. The build id.
curl -s https://enochnvps.tail29bbdb.ts.net/_app/version.json
#   {"version":"<release sha>"}
```

2. From a browser that has visited before, sign in as
   `scratch-test@doclifts.invalid` with a wrong password five times. The 5th
   page shows the mismatch **and** "The next will be held for 1 second."
3. A 6th wrong password: the notice counts down while it hangs, then reads
   "This one was held for 1 second. The next will be held for 2 seconds."
4. The correct password: held 2 s, then signed in. The log shows one
   `login_throttle` `delay` line per held attempt and `ok:true` last.

Never the owner's account: the email key is per address, and the owner's
would carry the delay into his next sign-in. A restart clears the counters.

`pre-0.2.5` is deleted only after all four pass.

## 18. 0.3.0 — equipment catalog — DEPLOYED 2026-10-01

```
main     fd916d3 (0.2.5 997908b, 0.3.0 41ec429, 0.3.1 fd916d3), one deploy
CI       green on main at each of the three (runs 36843822042, 36845371122,
         36846316422)
migrate  0012 + 0013 applied together; dump predeploy-20261001T101008Z.dump;
         __drizzle_migrations 12 -> 14; equipment_models_catalog_code_unique,
         llm_calls_user_created_idx, llm_calls_purpose_created_idx present
data     31 sessions / 454 sets / 2 gyms / 4 programs — unchanged
web      image 71dc97ff7ed4 -> 1c9baa8a1069; db never recreated
catalog  543 global, 0 owned. gym80 128, Matrix 83, Precor 66, Hammer Strength
         64, Technogym 62, Life Fitness 61, Nautilus 43, Cybex 36
         dumps precatalog-20261001T103258Z, precatalog-20261001T103329Z
rerun    dry run: 0 inserted, 0 updated, 543 unchanged, 0 skipped; declined
```

Checks on the scratch account, from a browser holding an unrelated cookie:
`/`, `/history`, `/gyms`, `/equipment`, `/account/password` all 200 with no
page errors; the only CSP report per page was the tolerated
`#svelte-announcer`. Check 9 (the narrowed picker at the owner's primary gym)
waits on the owner linking a first machine to a catalog model. `pre-0.3.0`
deleted afterwards.

Originally built on branch `feat/0.3.0-catalog` from `main` at 0.2.4
(`5b9884d`). Migration **0012**. Spec:
`SPEC-0.3.0-catalog-0.3.1-llm.md` Part A. Reference: `docs/catalog.md`.
(Numbered 18 because a 0.2.5 section may land as §17 first; this section
stands alone either way.) **Nothing in this section runs without the owner's
explicit "go" in the current session.**

### What changes

- `equipment_models` gains `body_region`, `starting_resistance_basis`,
  `confidence` (not null, default `'user'`), `source_url`, `catalog_snapshot`;
  `gym_equipment` gains nullable `stack_lb`, `increment_lb`. Additive only.
- 543 **global** catalog rows (`owner_user_id IS NULL`), loaded by
  `scripts/catalog-prod.sh`, not by the migration.
- New pages `/equipment`, `/equipment/[id]`, `/equipment/[id]/edit`; the
  model picker on `/gyms` is narrowed per gym.
- No new env var, so no compose passthrough change.

### Migration 0012, verified on a restore of production

Applied with the repo's migrator (`pnpm db:migrate`, as `migrate-prod.sh`
runs it) to a fresh restore of `/srv/backups/doclifts/doclifts-2026-10-01.sql.gz`
in a throwaway database on a disposable container (`doclifts_restore_0012`,
dropped afterwards). Then the importer, twice. Counts only:

| table                           | before | after 0012 | after import |
| ------------------------------- | -----: | ---------: | -----------: |
| `auth.account`                  |      2 |          2 |            2 |
| `auth.session`                  |      2 |          2 |            2 |
| `auth.user`                     |      2 |          2 |            2 |
| `auth.verification`             |      0 |          0 |            0 |
| `drizzle.__drizzle_migrations`  |     12 |         13 |           13 |
| `public.day_exercises`          |     61 |         61 |           61 |
| `public.days`                   |     12 |         12 |           12 |
| `public.equipment_models`       |      0 |          0 |          543 |
| `public.exercise_equipment_map` |      0 |          0 |            0 |
| `public.exercises`              |     94 |         94 |           94 |
| `public.gym_equipment`          |      0 |          0 |            0 |
| `public.gyms`                   |      2 |          2 |            2 |
| `public.imported_workouts`      |    107 |        107 |          107 |
| `public.pain_events`            |      0 |          0 |            0 |
| `public.prescribed_sets`        |    140 |        140 |          140 |
| `public.program_draft_requests` |      1 |          1 |            1 |
| `public.programs`               |      4 |          4 |            4 |
| `public.session_exercises`      |     22 |         22 |           22 |
| `public.sessions`               |     31 |         31 |           31 |
| `public.sets`                   |    454 |        454 |          454 |
| `public.workout_log_imports`    |      1 |          1 |            1 |

New columns, as Postgres reports them:

| column                                       | type    | nullable | default  |
| -------------------------------------------- | ------- | -------- | -------- |
| `equipment_models.body_region`               | text    | yes      | —        |
| `equipment_models.starting_resistance_basis` | text    | yes      | —        |
| `equipment_models.confidence`                | text    | **no**   | `'user'` |
| `equipment_models.source_url`                | text    | yes      | —        |
| `equipment_models.catalog_snapshot`          | date    | yes      | —        |
| `gym_equipment.stack_lb`                     | integer | yes      | —        |
| `gym_equipment.increment_lb`                 | integer | yes      | —        |

New objects, by name: index `equipment_models_catalog_code_unique` (unique,
`(manufacturer, code)` where code is non-empty and `owner_user_id IS NULL`);
checks `equipment_models_confidence_check`,
`equipment_models_body_region_check`,
`equipment_models_resistance_basis_check`, `gym_equipment_stack_lb_check`,
`gym_equipment_increment_lb_check`. A second `db:migrate` is a no-op. The
import: 543 inserted (gym80 128, Matrix 83, Precor 66, Hammer Strength 64,
Technogym 62, Life Fitness 61, Nautilus 43, Cybex 36); the second run 0
inserted, 0 updated, 543 unchanged. All 543 are global: 360
`manufacturer_page`, 106 `reseller_or_manual`, 69 `inferred`, 8 `line_only`.

Production held **no** `equipment_models` or `gym_equipment` rows at that
dump, so no existing row is reinterpreted by the new `confidence` default.

### Before deploying

```bash
# 1. CI green on main at the release sha (gh run list --branch main).

# 2. Preserve the running image.
sudo -n docker tag doclifts-web:vps doclifts-web:pre-0.3.0
```

### Migrate, deploy, import

```bash
# 3. Migration 0012 (verified dump first; refuses to migrate without one).
sudo -n scripts/migrate-prod.sh

# 4. Deploy. 0.2.4 code ignores the new columns, so 3 before 4 is safe.
sudo -n scripts/compose-prod.sh up -d --build --wait web

# 5. The catalog: verified dump, dry run printed, then type IMPORT.
#    Expect the dry run to show 543 inserted, 0 updated, 0 skipped, and the
#    26 stack_lb rows listed as not imported.
sudo -n scripts/catalog-prod.sh data/catalog/equipment_models_seed_2026-09-30.csv
```

### Checks

```bash
# 6. 543 global rows.
sudo -n scripts/compose-prod.sh exec -T db psql -U doclifts -d doclifts -tAc \
  "select count(*) from equipment_models where owner_user_id is null"
#   543

# 7. Idempotent: run step 5 again; the dry run must show 0 inserted, 0 updated.
#    Answer anything but IMPORT to stop there.
```

8. `/equipment` renders with filters: 543 models; manufacturer → Apply shows
   the product-line select; searching `IL-ROW` leaves one row.
9. **The picker at Chris's primary gym.** Production has no machines with a
   model yet, so `/gyms` first says "No machines with a known model in this gym
   yet". Add one real machine from its catalog page (`/equipment` → the model →
   "Add to a gym"); `/gyms` with that gym selected then lists only that
   manufacturer's models, and "Show all manufacturers" lists 543.

`pre-0.3.0` is deleted only after 6–9 pass.

### Rollback

```bash
DOCLIFTS_WEB_IMAGE=doclifts-web:pre-0.3.0 \
  sudo -n scripts/compose-prod.sh up -d --wait web
```

0012 is additive and 0.2.4 runs against it unchanged, so the schema stays.
The catalog rows can stay too, with one cost: 0.2.4 lists every model in the
`/gyms` select and serializes all of them into every live-session page, so
with 543 rows those pages get heavier until 0.3.0 is back. The narrow undo is
in `docs/catalog.md`, and the full one is the `precatalog-*.dump` that
`catalog-prod.sh` took.

## 19. 0.3.1 — LLM adapter foundation — DEPLOYED 2026-10-01

Deployed with 0.3.0 (record in §18). Then the key and model:

```
env      OPENROUTER_API_KEY and LLM_MODEL=stealth/space-bunny-alpha added;
         web recreated; both set in the container (presence checked, never
         the value); no key in the web log
ping     purpose ping, provider openrouter, model stealth/space-bunny-alpha,
         status ok, 177 prompt / 60 completion tokens, 1213 ms,
         output {"ok": true, "model": "Space Bunny"}, prompt not stored,
         request id recorded — on the scratch account
```

OpenRouter does not list `structured_outputs` for this model, but it accepts
`response_format`, and the ping's object validated against its schema. A
richer schema is the real test; a `schema_error` row is what failure looks
like.

Originally built on branch `feat/0.3.1-llm` from `feat/0.3.0-catalog`
at `bdcd629` (0.3.0, itself not yet on `main`). Migration **0013**. Spec:
`SPEC-0.3.0-catalog-0.3.1-llm.md` Part B. Reference: `docs/llm.md`.
**0.3.1 ships after 0.3.0: §18 is done first, and its migration 0012 is part
of this chain.** **Nothing in this section runs without the owner's explicit
"go" in the current session.**

### What changes

- New table `llm_calls`, additive only. Nothing writes it until a feature
  calls `complete()`; 0.3.1 has no such feature.
- New dependencies `ai` 7.0.123 and `@openrouter/ai-sdk-provider` 3.1.0
  (production dependencies; nothing in a route imports them yet).
- Seven new env vars, **all optional for boot**: `LLM_PROVIDER`, `LLM_MODEL`,
  `LLM_VISION_MODEL`, `OPENROUTER_API_KEY`, `LLM_TIMEOUT_MS`,
  `LLM_MAX_CALLS_PER_USER_PER_HOUR`, `LLM_STORE_PROMPTS`. Every one has a
  `docker-compose.yml` passthrough line in this release, so adding one to the
  env file passes `check-env-passthrough.sh`.
- `pnpm llm:ping`, the smoke test for the key.
- No new page or route; the CSP crawl is unchanged.

### Migration 0013, verified on a restore of production

Applied with the repo's migrator (drizzle-orm `migrate()`, as
`migrate-prod.sh` runs it) to a fresh restore of
`/srv/backups/doclifts/doclifts-2026-10-01.sql.gz` in a throwaway database on
the disposable test container (`doclifts_restore_0013`, dropped afterwards).
The dump is at 0011, so the chain applied 0012 and 0013. Counts only:

| table                           | before | after 0013 |
| ------------------------------- | -----: | ---------: |
| `auth.account`                  |      2 |          2 |
| `auth.session`                  |      2 |          2 |
| `auth.user`                     |      2 |          2 |
| `auth.verification`             |      0 |          0 |
| `drizzle.__drizzle_migrations`  |     12 |         14 |
| `public.day_exercises`          |     61 |         61 |
| `public.days`                   |     12 |         12 |
| `public.equipment_models`       |      0 |          0 |
| `public.exercise_equipment_map` |      0 |          0 |
| `public.exercises`              |     94 |         94 |
| `public.gym_equipment`          |      0 |          0 |
| `public.gyms`                   |      2 |          2 |
| `public.imported_workouts`      |    107 |        107 |
| `public.llm_calls`              |      — |          0 |
| `public.pain_events`            |      0 |          0 |
| `public.prescribed_sets`        |    140 |        140 |
| `public.program_draft_requests` |      1 |          1 |
| `public.programs`               |      4 |          4 |
| `public.session_exercises`      |     22 |         22 |
| `public.sessions`               |     31 |         31 |
| `public.sets`                   |    454 |        454 |
| `public.workout_log_imports`    |      1 |          1 |

New objects, by name, as Postgres reports them: table `llm_calls` (15
columns); `llm_calls_pkey` (`id`); FK `llm_calls_user_id_fk`
(`user_id` → `auth."user"(id)`, NO ACTION); CHECK `llm_calls_status_check`
(`ok`, `schema_error`, `provider_error`, `timeout`, `refused`); indexes
`llm_calls_user_created_idx` (`user_id, created_at`) and
`llm_calls_purpose_created_idx` (`purpose, created_at`). Longest constraint
name 22 bytes. `drizzle-kit check` is green.

### Before deploying

```bash
# 1. §18 (0.3.0) deployed and its checks passed. CI green on main at the
#    release sha (gh run list --branch main).

# 2. Preserve the running image.
sudo -n docker tag doclifts-web:vps doclifts-web:pre-0.3.1
```

3. **Add the key and the model to `/srv/doclifts/.env`** with an editor, not
   with `echo` (shell history) and not by pasting into a chat:

   ```dotenv
   OPENROUTER_API_KEY=<the key>
   LLM_MODEL=<an OpenRouter model id, vendor/model>
   ```

   The rest default (`docs/llm.md`). The app also runs without these two; they
   are needed only for step 6 and for future features.

### Migrate, deploy

```bash
# 4. Migration 0013 (verified dump first; refuses to migrate without one).
sudo -n scripts/migrate-prod.sh

# 5. Deploy. 0.3.0 code ignores llm_calls, so 4 before 5 is safe. The
#    passthrough check runs first and must list the new keys as read.
sudo -n scripts/compose-prod.sh up -d --build --wait web
```

### Checks

```bash
# 6. The key reached the container — presence only, never the value.
sudo -n docker exec doclifts-web sh -c \
  'test -n "$OPENROUTER_API_KEY" && test -n "$LLM_MODEL" && echo both set'
#   both set

# 7. The smoke test, once, in the builder image, on the owner's own account.
cd /home/chris/code/DocLifts
sudo -n bash -c '
  set -euo pipefail
  set -a; source <(grep -E "^[A-Za-z_][A-Za-z0-9_]*=" /srv/doclifts/.env); set +a
  export DATABASE_URL="postgresql://doclifts:${POSTGRES_PASSWORD}@db:5432/doclifts"
  docker build --target builder -t doclifts-migrations:local .
  docker run --rm --network doclifts_default -e DATABASE_URL \
    --env-file /srv/doclifts/.env \
    doclifts-migrations:local pnpm llm:ping --email <your account email>'
#   prints "ok": true, a model name, a call_id, tokens and latency

# 8. Its row.
sudo -n scripts/compose-prod.sh exec -T db psql -U doclifts -d doclifts -c \
  "select status, model, prompt_tokens, completion_tokens, latency_ms,
          prompt_text is null as no_prompt
   from llm_calls where purpose = 'ping' order by created_at desc limit 1"
#   ok | <LLM_MODEL> | n | n | n | t
```

9. Pages still load (`/`, `/history`, `/equipment`): nothing in a route calls
   the LLM layer, so this is only the image changing under them.

A `refused` row with `not_configured` in step 8 means a variable is missing
(step 7 printed which); `provider_error` with `http_401` means the key is
wrong. Either is fixed in the env file and a restart, not a release. Step 7
is the acceptance test for the key; the module's own acceptance is the
offline test suite.

`pre-0.3.1` is deleted only after 6–9 pass.

### Rollback

```bash
DOCLIFTS_WEB_IMAGE=doclifts-web:pre-0.3.1 \
  sudo -n scripts/compose-prod.sh up -d --wait web
```

0013 is additive and 0.3.0 runs against it unchanged, so the table stays.
The env file may keep the LLM keys: this rollback still uses the checkout's
0.3.1 `docker-compose.yml`, which reads them, so the passthrough check passes
and the 0.3.0 image simply ignores them. Only if the checkout itself is moved
back to 0.3.0 does `check-env-passthrough.sh` refuse the `up` and name them;
comment them out of the env file then.

## 20. 0.3.2 — machine label and edit, catalog promotion/recode/retirement, notes, standard stack — DEPLOYED 2026-10-01

```
0.3.2     bc43f0b, tagged 0.3.2
web       image 4d7476fd2dae
migrate   0014 + 0015 applied; 16 rows in drizzle.__drizzle_migrations;
          verified dump predeploy-20261001T150455Z.dump
catalog   2026-10-01 snapshot, run by the owner; dump
          precatalog-20261001T150529Z.dump. Dry run as expected: 354
          inserted, 195 promoted, 9 recoded, 7 retired, 0 skipped
result    897 global rows = 890 active + 7 retired; 355 with a standard
          stack, 590 with notes, 21 active without a code
re-run    second dry run 0 inserted / 0 updated / 0 promoted / 0 recoded /
          890 unchanged / 0 skipped / 0 retired; declined
machine   the owner's machine still linked, now to Nautilus 9NP-L3004
          Leverage Row
history   31 sessions, 454 sets, unchanged
browser   scratch account: every page 200; /equipment "890 models";
          IL-DRW and 9NP-L3004 found; IL-DY and the retired VR1
          placeholder not found; 0 page errors; only the tolerated
          #svelte-announcer CSP report
image     pre-0.3.2 deleted after the checks
```

The plan as written before the deploy follows, unchanged.

```
branch   feat/0.3.2 from main 43490c3 (production ran 0.3.1 = fd916d3 + docs)
migrate  0014: equipment_models.notes; 0015: standard_stack_lb (CHECK > 0),
         standard_stack_note, retired_at. Additive. Verified on a restore of
         doclifts-2026-10-01.sql.gz, below
catalog  import the 2026-10-01 snapshot (890 rows). Expected TOTAL against
         production's catalog: 354 inserted, 225 updated, 195 promoted,
         9 recoded, 107 unchanged, 0 skipped, 7 retired
```

Built on branch `feat/0.3.2`. Migrations **0014** and **0015**. Reference:
`docs/catalog.md`. **Nothing in this section runs without the owner's explicit
"go" in the current session.**

### What changes

- **The machine label is optional** on `/gyms` and on `/equipment/[id]` "add
  to a gym" when a model is chosen (or typed in). Blank stores
  `<manufacturer> <name>` plus ` (<code>)` when the model has one, e.g.
  "Hammer Strength Iso-Lateral Row (IL-ROW)", "Nautilus Leverage Row". Blank
  with no model is refused with a message. `gym_equipment.local_label` stays
  NOT NULL; no schema change for this. Existing labels are not touched.
- **Edit a machine** (owner request, "Drop an edit option in"): an **Edit**
  link per machine on `/gyms` opens `/gyms/[gymId]/machines/[id]/edit`, which
  changes the label, stack and increment (not the model). Blank label: the
  model's default, or refused with no model. Another user's machine, or one
  under the wrong gym, is a 404. No schema change.
- **The importer promotes instead of duplicating.** A coded CSV row with no
  global row for `(manufacturer, code)` updates the one global codeless row of
  the same `(manufacturer, product_line, name)` in place, so `gym_equipment`
  links (production has one, to Nautilus "Leverage Row") keep pointing at it.
  Reported in a new `promoted` column. Two candidates, or two CSV rows claiming
  one: the run fails, nothing written.
- **The importer recodes corrected codes.** An optional last CSV column,
  `replaces_code`, names a model's earlier code; the global row under that
  code takes the new code, name and catalog columns in place (new `recoded`
  column). Rows under both codes: the run fails. The 2026-10-01 snapshot uses
  it for 9 corrected codes.
- **`equipment_models.notes`** (migration 0014, additive). The importer maps
  the CSV `notes` column as a catalog column; `/equipment/[id]` shows it;
  "create my own copy" carries it.
- **The model's standard stack** (migration 0015): `standard_stack_lb`
  (integer, CHECK > 0) and `standard_stack_note`, from the CSV's `stack_lb` /
  `stack_note`, whole pounds rounded down (36 half-pound Life Fitness stacks;
  the exact figure stays in the note). Adding a machine with a model and the
  stack blank stores the standard stack; `/equipment/[id]` shows it and
  pre-fills the stack field. A typed stack always wins.
- **Retirement** (migration 0015): `retired_at`. Every global row the snapshot
  does not contain is retired (never deleted) and hidden from `/equipment`,
  search, the `/gyms` picker and new machines; its page still renders with
  "No longer in the catalog", and linked machines keep it. A snapshot that
  lists it again un-retires it. Owned rows are never touched. Reported in a
  `retired` column, one `retire` line per row, replacing "N existing global
  row(s) are not in this CSV".
- No new env var, so no compose passthrough change.

### Migration 0014, verified on a restore of production

The newest dump on 2026-10-01 was `/srv/backups/doclifts/doclifts-2026-10-01.sql.gz`
(03:00, so before 0012/0013 and before the catalog import and the owner's
first machine). Restored into a throwaway database (`doclifts_restore_032`) on
the disposable test container, the full chain 0012 → 0014 applied with
`drizzle-kit migrate`, then the importer. The database was dropped afterwards.
Counts only:

| table                           | before | after 0012–0014 | after import |
| ------------------------------- | -----: | --------------: | -----------: |
| `auth.account`                  |      2 |               2 |            2 |
| `auth.session`                  |      2 |               2 |            2 |
| `auth.user`                     |      2 |               2 |            2 |
| `auth.verification`             |      0 |               0 |            0 |
| `drizzle.__drizzle_migrations`  |     12 |              15 |           15 |
| `public.day_exercises`          |     61 |              61 |           61 |
| `public.days`                   |     12 |              12 |           12 |
| `public.equipment_models`       |      0 |               0 |          543 |
| `public.exercise_equipment_map` |      0 |               0 |            0 |
| `public.exercises`              |     94 |              94 |           94 |
| `public.gym_equipment`          |      0 |               0 |            0 |
| `public.gyms`                   |      2 |               2 |            2 |
| `public.imported_workouts`      |    107 |             107 |          107 |
| `public.llm_calls`              |      — |               0 |            0 |
| `public.pain_events`            |      0 |               0 |            0 |
| `public.prescribed_sets`        |    140 |             140 |          140 |
| `public.program_draft_requests` |      1 |               1 |            1 |
| `public.programs`               |      4 |               4 |            4 |
| `public.session_exercises`      |     22 |              22 |           22 |
| `public.sessions`               |     31 |              31 |           31 |
| `public.sets`                   |    454 |             454 |          454 |
| `public.workout_log_imports`    |      1 |               1 |            1 |

New column, as Postgres reports it:

| column                   | type | nullable | default |
| ------------------------ | ---- | -------- | ------- |
| `equipment_models.notes` | text | yes      | —       |

`equipment_models` keeps its constraints and indexes by name
(`equipment_models_catalog_code_unique`, `equipment_models_owner_user_id_idx`,
the confidence, body region, resistance basis and resistance checks, the owner
FK). The import wrote 543 rows, 298 with notes; a second dry run read 543
unchanged. Then, to reproduce production's state (catalog imported by 0.3.1,
so every `notes` NULL), notes were nulled and the dry run read **0 inserted,
298 updated, 0 promoted, 245 unchanged, 0 skipped**, every `update` line
naming `notes` only: Cybex 36, gym80 24, Hammer Strength 30, Life Fitness 32,
Matrix 35, Nautilus 41, Precor 38, Technogym 62.

### Migration 0015 and the 2026-10-01 import, rehearsed on a restore of production

The same dump, restored into a fresh throwaway database on the test container;
0012 → 0015 applied with `drizzle-kit migrate` (`__drizzle_migrations` 12 →
16; `standard_stack_lb`, `standard_stack_note`, `retired_at` present;
`equipment_models_standard_stack_lb_check` present by name); 2026-09-30
imported (543 inserted); one machine linked to Nautilus "Leverage Row"
(codeless) and one to Hammer Strength `IL-DY` (a corrected code). Then
2026-10-01:

```
                inserted  updated  promoted  recoded  unchanged  skipped  retired
dry run              354      155       195        9        177        0        7
run                  354      155       195        9        177        0        7
dry run again          0        0         0        0        890        0        0
```

- **Retired 7**, the product-line placeholders the research replaced with
  models: Cybex VR1, VR1 Duals, VR3, Cybex Plate Loaded; Technogym Artis
  Strength, Element+; Precor Glutebuilder line.
- `equipment_models` afterwards: 897 rows, 890 current, 7 retired, 0 owned;
  **355 with a standard stack** (36 rounded down from half pounds); 597 with
  notes (590 from this snapshot, plus the 7 retired rows' old notes).
- **Both links survived** on the same model ids: "Leverage Row" promoted to
  `9NP-L3004`, `IL-DY` recoded to `IL-DRW`, both current. Every user-data
  table's row count unchanged (31 sessions, 454 sets, 2 gyms, 4 programs).
- **Production's shape.** Production's 543 rows were written by 0.3.0, so they
  have no notes and no stacks. A second restore with notes and stacks cleared
  after the 2026-09-30 import gave the dry-run TOTAL to expect in production:
  **354 inserted, 225 updated, 195 promoted, 9 recoded, 107 unchanged,
  0 skipped, 7 retired** (Cybex 99/4/28/0/0/0/4, gym80 27/24/0/0/104/0/0,
  Hammer Strength 20/26/33/5/0/0/0, Life Fitness 18/2/59/0/0/0/0, Matrix
  64/82/0/0/1/0/0, Nautilus 53/21/18/4/0/0/0, Precor 20/53/10/0/2/0/1,
  Technogym 53/13/47/0/0/0/2).

Both restore databases were dropped.

### Before deploying

```bash
# 1. CI green on main at the release sha (gh run list --branch main).

# 2. Preserve the running image.
sudo -n docker tag doclifts-web:vps doclifts-web:pre-0.3.2
```

### Migrate, deploy, import

```bash
# 3. Migrations 0014 and 0015 (verified dump first; refuses without one).
sudo -n scripts/migrate-prod.sh

# 4. Deploy. 0.3.1 code ignores the new columns, so 3 before 4 is safe.
sudo -n scripts/compose-prod.sh up -d --build --wait web

# 5. The 2026-10-01 snapshot: verified dump, dry run printed, then type
#    IMPORT. Expect TOTAL: 354 inserted, 225 updated, 195 promoted,
#    9 recoded, 107 unchanged, 0 skipped, 7 retired, and the 7 retire lines
#    naming the placeholders above. Any skip, refusal, ambiguity or conflict,
#    or a different retired count: answer anything but IMPORT and stop.
sudo -n scripts/catalog-prod.sh data/catalog/equipment_models_seed_2026-10-01.csv
```

### The 2026-10-01 snapshot

`data/catalog/equipment_models_seed_2026-10-01.csv`: 890 rows from five
research agents, one per brand group, under `research-2026-10-01/BRIEF.md`
(every new or changed code from a page fetched that day, cited in `source`;
the per-brand change logs sit beside it). Against 2026-09-30: codeless 210 ->
21, inferred 69 -> 10, line_only 8 -> 1, with starting resistance 11 -> 98.
17 wrong codes corrected, 9 of them on rows that already had a code (carried
by `replaces_code`). About 60 codes were spot-checked against their sources
by fetching them again; all confirmed. Merge decisions: the two Hammer
Strength smith machines dropped; Technogym Artis rows `reseller_or_manual`
because Technogym's own pages pair Artis codes and names two ways; Precor's
PD-xx codes noted as dealer SKUs; 11 starting weights without a stated basis
(or stated only in kg) moved to `notes` rather than guessed.

### Checks

```bash
# 6. The catalog: 890 current, 7 retired, 355 standard stacks, 590 notes.
sudo -n scripts/compose-prod.sh exec -T db psql -U doclifts -d doclifts -tAc \
  "select count(*) filter (where retired_at is null),
          count(*) filter (where retired_at is not null),
          count(*) filter (where standard_stack_lb is not null),
          count(*) filter (where notes is not null)
   from equipment_models where owner_user_id is null"
#   890|7|355|590

# 7. The owner's machine kept its model, which gained its code and is current.
sudo -n scripts/compose-prod.sh exec -T db psql -U doclifts -d doclifts -tAc \
  "select m.manufacturer, m.code, m.name, m.retired_at is null
   from gym_equipment g join equipment_models m on m.id = g.equipment_model_id"
#   Nautilus|9NP-L3004|Leverage Row|t  (and any machines added since)

# 8. Idempotent: run step 5 again; the dry run must show 0 inserted,
#    0 updated, 0 promoted, 0 recoded, 890 unchanged, 0 retired. Answer
#    anything but IMPORT to stop.
```

9. On the scratch account: `/equipment` lists 890 models; a retired
   placeholder (search `VR3 (legacy)`) lists 0 models, and its page, opened by id (`select id, name from equipment_models where retired_at is not null`), is 200 with "No longer in the catalog". A model with a
   standard stack (e.g. Hammer Strength `MTSBC`) shows "Standard stack:
   100 lb" and pre-fills "Add to a gym"; adding it with the label blank adds
   "Hammer Strength MTS Iso-Lateral Biceps Curl (MTSBC)" with a 100 lb stack.
   `/gyms` with no model and no label refuses with "Give the machine a label,
   or choose its model so the label can be taken from it". **Edit** on the
   scratch machine, change its label, save: the list shows it. Remove the
   scratch machine afterwards.
10. **Then the owner** fixes his own first machine's label ("Make this
    optional maybe? Next to deadlift platform") with **Edit** on `/gyms`. Not
    done by an assistant.

`pre-0.3.2` is deleted only after 6–9 pass.

### Rollback

```bash
DOCLIFTS_WEB_IMAGE=doclifts-web:pre-0.3.2 \
  sudo -n scripts/compose-prod.sh up -d --wait web
```

0014 and 0015 are additive and 0.3.1 runs against them unchanged, so the
columns stay. One difference under 0.3.1: it does not know `retired_at`, so
the 7 retired placeholders reappear in its lists and picker until 0.3.2 is
back. Promoted and recoded rows keep their new codes, and machines added with
a derived label keep it; to 0.3.1 it is an ordinary label.

## 21. 0.4.0 — equipment from a photo — DEPLOYED 2026-10-01

```
0.4.0     d4aba0a, tagged 0.4.0 (CI on main: test + docker green)
env       staged S3 file appended by the owner; passthrough check 14 keys
migrate   0016 applied; 17 rows in drizzle.__drizzle_migrations; verified
          dump predeploy-20261001T161426Z.dump
web       rebuilt 16:16 UTC; sharp 0.35.5 loads in the runtime image
s3        Linode us-ord-10, bucket doclifts-s3-storage, private
checks    scratch account (9-14): upload -> review -> link -> machine
          "Hammer Strength Iso-Lateral Row (IL-ROW)"; discard deletes the
          object; bucket holds one object under the scratch user's prefix;
          every page 200; 31 sessions / 454 sets unchanged
found     the first real analysis was refused for a missing key -> 0.4.1
          (see §22). pre-0.4.0 deleted after the re-check.
```

The plan below is what was run (steps 1-14), kept as written.

```
branch   feat/0.4.0-photo from feat/0.3.2 2041136, merged with main bc43f0b
         (0.3.2, deployed; production is at 0015, 16 migration rows)
status   NOT deployed. Nothing below has run against production.
migrate  0016: equipment_photos (new table). Verified on a restore of
         doclifts-2026-10-01.sql.gz, below. In production only 0016 is
         pending: expect 17 migration rows afterwards
env      the staged S3 file appended (/home/chris/doclifts-s3.env), plus
         PHOTO_STORE=s3 and BODY_SIZE_LIMIT=12M if it does not carry them
```

Built on branch `feat/0.4.0-photo`. Migration **0016**. Spec:
`SPEC-0.4.0-equipment-photo.md`. Reference: `docs/photos.md`. **0.4.0 ships
after 0.3.2, which is deployed (§20); production is at 0015.** **Nothing in this section runs without the owner's explicit "go" in
the current session.**

Deviations from the spec, all decided before the build: the migration is
0016, not 0014 (0.3.2 took 0014 and 0015); no `secrets-apply.sh` and no allowlist (the
new keys are enforced by `check-env-passthrough.sh` like every other); a model
created from a photo may carry the reader's notes in 0.3.2's
`equipment_models.notes`; matching gained a leading-digit step (Nautilus `9NP-L3004` vs
`NP-L3004`) and a prefix step (catalog base code vs placard SKU); a blank machine label takes 0.3.2's default label. Found while
building: adapter-node answers an over-limit body with a **500**, not a 413
(see `docs/photos.md`).

### What changes

- **New page** `/gyms/<id>/equipment/photo` (upload), **new page**
  `/photos/<id>/review` (link / create my own / re-analyze / discard), **new
  route** `GET /photos/<id>/image` (owner-only image proxy). Thumbnails on
  `/gyms` and `/equipment/<id>`. CSP unchanged.
- **New table `equipment_photos`** (0016), additive. Written only by the photo
  routes.
- **The first `complete()` consumer**: `purpose = 'equipment_from_photo'`,
  `kind = 'vision'`. Uses `LLM_VISION_MODEL`, falling back to `LLM_MODEL`; the
  model must accept images.
- **New dependencies** `sharp` 0.35.5 (native; the runtime stage now loads it
  at build time and fails the build if the musl binary is missing) and
  `@aws-sdk/client-s3` 3.1138.0. CI gains a `docker` job that builds the
  runtime image and runs sharp inside it.
- **Nine new env vars**, all optional for boot (read on first use):
  `PHOTO_STORE`, `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`,
  `S3_SECRET_ACCESS_KEY`, `PHOTO_MAX_BYTES`, `PHOTO_DAILY_LIMIT`,
  `BODY_SIZE_LIMIT`. Every one has a `docker-compose.yml` passthrough line in
  this release; `BODY_SIZE_LIMIT` defaults to `12M` there.

### Migration 0016, verified on a restore of production

The newest dump was `/srv/backups/doclifts/doclifts-2026-10-01.sql.gz` (03:00,
at 0011; production has since applied 0012–0015). Restored into a throwaway
database (`doclifts_scratch_0016`) on the disposable test container, the full
chain 0012 → 0016 — main's 0015 `equipment_model_stack_retired` included —
applied with `drizzle-kit migrate`; the database was dropped afterwards.
Counts only:

| table                           | before | after 0012–0016 |
| ------------------------------- | -----: | --------------: |
| `auth.account`                  |      2 |               2 |
| `auth.session`                  |      2 |               2 |
| `auth.user`                     |      2 |               2 |
| `auth.verification`             |      0 |               0 |
| `drizzle.__drizzle_migrations`  |     12 |              17 |
| `public.day_exercises`          |     61 |              61 |
| `public.days`                   |     12 |              12 |
| `public.equipment_models`       |      0 |               0 |
| `public.equipment_photos`       |      — |               0 |
| `public.exercise_equipment_map` |      0 |               0 |
| `public.exercises`              |     94 |              94 |
| `public.gym_equipment`          |      0 |               0 |
| `public.gyms`                   |      2 |               2 |
| `public.imported_workouts`      |    107 |             107 |
| `public.llm_calls`              |      — |               0 |
| `public.pain_events`            |      0 |               0 |
| `public.prescribed_sets`        |    140 |             140 |
| `public.program_draft_requests` |      1 |               1 |
| `public.programs`               |      4 |               4 |
| `public.session_exercises`      |     22 |              22 |
| `public.sessions`               |     31 |              31 |
| `public.sets`                   |    454 |             454 |
| `public.workout_log_imports`    |      1 |               1 |

0015's objects are present as main defines them (`equipment_models`
`standard_stack_lb`, `standard_stack_note`, `retired_at`, CHECK
`equipment_models_standard_stack_lb_check`). New in 0016, by name, as Postgres
reports them: table `equipment_photos` (16 columns; `user_id` text NOT NULL,
`candidate` jsonb, `created_at` timestamptz); `equipment_photos_pkey`; FKs,
all NO ACTION: `equipment_photos_user_id_fk` (→ `auth."user"(id)`),
`equipment_photos_gym_id_fk` (→ `gyms`), `equipment_photos_llm_call_id_fk`
(→ `llm_calls`), `equipment_photos_matched_model_id_fk` and
`equipment_photos_created_model_id_fk` (→ `equipment_models`),
`equipment_photos_gym_equipment_id_fk` (→ `gym_equipment`); unique
`equipment_photos_storage_key_unique`; CHECKs `equipment_photos_status_check`
(`uploaded`, `analyzed`, `confirmed`, `discarded`) and
`equipment_photos_size_check`; indexes `equipment_photos_user_created_idx`
(`user_id, created_at`), `equipment_photos_gym_equipment_idx`, and one on each
other FK column (`_gym_idx`, `_llm_call_idx`, `_matched_model_idx`,
`_created_model_idx`). Longest name 36 bytes. `drizzle-kit check` is green.
0016's SQL is identical to the photo migration this branch first numbered 0015
(never applied anywhere), regenerated after main's 0015.

### Before deploying

```bash
# 1. CI green on main at the release sha, BOTH jobs (test and docker):
#    gh run list --branch main

# 2. Preserve the running image.
sudo -n docker tag doclifts-web:vps doclifts-web:pre-0.4.0
```

3. **The S3 values are already staged** in `/home/chris/doclifts-s3.env` (mode
   600), verified by a round trip against Linode `us-ord-10`, bucket
   `doclifts-s3-storage`, private. Nobody reads it into a chat or a log. Check
   its key NAMES only:

   ```bash
   sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' /home/chris/doclifts-s3.env
   #   S3_ENDPOINT S3_REGION S3_BUCKET S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY
   #   (and possibly PHOTO_STORE / BODY_SIZE_LIMIT)
   ```

4. **Append it to production's env file at deploy time**, keeping a copy of
   the file first:

   ```bash
   sudo -n cp -p /srv/doclifts/.env /srv/doclifts/.env.pre-0.4.0
   # The leading echo guards against an env file with no final newline.
   sudo -n sh -c '{ echo; cat /home/chris/doclifts-s3.env; } >> /srv/doclifts/.env'
   ```

   Then, with an editor, add whichever of these two the staged file did not
   carry (names and meanings; the S3 values stay as staged):

   ```dotenv
   # store photos in S3-compatible storage (the code's default too)
   PHOTO_STORE=s3
   # adapter-node's body ceiling; its 512K default refuses every phone photo
   BODY_SIZE_LIMIT=12M
   ```

   `PHOTO_MAX_BYTES` (10485760) and `PHOTO_DAILY_LIMIT` (20) default; add them
   only to change them. `LLM_VISION_MODEL` must name a model that accepts
   images if `LLM_MODEL` does not. Each key once: `sudo -n grep -c` a name if in
   doubt, never print the file.

5. **The passthrough check**, before anything is started:

   ```bash
   sudo -n scripts/check-env-passthrough.sh /srv/doclifts/.env
   #   env passthrough check: all N key(s) in /srv/doclifts/.env are read by docker-compose.yml
   ```

### Migrate, deploy

```bash
# 6. Migration 0016 (verified dump first; refuses to migrate without one).
#    Only 0016 is pending; afterwards drizzle.__drizzle_migrations has 17 rows.
sudo -n scripts/migrate-prod.sh

# 7. BODY_SIZE_LIMIT is in the rendered compose config. One line only: the
#    rendered config carries every value, secrets included, so never print it whole.
sudo -n scripts/compose-prod.sh config | grep -E '^\s+BODY_SIZE_LIMIT:'
#       BODY_SIZE_LIMIT: 12M

# 8. Deploy. 0.3.2 code ignores equipment_photos, so 6 before 8 is safe. The
#    passthrough check runs again inside compose-prod.sh.
sudo -n scripts/compose-prod.sh up -d --build --wait web
```

### Checks

```bash
# 9. The variables reached the container — presence only, never the values.
sudo -n docker exec doclifts-web sh -c \
  'for v in PHOTO_STORE S3_ENDPOINT S3_REGION S3_BUCKET S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY BODY_SIZE_LIMIT; do
     test -n "$(printenv $v)" && echo "$v set" || echo "$v MISSING"; done'
#   seven "set" lines
```

10. On the **scratch** account (`scratch-test@doclifts.invalid`, never the
    owner's), in a gym of its own: **Add a machine from a photo**, upload one
    real placard photo, review it, **link** it to the catalog model it shows.
    The page says "Added to <gym>"; the gym's machine list shows the
    thumbnail.

```bash
# 11. The row, and the machine it made.
sudo -n scripts/compose-prod.sh exec -T db psql -U doclifts -d doclifts -c \
  "select p.status, p.width, p.height, c.status as llm, c.model,
          ge.local_label, m.manufacturer, m.code
   from equipment_photos p
   join auth.\"user\" u on u.id = p.user_id
   left join llm_calls c on c.id = p.llm_call_id
   left join gym_equipment ge on ge.id = p.gym_equipment_id
   left join equipment_models m on m.id = p.matched_model_id
   where u.email = 'scratch-test@doclifts.invalid'
   order by p.created_at"
#   confirmed | <=1600 | <=1600 | ok | <vision model> | <label> | <maker> | <code>

# 12. The object is under the scratch user's prefix and nowhere else. Run in
#     the web container, which already holds the credentials (nothing secret
#     on the command line).
sudo -n docker exec -w /app doclifts-web node -e "
  const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');
  const e = process.env;
  new S3Client({ endpoint: e.S3_ENDPOINT, region: e.S3_REGION,
    credentials: { accessKeyId: e.S3_ACCESS_KEY_ID, secretAccessKey: e.S3_SECRET_ACCESS_KEY },
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' })
    .send(new ListObjectsV2Command({ Bucket: e.S3_BUCKET }))
    .then((r) => console.log((r.Contents ?? []).map((o) => o.Key + ' ' + o.Size).join('\n') || '(empty)'));"
#   users/<scratch user id>/equipment-photos/<photo id>.jpg <bytes>   (exactly one line)
sudo -n scripts/compose-prod.sh exec -T db psql -U doclifts -d doclifts -tAc \
  "select id from auth.\"user\" where email = 'scratch-test@doclifts.invalid'"
#   the same <scratch user id>
```

13. Still on the scratch account: upload a second photo and **discard** it.
    The page says "Discarded"; step 12 again still lists only the first
    object; the second row is `discarded` in step 11's query.
14. Pages still load (`/`, `/gyms`, `/equipment`, `/history`).

`pre-0.4.0` is deleted only after 9–14 pass. Then the owner does the first
real one at his gym, on his own account: that is the acceptance.

A page saying photo storage is not set up means an S3 variable is missing (the
web log names it). A 500 on upload with `exceeds limit of 524288 bytes` in the
log means `BODY_SIZE_LIMIT` did not reach the container. "Analysis failed"
with a `refused`/`not_configured` row means the LLM variables;
`provider_error` with an `http_4xx` code usually means the model does not
accept images. Each is fixed in the env file and a restart, not a release.

### Rollback

```bash
DOCLIFTS_WEB_IMAGE=doclifts-web:pre-0.4.0 \
  sudo -n scripts/compose-prod.sh up -d --wait web
```

0016 is additive and 0.3.2 runs against it unchanged, so the table and the
bucket's objects stay. `/srv/doclifts/.env.pre-0.4.0` is the env file as it
was before step 4. The env file may keep the new keys while the checkout
stays at 0.4.0 (its compose reads them); if the checkout moves back to 0.3.2,
`check-env-passthrough.sh` will name them, so comment them out first.

## 22. 0.4.1-0.4.6 — photo fixes from first real use — DEPLOYED 2026-10-01

No migrations, no new env keys (two values changed, below). Each release:
local gate in CI order, CI on the branch (test + docker), fast-forward,
CI on main, owner rebuilds web, then checked here. Every fix came from the
owner using the feature on his phone at a gym the same afternoon.

```
0.4.1  dd56bc3  missing keys in a model reply read as unknown (a correct
                placard was refused for omitting product_line)
0.4.2  ede989f  no capture="environment" on the photo input: Android opened
                the camera with no way to pick an existing photo
0.4.3  7f49a9f  enum synonyms ("iso-lateral" -> independent, "weight_stack"
                -> selectorized); any other string -> unknown
0.4.4  9684cf2  complete() wireSchema: the model gets a plain JSON schema,
                zod still validates. Derived schema 15-16 s per call, plain
                3.7-7 s (Haiku 4.5); the slow path caused the 60 s timeouts
0.4.5  9993218  nav wraps at phone width; "Added to <gym> as" keeps its space
0.4.6  fb0fabf  password inputs: autocapitalize=none, autocorrect=off,
                spellcheck=false (iOS changed a new password while Show was on;
                the owner reset it with user-prod.sh set-password)
```

Env changes, made by the owner in `/srv/doclifts/.env`:

```
LLM_TIMEOUT_MS      30000 -> 60000
LLM_VISION_MODEL    (unset, fell back to LLM_MODEL) -> anthropic/claude-haiku-4.5
                    -> google/gemini-2.5-flash-lite
LLM_MODEL           stealth/space-bunny-alpha, unchanged; temporary, text only
```

Vision model choice, measured from the production container with the app's
system prompt and wire schema, median of 3 (owner's gym80 4364 placard /
a synthetic placard / cost per call):

```
anthropic/claude-haiku-4.5     4.6 s / 3.7 s / $0.0036  maker read as "Pure Kraft Strong"
google/gemini-2.5-flash        2.9 s / 1.2 s / $0.0012  one reply not valid JSON; one 10 s
google/gemini-2.5-flash-lite   2.2 s / 1.7 s / $0.0002  gym80 4364 Bench Press Dual; steady
google/gemini-3.5-flash-lite   1.9 s / 1.3 s / $0.0011  one 9 s outlier
```

Production after 0.4.6 (21:05 UTC): 15 photos (8 confirmed, 5 analyzed and
waiting on the owner's review, 2 discarded); flash-lite analyses 2.4-2.7 s.

## 23. 0.4.7 — Home shows only the signed-in user's programs — DEPLOYED 2026-10-01

```
0.4.7    fea8700, tagged 0.4.7; CI green on the branch and on main
fix      src/routes/+page.server.ts filtered programs only by is_active, so
         a second account saw the owner's program names on Home. Now
         programs.user_id = requireUser(locals).id
test     route test, cross-tenant shape (Alice first, then Bob sees none);
         watched failing against 0.4.6
audit    every route server file and lib/server function reading owned
         data: no other unscoped list or by-id read/write. Hardening: the
         three session queries on programs/[id] also filter sessions.user_id
deploy   code only; pre-0.4.7 preserved, web rebuilt 23:11 UTC, healthy
check    the scratch account's Home showed 0 of the owner's 2 active
         programs; pre-0.4.7 deleted afterwards
```

## 24. 0.5.0 (Part A) — resize photos on the phone — DEPLOYED 2026-10-02, accepted 2026-10-02

**Owner sign-off, 2026-10-02:** tested from his iPhone and accepted. The
upload is in the log at 01:08 UTC: `clientOriginalBytes` 2,827,060,
`clientResized` true, `receivedBytes` 933,941 (33%, under the 1.5 MB
target), `storedBytes` 267,502, stored 1200x1600 (portrait, upright), and
confirmed by him. **Still owed, not blocking:** the five-real-placard
comparison with resize on and off, once he puts camera originals on the
VPS (outside the public repo).

```
0.5.0    71b7a20, tagged 0.5.0 (the spec's Part A; Part B ships as 0.5.1)
CI       green on the branch; full local gate 647 / 3 / 31 / 101
deploy   code only; pre-0.5.0 preserved, web rebuilt, healthy. pre-0.5.0
         was then deleted after the assistant's check, before the
         development-push rule (keep it until the owner signs off) was
         written; rollback is a rebuild from tag 0.4.7 (fea8700)
check    scratch account, live page, Chromium: a 4,660,232-byte 4000x3000
         placard -> photo_upload log: clientResized true, receivedBytes
         540,808 (12%), storedBytes 235,763; review in 3.3 s including the
         read (4364 read correctly); labels 'Preparing photo' then
         'Identifying machine…'; 0 page errors; test photo discarded
owed     the owner's real iPhone/Android check and five real placards with
         resize on and off (below)
```

Code only. No migration, no new environment variable, no change to
`docker-compose.yml`, `PHOTO_MAX_BYTES` or `BODY_SIZE_LIMIT`. Deploying it is
the ordinary build and `up`, like §22, with no extra step.

The settings live in `src/lib/photo-client.ts` (`photoClientSettings`); to
turn the resize off, set `enabled: false` there and redeploy. The upload log
line is `{"event":"photo_upload",…}`; see `docs/photos.md`, "Resize on the
phone".

Before tagging, per the spec's "accept when", on a real iPhone and a real
Android phone: a ~4 MB photo arrives under 1.5 MB (`receivedBytes` in the log
line) and upright; at least five of the owner's placards read the same with
`enabled` true and false.

### Placard read, resize on vs off (pre-check, 2026-10-01)

Five generated placards at camera size (4000x3000, about 4.6 MB each, small
print included; gym80 4364, Hammer Strength IL-ROW, Nautilus NP-L3004, Life
Fitness SS-LP, Matrix G3-S70). Path ON: the real `src/lib/photo-client.ts`,
bundled with esbuild and run in Chrome (`resizeForUpload`, 530-541 KB in about
0.22 s each), then the real `processPhoto`. Path OFF: `processPhoto` on the
original. Both stored 1600x1200 (ON about 3% more bytes). Read from the
production container with `google/gemini-2.5-flash-lite`, the app's system
prompt and wire schema:

```
model code, maker, starting weight, stack   identical on 5/5
name                                        3/5 identical on the first pass
repeat (hammer, nautilus; 3 reads per path) the name varies on the SAME image:
  hammer   off  ISO-LATERAL ROW | ROW | Row       on  Row | ISO-LATERAL ROW | Row
  nautilus off  Leverage Row | LEVERAGE ROW | ROW  on  Leverage Row | ROW | ROW
codes across all 17 reads                   never varied
```

The name differences are the model's run-to-run variance, not the resize; the
fields matching depends on (the code first, then the maker) do not move. Still
owed before tagging, because only the owner's phone has camera originals: the
same comparison on five of his real placards, and the size and orientation
check on a real iPhone and Android phone.

### A dropped connection keeps the photo

With `use:enhance`, an upload that never reaches the server (gym Wi-Fi, a
proxy 5xx) used to render the error page and lose the chosen photo. The page
now keeps the form and the selected file, shows `labels.failed`, and the retry
is one tap. e2e: the POST is aborted (`internetdisconnected`), the alert shows,
the URL and the selected file are unchanged, nothing is stored, and the retry
reaches review. Watched failing with the first Part A handler (the page was
replaced and the alert never appeared).

## 25. 0.5.1 — start a workout with no program — DEPLOYED 2026-10-02, accepted 2026-10-02

**Owner sign-off, 2026-10-02:** walked on his iPhone with a fresh empty
account (`chris-phone-01@doclifts.invalid`): signed in, Start workout, typed a
new gym at the gym step, added an exercise, saved 2 sets, finished at 02:48
UTC; also a photo upload (3.2 MB chosen, 962 KB received) read and confirmed.
Accepted. `pre-0.5.1` deleted after the sign-off. His notes on the exercise
picker (machine picker or tree) are for later.

```
0.5.1    14922ff, tagged 0.5.1; branch CI green (test + docker); full local
         gate 698 / 3 / 31 / 103
restore  0017 applied to a FRESH pg_dump of production taken just before
         (at 0016): every row count unchanged (31 sessions, 454 sets, 4
         programs, 5 gyms, 11 machines, 898 models, 18 photos, 24 llm_calls,
         2 users); migrations 17 -> 18; all four names present
quiet    open workouts active in 6 h: 0; last write 56 min before; app
         events in the last 30 min: 0
image    pre-0.5.1 kept until the owner signed off; deleted after
env      PHOTO_DAILY_LIMIT=60 (owner default for testing); backup
         /srv/doclifts/.env.pre-0.5.1; passthrough check 17 keys
migrate  verified dump predeploy-20261002T022254Z.dump; 18 migration rows
web      rebuilt 02:23 UTC, healthy; PHOTO_DAILY_LIMIT=60 in the container
check    fresh empty account fresh-051@doclifts.invalid, 390x844, live:
         Start workout on Home, no programs listed; new gym typed at the
         gym step; "Workout" heading, picker open; gym preselected; first
         set saved; Home "Resume workout"; finished; History "Quick
         workout"; no sideways scroll; 0 page errors
owed     the owner's phone walk-through on a fresh account
known    a quick workout moved to Trash cannot be restored from the UI
         (Trash lives on a program page); sent to Project Claude
```

Branch `feat/0.5.1-quick-workout`, off `main` at `5dba397` (production runs
0.5.0). Not merged, not tagged, not deployed.

```
0.5.1    the spec's Part B (start a workout with no program), plus
         catalog-prod.sh taking a CSV outside the repo, and photo
         prompt rule 3a
gate     full local gate in CI order: server 698, demo 3, client 31,
         e2e 103 (baseline at 5dba397: 647 / 3 / 31 / 101)
CLAUDE   one commit touches CLAUDE.md (file map only); the owner reads
         that diff before it reaches main
```

### What changes

- **Migration 0017** (additive): `programs.system_kind` and
  `sessions.gym_id`. Each user gets one hidden system program, "Quick
  workouts", with one day, created the first time they tap Start workout.
  A quick workout is an ordinary session on that day.
- **New page** `/workout/start` (the gym step). Home gains the Start / Resume
  workout button. The system program never appears on Home, its program page
  or the editor (all 404 / not found); History and Reports label its sessions
  "Quick workout".
- **Photo prompt rule 3a**: an unclear model code is returned as null. Reads
  change for unclear codes only; see `docs/photos.md`.
- **`scripts/catalog-prod.sh`** accepts an absolute path to a CSV outside the
  repo (mounted read-only). Not run as part of this deploy.
- **One env change at deploy:** `PHOTO_DAILY_LIMIT=60` while the owner and the
  tester are testing (owner default; the code default stays 20).

### Migration 0017, verified on a restore of production

The newest nightly was `/srv/backups/doclifts/doclifts-2026-10-01.sql.gz`
(03:00 UTC, taken before 0012–0016 were applied, so at 0011; the 2026-10-02
nightly did not exist yet). Restored into a throwaway database
(`doclifts_scratch_051`) on this branch's disposable test container
(`doclifts-test-db-051`). The chain was applied in two steps so the last
one is exactly production's pending step: 0012 → 0016 (the chain without
0017, i.e. production's state), then 0017 alone, both with drizzle-orm's
migrator. The database was dropped afterwards. Counts only:

| table                           | dump (0011) | at 0016 | at 0017 |
| ------------------------------- | ----------: | ------: | ------: |
| `auth.account`                  |           2 |       2 |       2 |
| `auth.session`                  |           2 |       2 |       2 |
| `auth.user`                     |           2 |       2 |       2 |
| `auth.verification`             |           0 |       0 |       0 |
| `drizzle.__drizzle_migrations`  |          12 |      17 |      18 |
| `public.day_exercises`          |          61 |      61 |      61 |
| `public.days`                   |          12 |      12 |      12 |
| `public.equipment_models`       |           0 |       0 |       0 |
| `public.equipment_photos`       |           — |       0 |       0 |
| `public.exercise_equipment_map` |           0 |       0 |       0 |
| `public.exercises`              |          94 |      94 |      94 |
| `public.gym_equipment`          |           0 |       0 |       0 |
| `public.gyms`                   |           2 |       2 |       2 |
| `public.imported_workouts`      |         107 |     107 |     107 |
| `public.llm_calls`              |           — |       0 |       0 |
| `public.pain_events`            |           0 |       0 |       0 |
| `public.prescribed_sets`        |         140 |     140 |     140 |
| `public.program_draft_requests` |           1 |       1 |       1 |
| `public.programs`               |           4 |       4 |       4 |
| `public.session_exercises`      |          22 |      22 |      22 |
| `public.sessions`               |          31 |      31 |      31 |
| `public.sets`                   |         454 |     454 |     454 |
| `public.workout_log_imports`    |           1 |       1 |       1 |

New in 0017, by name, as Postgres reports them: columns `programs.system_kind`
(text, nullable) and `sessions.gym_id` (uuid, nullable); CHECK
`programs_system_kind_check` (`system_kind IS NULL OR system_kind = 'quick'`);
unique index `programs_one_quick_per_user` on `programs (user_id) WHERE
system_kind = 'quick'`; FK `sessions_gym_id_fk` (→ `gyms(id)`, NO ACTION);
index `sessions_gym_id_idx`. On the restored data no program has a
`system_kind` and no session a `gym_id` (both 0 of 4 / 0 of 31), so every
existing program and workout is unchanged. Longest new name 27 bytes.
`drizzle-kit check` is green.

**Before deploying, repeat this on the newest nightly** if it is newer than
2026-10-01 (from 2026-10-02 it is at 0016, so only 0017 applies): restore it
into a scratch database on a disposable container, apply the chain, compare
counts, drop it. CLAUDE.md: migrations only after the chain passes on a
restore of the nightly dump.

### Before deploying (development-push mode)

```bash
# 1. CI green on main at the release sha, BOTH jobs (test and docker):
#    gh run list --branch main

# 2. Quiet check (CLAUDE.md, "Development-push mode"): all three must pass,
#    otherwise wait and retry.
q() { sudo -n scripts/compose-prod.sh exec -T db psql -U doclifts -d doclifts -tAc "$1"; }
q "select count(*) from (select s.id from sessions s
     left join sets st on st.session_id = s.id
     where s.ended_at is null and s.deleted_at is null
     group by s.id
     having greatest(s.started_at, max(st.logged_at)) > now() - interval '6 hours') b"
#   0
q "select now() - greatest(
     (select max(logged_at) from sets), (select max(started_at) from sessions),
     (select max(ended_at) from sessions), (select max(created_at) from equipment_photos),
     (select max(created_at) from llm_calls), (select max(updated_at) from programs),
     (select max(updated_at) from auth.session))"
#   over 30 minutes
sudo -n scripts/compose-prod.sh logs web --since 30m \
  | grep -cE '"event":"(login_attempt|password_change|photo_upload)"'
#   0 (not counting the assistant's own scratch-account checks)

# 3. Keep the running image until the owner signs 0.5.1 off.
sudo -n docker tag doclifts-web:vps doclifts-web:pre-0.5.1
```

4. **The one env change**, `PHOTO_DAILY_LIMIT=60` (owner default while testing;
   the code and compose default is 20). Its passthrough line already exists:
   `docker-compose.yml` has `PHOTO_DAILY_LIMIT: ${PHOTO_DAILY_LIMIT:-20}` in
   the `web` environment (checked on this branch), and
   `env-passthrough.test.ts` covers every `PHOTO_ENV` key. Keep a copy, then
   set the key once:

   ```bash
   sudo -n cp -p /srv/doclifts/.env /srv/doclifts/.env.pre-0.5.1
   sudo -n grep -c '^PHOTO_DAILY_LIMIT=' /srv/doclifts/.env
   #   0 -> append it; 1 -> edit that line to 60 with an editor
   sudo -n sh -c 'printf "\nPHOTO_DAILY_LIMIT=60\n" >> /srv/doclifts/.env'
   sudo -n scripts/check-env-passthrough.sh /srv/doclifts/.env
   #   env passthrough check: all N key(s) in /srv/doclifts/.env are read by docker-compose.yml
   ```

### Migrate, deploy

```bash
# 5. Migration 0017 (migrate-prod.sh takes and verifies its own dump first,
#    and refuses to migrate without one). Only 0017 is pending; afterwards
#    drizzle.__drizzle_migrations has 18 rows.
sudo -n scripts/migrate-prod.sh

# 6. Deploy. 0.5.0 code never reads the two new columns, so 5 before 6 is
#    safe. The passthrough check runs again inside compose-prod.sh.
sudo -n scripts/compose-prod.sh up -d --build --wait web
```

### Checks

```bash
# 7. Migration objects by name.
q "select count(*) from drizzle.__drizzle_migrations"
#   18
q "select string_agg(n, ', ' order by n) from (
     select conname n from pg_constraint
      where conname in ('programs_system_kind_check', 'sessions_gym_id_fk')
     union all select indexname from pg_indexes
      where indexname in ('programs_one_quick_per_user', 'sessions_gym_id_idx')) x"
#   programs_one_quick_per_user, programs_system_kind_check, sessions_gym_id_fk, sessions_gym_id_idx

# 8. The limit reached the container (not a secret).
sudo -n docker exec doclifts-web printenv PHOTO_DAILY_LIMIT
#   60
```

9. **On a fresh, empty test account**, never the owner's, and **not** the
   scratch account (`scratch-test@doclifts.invalid` already has a gym, so it
   hides the first-run state). Create it with the password piped from the
   owner's own shell, never typed into a command line by an assistant:

   ```bash
   printf '%s' "$(pass show doclifts-fresh)" | scripts/user-prod.sh create \
     --email fresh-0.5.1@doclifts.invalid --password-stdin --name "Fresh 0.5.1"
   ```

   Then, signed in as it, on a phone-width page:
   - Home shows **Start workout** above **Create program**, and no programs.
   - Start workout → the gym step has no gyms; type a gym name → Start. The
     workout opens headed **Workout** and the date, with the add-exercise
     control already open and that gym chosen.
   - Add an exercise (name a new machine), save a first set. Home now reads
     **Resume workout** and opens the same workout. Finish it.
   - Start workout again: the gym is preselected; one tap. Add the same
     exercise on the same machine: the weight is filled in from the first
     workout and "Last: …" shows under it.
   - History lists both as **Quick workout**; Reports' recent trend labels the
     finished one **Quick workout**. The program list is still empty.
   - Pages still load (`/`, `/gyms`, `/equipment`, `/history`, `/reports`).

```bash
# 10. The fresh account's rows: one quick program, two sessions in its gym,
#     and no other user's rows touched.
q "select p.system_kind, count(distinct s.id), count(distinct s.gym_id)
   from programs p join auth.\"user\" u on u.id = p.user_id
   left join sessions s on s.program_id = p.id
   where u.email = 'fresh-0.5.1@doclifts.invalid' group by 1"
#   quick | 2 | 1
q "select count(*) from programs where system_kind is not null"
#   1 (only the fresh account has used it so far)
```

`pre-0.5.1` is kept until the owner signs the release off. The owner's own
check (a brand-new account from Home to a saved first set **on a phone**, and
the second workout showing last time's numbers) is the spec's acceptance;
until then the release is "deployed, acceptance pending".

### Rollback

```bash
DOCLIFTS_WEB_IMAGE=doclifts-web:pre-0.5.1 \
  sudo -n scripts/compose-prod.sh up -d --wait web
```

0017 is additive and 0.5.0 runs against it unchanged (it never reads
`system_kind` or `gym_id`). Quick workouts already logged stay in the
database; under 0.5.0 they show on Home as a program named "Quick workouts"
and in History under that name, and are otherwise ordinary sessions.
`/srv/doclifts/.env.pre-0.5.1` is the env file before step 4; the
`PHOTO_DAILY_LIMIT` key is safe to keep (0.5.0's compose reads it too).

## 26. 0.5.2 — the name guard on photo matching, and Trash on History — DEPLOYED 2026-10-02, accepted 2026-10-02

**Owner sign-off, 2026-10-02:** accepted together with 0.5.5 ("yes, it covers both"). The `pre-` image deleted after the sign-off.

```
0.5.2    d2f0c05, tagged 0.5.2; branch CI green (test + docker); full local
         gate 730 / 3 / 31 / 104
quiet    suspended by the owner (2026-10-02: no users yet)
image    pre-0.5.2 kept until the owner signs off
web      rebuilt 03:44 UTC, healthy; no migration, no env change
check    name guard, scratch account: a generated placard reading gym80
         4386N (a real code, Booty Booster Special) with the name LEG
         CURL -> nothing preselected, the names-disagree line shown, 4386N
         offered first; the 4157 + BOOTY BOOSTER placard was
         inconclusive as a guard test (4157 is not in the catalog: no code
         match, names only, 4352 offered, nothing preselected); photos
         discarded
check    Trash on History, fresh empty account fresh-052@doclifts.invalid,
         390x844: Move to Trash from the session page lands on History
         with no error (the fixed bug); Trash (1); Restore -> Trash (0) and
         listed again; trashed again, Delete permanently -> Trash (0), the
         workout 404s; no sideways scroll; 0 page errors
owed     the owner's own look at both
```

Code only: no migration, no env change. Deploy under development-push mode:
quiet check, `pre-0.5.2` kept until the owner signs off, `compose-prod.sh up
-d --build --wait web`, then the check below.

Check (scratch account): upload a generated placard reading gym80 / `4157` /
PURE KRAFT BOOTY BOOSTER. Review must show the name-disagrees line, 4157
first, 4352 among the names, and no radio preselected. Discard the photo.

### Trash on History

What changes: History has a "Trash (N)" section, collapsed by default, that
lists every trashed workout of the signed-in user, quick or program, with
Restore and Delete permanently (confirmed the same way as on the program
page). The actions are `restoreSession` and `permanentDeleteSession` on
`/history`; they call the same owner-scoped by-id functions as the program
page (`restoreSoftDeletedSession`, `hardDeleteSession`). The program page's
Trash is unchanged. Also: the session page's Move to Trash follows its
redirect instead of showing "Could not complete that action".

Check **on a fresh, empty test account created at deploy time**: never the
owner's, and **not** `chris-phone-01`, which belongs to the owner's own
testing. Create it with the password piped from the owner's own shell, never
typed into a command line by an assistant:

```bash
printf '%s' "$(pass show doclifts-fresh)" | scripts/user-prod.sh create \
  --email fresh-0.5.2@doclifts.invalid --password-stdin --name "Fresh 0.5.2"
```

Before the walk-through, note every other user's session count; it must be
the same afterwards:

```bash
q "select count(*) from sessions s join auth.\"user\" u on u.id = s.user_id
   where u.email <> 'fresh-0.5.2@doclifts.invalid'"
```

Signed in as it, on a phone-width page:

- History shows **Trash (0)** at the bottom, closed. Opening it says
  "Trash is empty."
- Start workout → name a gym → Start. Add an exercise (name a new machine),
  save one set, Finish workout.
- History → the workout → Edit workout → **Move to Trash** → confirm. The
  page goes to History with **no error line**. The workout is gone from the
  month's list; **Trash (1)**, closed.
- Open Trash: one row, **Quick workout**, today's date, **1 set logged**.
  **Restore**: it is back in the month's list and Trash reads (0).
- Move it to Trash again. In Trash, **Delete permanently** shows the
  confirmation ("Permanently delete Quick workout from …? This cannot be
  undone."); Cancel leaves it there; Delete permanently again, then confirm.
  Trash reads (0) and the month's list does not show it.

```bash
# The fresh account has no sessions and no sets left.
q "select count(*) from sessions s join auth.\"user\" u on u.id = s.user_id
   where u.email = 'fresh-0.5.2@doclifts.invalid'"
#   0
q "select count(*) from sets st join auth.\"user\" u on u.id = st.user_id
   where u.email = 'fresh-0.5.2@doclifts.invalid'"
#   0
# Every other user's session count: the same as before the walk-through.
```

## 27. 0.5.3 — hand the photo straight to analysis, and time each stage — DEPLOYED 2026-10-02, accepted 2026-10-02

**Owner sign-off, 2026-10-02:** accepted together with 0.5.5 ("yes, it covers both"). The `pre-` image deleted after the sign-off.

```
0.5.3    67c359a, tagged 0.5.3; branch CI green (test + docker); full local
         gate 753 / 3 / 31 / 104
quiet    suspended by the owner (2026-10-02: no users yet)
image    pre-0.5.3 kept until the owner signs off
web      rebuilt 03:59 UTC, healthy; no migration, no env change
check    scratch account: a generated placard stored and reviewed as
         before; its line: processWaitMs 0, processMs 19, storePutMs 189,
         modelMs 1943, totalMs 2166; photo discarded
check    a 99-byte PNG declaring 20000x20000: "This photo is 20000×20000
         (400 megapixels); the limit is 50. Take it at a lower
         resolution."; line outcome refused, processWaitMs null, processMs
         1-2, totalMs 3-4; web memory 59 -> 60 MiB
check    photo-timings-report.sh 1: 4 lines (1 stored, 3 refused), 0
         without timings, no ids printed
due      2026-10-09: photo-timings-report.sh 7, medians to the owner
owed     the owner's own look
```

Code only: no migration, no env change. Deploy under development-push mode:
quiet check, `pre-0.5.3` kept until the owner signs off, `compose-prod.sh up
-d --build --wait web`, then the check below. Ships after 0.5.2.

What changes: `uploadPhoto` returns the processed JPEG with the row and the
upload action passes it to `analyzePhoto` (no read-back from the store in the
upload request; Re-analyze still reads the store). The `photo_upload` line
gains `processWaitMs`, `processMs`, `storePutMs`, `modelMs` and `totalMs` and
is written once at the end of the action. Security follow-up in the same
release: a photo over 50 megapixels (`MAX_INPUT_PIXELS`, a constant) is
refused from its header before any decode, the decode itself is capped at the
same number, and at most two photos are decoded at once
(`MAX_CONCURRENT_PROCESSING`, a constant); no env or compose change. The step order and the upload transaction are
unchanged. Details in `docs/photos.md`, "Timing each stage".

Check (scratch account, `scratch-test@doclifts.invalid`): upload one generated
placard and confirm the line carries the five timings as whole numbers, and
the review page shows the candidate as before. Discard the photo. Then upload
a generated PNG whose header declares 20000×20000 (a few hundred bytes, as in
`handmadePng` in `photos/test-fixtures.ts`) and confirm the page shows "This
photo is 20000×20000 (400 megapixels); the limit is 50…", the log line says
`"outcome":"refused"` with `processWaitMs` null, and memory stays flat
(`docker stats --no-stream` on the web container before and after).

```sh
sudo -n scripts/compose-prod.sh logs web --since 10m | grep '"event":"photo_upload"' | tail -1
```

Expect `"outcome":"stored"` and integer `processWaitMs`, `processMs`,
`storePutMs`, `modelMs`, `totalMs` (a model read of about 2-3 s with the current model). Then run
`scripts/photo-timings-report.sh 1` once and confirm it prints one stored
upload and no ids.

**Due one week after deploy:** run `scripts/photo-timings-report.sh 7` and
give the owner the medians; he decides from them whether the put and the
model call run in parallel. Nothing is parallelized before that.

## 28. 0.5.4 — security updates from the first code scan — DEPLOYED 2026-10-02, accepted 2026-10-02

**Owner sign-off, 2026-10-02:** accepted together with 0.5.5 ("yes, it covers both"). The `pre-` image deleted after the sign-off.

From the first CodeQL and Dependabot report (owner OK, 2026-10-02). Code
only: no migration, no env change.

```
0.5.4    bdaf706, tagged 0.5.4; branch CI green (test + docker); full local
         gate 753 / 3 / 31 / 104
change   @sveltejs/kit 2.61.1 -> 2.70.3 (latest 2.x; 3.0 is a separate
         decision); devalue 5.8.1 -> 5.9.4; ci.yml permissions: contents:
         read. Both confirmed inside the new image.
alerts   CodeQL 1-2 (missing-workflow-permissions) fixed by the push;
         CodeQL 3-5 (test files) left for the owner to dismiss as "used in
         tests"; Dependabot 26 -> 16 open: every kit and devalue alert
         closed; left: dev and test tools the server never loads, and
         cookie 0.6.0 (kit pins ^0.6.0)
quiet    suspended by the owner (2026-10-02: no users yet)
image    pre-0.5.4 kept until the owner signs off
web      rebuilt 09:51 UTC, healthy; version.json bdaf706
check    scratch account, 390x844: sign-in form action lands on Home;
         /, /history, /gyms, /equipment, /reports and the photo upload
         page 200; a cross-origin form POST is refused 403 (CSRF check);
         sign-out, then /history redirects to /login; no 5xx, 0 page
         errors; no error lines in the web log
owed     the owner's own look
```

CodeQL does not read `.svelte` files: its run on `main` scanned 181/181
TypeScript, 2/2 JavaScript, 1/1 HTML and 1/1 Actions files, and none of
the 26 components. None of them uses `{@html}`.

## 29. 0.5.5 — the app shell (SPEC 0.5.0 Part E) — DEPLOYED 2026-10-02, accepted 2026-10-02

**Owner sign-off, 2026-10-02:** checked on his iPhone, added to the home
screen with the new icon, tabs at the bottom. "Everything looks good, I sign
off." `pre-0.5.5` deleted after the sign-off.

**Answer to the spec's open check:** the installed app needs its own sign-in.
The owner had to sign in again after adding it to the home screen: iOS keeps a
home-screen web app's cookies separate from Safari's. Tell a new tester to
sign in once more after adding the icon.

```
0.5.5    a22d5ea, tagged 0.5.5; branch CI green (test + docker); full local
         gate 767 (+2 skipped) / 3 / 31 / 132
quiet    suspended by the owner (2026-10-02: no users yet)
image    pre-0.5.5 kept until the owner signs off
web      rebuilt 11:59 UTC, healthy; version.json a22d5ea
check    fresh empty account fresh-055@doclifts.invalid (created at deploy,
         password in a mode-600 scratch file only), 390x844, live:
         sign-in page names the app, tagline, no sign-up link; Home shows
         the three first-run lines and one Start workout, nothing about
         programs; /, /gyms, /history, /reports, /equipment: 4 tabs one
         row at the bottom, each >= 44 px, the right tab current (Gyms on
         /equipment), no sideways scroll, empty states on Gyms, History,
         Reports; account button -> /account with the email; manifest
         (standalone) and the 192, 512 and 180 px icons 200 image/png; an
         open workout shows its bar and no tabs, finishing brings them
         back; Sign out from /account, then /history goes to /login; no
         5xx, 0 page errors
owed     the owner's iPhone checks below
```

Code only: no migration, no env change. Deploy under development-push mode
(quiet check suspended), `pre-0.5.5` kept until the owner signs off,
`compose-prod.sh up -d --build --wait web`.

What changes: the bottom tab bar (Workout, Gyms, History, Reports) replaces
the top links; the account button opens `/account` (email, Change password,
Sign out as a POST form); `static/manifest.webmanifest`, the icons
(`scripts/make-icons.mjs`), `theme-color`, `apple-touch-icon` and
`viewport-fit=cover`; Home's first-run state; empty states on Gyms, History and
Reports; "Page · DocLifts" titles on every page; the sign-in page's name and
tagline. The open workout's bar replaces the tabs (`workoutBar`). The phone
crawl in `e2e/csp.e2e.ts` loads every route at 390 px.

Check (assistant, production): a fresh empty account at 390x844 sees the three
first-run lines and one button; the tabs are one row at the bottom; the
account button reaches `/account`; Sign out works from there;
`/manifest.webmanifest` and the three icons are served; an open workout shows
its bar and no tabs.

**Owed by the owner, on the iPhone:**

- Add to Home Screen from Safari: the DocLifts icon, and it opens with no
  browser bars.
- Whether the installed app needs its own sign-in, separate from Safari (the
  spec's open check). Record the answer here.
- The tab bar clears the home indicator, and a page scrolled to the bottom
  shows its last control above the tabs.

## 30. 0.6.0 — photo in the workout (SPEC 0.5.0 Part C, first half) — DEPLOYED 2026-10-02, acceptance pending

```
0.6.0    d503b5c, tagged 0.6.0; branch CI green (test + docker); full local
         gate 778 (+2 skipped) / 3 / 31 / 135
migrate  migrate-prod.sh: dump predeploy-20261002T145850Z.dump verified
         (220K); 0018 applied; 19 migration rows; FK present; 36 sessions,
         457 sets, 23 photos unchanged
quiet    suspended by the owner (no tester account yet)
image    pre-0.6.0 kept until the owner signs off
web      rebuilt 14:59 UTC, healthy; version.json d503b5c
check    scratch account, Scratch photo check gym, 390x844, real model:
         Photo next machine (>= 44 px, no capture); the block opened in
         811 ms with "Identifying machine…" showing; a set of 50 x 10
         saved 970 ms after the photo (scripted on the VPS); the read
         returned "Hammer Strength Iso-Lateral Row (IL-ROW)" 3.3 s after
         the photo; Use this named it "Iso-Lateral Row", plates per side;
         finished -> Home with nothing to name. psql: the 50 x 10 set
         unchanged, all three sets on the gym's one IL-ROW machine (merged),
         photo confirmed on it, no "Photo" machine left; the upload line
         "source":"workout", totalMs 285, modelMs null; no 5xx, 0 page
         errors
owed     the owner's phone: photo to first saved set under 3 s on cellular
```

**Migration 0018** (additive): `equipment_photos.session_exercise_id`, nullable,
FK `equipment_photos_session_exercise_id_fk` to `session_exercises` with
`ON DELETE SET NULL`, index `equipment_photos_session_exercise_idx`. Before the
deploy: apply 0000-0018 to a fresh restore of the nightly dump and record row
counts and the new names (CLAUDE.md, migrations rule 3); then
`migrate-prod.sh`, which takes and verifies its own dump. No env change
(`PHOTO_DAILY_LIMIT` is already 60).

```
restore  0018 applied to a FRESH pg_dump of production taken 2026-10-02
         (at 0017; a 24-byte "==> building" line from compose-prod.sh
         stripped from the front of the archive first): every row count
         unchanged (6 users, 36 sessions, 457 sets, 24 session_exercises,
         9 programs, 9 gyms, 16 machines, 899 models, 23 photos, 29
         llm_calls); migrations 18 -> 19; column session_exercise_id uuid
         NULL, FK equipment_photos_session_exercise_id_fk ON DELETE SET
         NULL, index equipment_photos_session_exercise_idx; 0 of 23
         existing photos carry a block. Scratch DB dropped, dump deleted.
```

Deploy under development-push mode (quiet check suspended while there is no
tester account), `pre-0.6.0` kept until the owner signs off.

Check (assistant, production, `scratch-test@doclifts.invalid`, 390x844): start
a quick workout at "Scratch photo check gym"; Photo next machine with a
generated placard; the block appears as "Unidentified machine" before the read
ends; save a set on it; the read returns (the Use this card for a catalog
placard, or the quiet line); Use this names it and the set is unchanged
(psql); finish; Home has no "to name" line. The `photo_upload` line says
`"source":"workout"`.

**Owed by the owner, on the iPhone:** photo to first saved set under 3 seconds
on cellular, with the read still running (the spec's acceptance number).
