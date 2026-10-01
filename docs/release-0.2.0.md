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
password   P@ssw0rdDL26!
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
`pwLen` 13 = `P@ssw0rdDL26!`, no edge whitespace. Same device, same account,
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

## 16. 0.2.4 — account management and password policy

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

## 17. 0.2.5 — login delay notice

**NOT deployed.** Branch `feat/0.2.5-throttle-notice`; no step below has been
run. No migration, no new env key, no compose change. Spec:
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

## 18. 0.3.0 — equipment catalog

**NOT deployed.** Built on branch `feat/0.3.0-catalog` from `main` at 0.2.4
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
