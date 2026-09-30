# Release 0.2.0 — runbook

**Executed by Chris with Hermes present.** Every step has a command (or an
observation) and an expected value, plus an abort condition. No step says "check
that it works."

**Read this first, because it will look like a bug.** After bootstrap,
`/history` shows **29** sessions, not 30. That is correct. Production holds 30
session rows, one of which is soft-deleted, and `/history` filters
`deleted_at IS NULL`. The visible total is 29 across four months
(2026-05: 10, 2026-06: 13, 2026-07: 3, 2026-09: 3). **Do not raise an alarm
about 29.** The verification in step 8 checks the per-month sums against these
numbers, not against 30.

**Production is at migration 8 of 11.** This release applies 0008, 0009, 0010
and 0011 in a single transaction.

**The `Secure` cookie and the Tailscale Serve check need a real browser on the
tailnet.** Not a phone on cellular, not a machine off the tailnet.

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

**Verify — counts match the pre-migration values exactly:**

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

Expected:

```
programs                4
gyms                    2
exercises              52
sessions               30
sets                  435
pain_events             0
workout_log_imports     1
program_draft_requests  1
auth.user                1
auth.account             0
```

**`auth.account` is 0 here and that is correct** — it becomes 1 in step 5, after
bootstrap.

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
3. **Verify `/history` shows 29 sessions**, and check the per-month counts:

   | month     | expected |
   | --------- | -------- |
   | 2026-05   | 10       |
   | 2026-06   | 13       |
   | 2026-07   | 3        |
   | 2026-09   | 3        |
   | **total** | **29**   |

   `/history` is a single-month view — it shows one month at a time, so step
   through all four. **29, not 30** (see the top of this document).

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
