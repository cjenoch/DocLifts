# Account deletion and retention controls

Lifecycle schema and application were deployed as build `5b6f9e3`, with controls
disabled. This follow-up adds durable off-host acceptance and reviewed operator
templates; installation does not happen merely by merging it. See
[activation and recovery](privacy-activation.md) and STATUS.md for actual rollout
state. Signup remains closed. Full data export is separate work.

## What the controls do

On a 390 px phone, Account shows the consequences before the destructive form.
Activation exposes a current-password field, the exact confirmation `DELETE`, and
an unchecked acknowledgment. Verification goes through Better Auth's origin-checked,
rate-limited handler (five password checks per minute). The server derives the
account from the authenticated session and rechecks that session in the deletion
transaction. A posted user ID never selects the account.

A short transaction records the authorized deletion intent, revokes sessions,
OAuth access/refresh tokens, consent and associated authorization codes, then
fences the account. After committing, the request obtains verified off-host
journal acknowledgment before reporting acceptance. No database transaction is
held during this remote operation. Database triggers reject later inserts or updates
in owned records, including indirect program, exercise, gym and import children.
An already-running model call cannot repopulate the account. This cannot recall a
request or data already sent to a provider or agent.

The public privacy page can show this browser's deletion receipt, using a 30-day
HttpOnly cookie. It distinguishes pending, retry-needed and completed. Pending is
not success; an operator must run the worker. Repeated or stale sessions cannot
submit a second destructive request. Only minimal completion status is exposed by
the random receipt capability, never account details.

When activated, Discard also records the restore journal and uses the resumable
cleanup path. The legacy disabled-state Discard behavior remains available until
activation; earlier discards require support reconciliation on older restores.

A saved-photo review exposes a separate checked confirmation, including for
confirmed images. The image is hidden immediately, then its private object and
review row are removed. Machine identity, workout blocks, prescriptions, executed
sets and notes are unchanged. A storage failure leaves the image hidden and the
job pending. The linked model-call record is removed if no other photo references
it; earlier model-call diagnostics follow the retention policy below.

## Durable objects and failures

Migration `0022_open_johnny_blaze.sql` adds the account fence, deletion receipts,
object inventory and write-fencing triggers, and backfills every known photo key.
Migration `0023_salty_darkstar.sql` adds the durable upload settlement deadline.
Earlier migrations are unchanged. Global equipment catalog rows are untouched.

Uploads commit their object inventory **before** PUT. A separate PostgreSQL
connection pool (maximum two per process, not the web query pool) holds a session
advisory lock for the key while storing it. Cleanup uses the same try-lock and
reports contention as a retry. No database transaction spans object-store I/O.
S3 PUT and the complete version-erasure operation have 30-second abort deadlines.
A crashed process releases its session lock; its committed key remains discoverable.
An interrupted or ambiguous upload has a durable two-minute write window, longer
than its 30-second PUT deadline. A successful PUT clears the marker. For an
ambiguous PUT, **elapsed time alone never permits completion**: client cancellation
cannot prove that a remote provider has finished processing a write. The key stays
inventoried and deletion remains pending until an operator stops old writers,
verifies provider settlement, and explicitly acknowledges that bounded owner's
expired windows. DB connection loss cannot bypass this durable marker.

Account cleanup also lists the exact owner's storage prefix, including old
versions and delete markers, to find pre-migration orphan objects. Each pass is
bounded. S3 erasure removes exact-key versions and delete markers and verifies
absence; similarly prefixed keys are never deleted. Missing permissions, unsupported
version APIs, a legal hold, incomplete inventory or a provider failure leave the
job pending. No live S3 mutation is used in tests.

After every known object is removed and the owner's object prefix is empty, one
transaction deletes the owner's database tree in FK order and removes the account.
A failure rolls that transaction back. The raw pending owner ID is cleared from
the receipt on completion. A foreign reference fails safely rather than cascading
into another tenant. In particular, an owner-registered OAuth client with another
user's consent requires operator resolution; its grants are not silently removed.

## Retention inventory and proposed defaults

All durations below are **proposed defaults for explicit CLI runs**, not a claim
that a production timer is running. Every owner sweep has a fixed UTC clock,
strictly older-than cutoffs, a 1–100 row limit per category, counts and dry-run mode.

| Data                                                                                                   | Purpose / retained content                     | Policy and enforcement                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account and credentials                                                                                | Authentication                                 | Until explicit account deletion; pending access is blocked immediately                                                                                                                      |
| Programs, days, prescriptions, workouts, sets, pain records, notes, imports and draft-request receipts | Training history and provenance                | No age purge; explicit account deletion removes all owned rows                                                                                                                              |
| Gyms, machines, private models, merges, exercise mappings                                              | Equipment identity and history                 | No age purge; owner deletion only; global catalog remains                                                                                                                                   |
| Confirmed and unconfirmed saved photos, candidates                                                     | User-selected equipment record                 | No age purge; explicit photo/account removal; confirmed-photo removal preserves lifting records                                                                                             |
| Failed uploads, discarded objects and rows                                                             | Retryable cleanup                              | 30 days before retention cleanup; user-requested deletion is eligible immediately                                                                                                           |
| Model-call output, raw schema-error text, optional prompt text and error codes                         | Troubleshooting                                | Clear after 30 days; photo candidate copies remain with their saved photo                                                                                                                   |
| Model-call usage metadata                                                                              | Quotas and diagnostics                         | Remove after 90 days if no saved photo references the row; linked rows retain usage metadata until photo removal                                                                            |
| Sessions, access and refresh tokens                                                                    | Authentication / revocation                    | Expiry plus 7-day grace; revoke immediately at account-deletion acceptance                                                                                                                  |
| Authorization-code, verification and assertion records                                                 | Short-lived authentication handshakes          | Expiry plus 7-day grace; the `--all` sweep covers records with no surviving account                                                                                                         |
| OAuth client registration and active consent                                                           | Connection continuity                          | Active records retained; revocation/account deletion removes owned grants. Shared client registrations need separate reviewed maintenance                                                   |
| Photo acknowledgment                                                                                   | Current notice version/time                    | Until account deletion; not an immutable consent audit trail                                                                                                                                |
| Deletion receipts and independent journal                                                              | Prevent resurrection from backups              | Pending until resolved; completed hashes needed until all pre-request restorable copies expire, plus a proposed 30-day recovery margin. No automatic pruning until that horizon is verified |
| Browser drafts/preferences and cached external copies                                                  | Device-local convenience                       | User clears site data on each device; server deletion cannot remotely erase them                                                                                                            |
| Application stdout: sign-in/password, upload timing, safety, errors; system/Docker logs                | Abuse detection and operations                 | Proposed 30-day wall-clock cap, **not implemented by this DB tool**. Confirm rotation and host policy separately; a size cap is not a time guarantee                                        |
| Local database dumps                                                                                   | Recovery                                       | Existing backup tooling documents 30-day rotation; verify exceptional/manual copies separately                                                                                              |
| Encrypted off-host snapshots                                                                           | Recovery                                       | Verified policy: last 3 complete snapshots, 14 daily, 8 weekly, 6 monthly. The last-three floor can retain older snapshots if backups stop; no universal six-month deletion maximum         |
| OpenRouter/model-provider copies, agent exports                                                        | External processing or user-authorized sharing | Provider/agent policies apply; no promise of zero retention, no training, or remote recall                                                                                                  |
| Operator research/evaluation copies                                                                    | Separately consented private research          | Inventory and remove through the verified support process; not silently covered by an application-row deletion                                                                              |

## Operator commands

Supply an explicit `DATABASE_URL` securely in the environment. Never paste it into
logs or command examples. The default is dry-run. Choose exactly one of `--owner`
(the opaque account ID) or `--all`. Output contains counts/status, not account
content, keys, provider messages or database errors.

```sh
pnpm privacy --mode retention --all --limit 25
pnpm privacy --mode retention --owner ACCOUNT_ID --details-days 30 --records-days 90 --expired-auth-days 7 --discarded-days 30
pnpm privacy --mode retention --all --apply --limit 25
pnpm privacy --mode deletions --all --limit 25
pnpm privacy --mode deletions --all --apply --limit 25
```

Use `nextAfter` with `--after` to continue the account scan. Repeat bounded deletion
passes until no jobs remain; a failed batch exits nonzero, and `last_error` records
only the failing stage (`ledger`, `storage`, `database`). Expired authentication
parents remain while any child token references them; each pass removes only its
selected owner’s eligible rows, without cascades into live or foreign tokens. Alert on pending age,
retry failures and missing worker runs when scheduling is separately approved.
Use fictional fixtures for tests. The pinned deletion worker and optional
service templates are described in the activation runbook; no timer is installed
automatically. Live apply requires `DELETION_LEDGER_SOCKET`, with no local-file
fallback. `--ledger` is an input to offline reconciliation only.

Ambiguous uploads require a separate, deliberately explicit reconciliation. Stop
old writers and verify that the provider has settled requests before the selected
UTC timestamp. Dry-run first; apply requires an additional attestation and one
owner (never `--all`). This clears uncertainty markers, not objects or photo rows;
rerun normal deletion afterward. If provider settlement cannot be established,
leave the job pending.

```sh
pnpm privacy --mode settle-uploads --owner ACCOUNT_ID --settled-before UTC_TIMESTAMP
pnpm privacy --mode settle-uploads --owner ACCOUNT_ID --settled-before UTC_TIMESTAMP --confirm-provider-settled --apply
```

## Backups, journal and restore gate

An ordinary restored database or VPS file is **not** an independent deletion
ledger. The web app sends a strict version/kind/random-ID hash/request-time record
to a private Unix-socket broker. The broker writes a separate encrypted restic
snapshot and reads that exact entry back before acknowledging it. Backup
credentials never enter the web container. No emails, raw IDs, object keys or
workout information enter these journal entries.

The dedicated `doclifts-deletion-ledger-v1` snapshots never carry the ordinary
`complete` backup tag. Recovery unions **all** dedicated snapshots, not whichever
snapshot has the newest timestamp. Normal backup pruning must stay scoped to its
ordinary host and `complete` tag; inspect that filter after any backup change.
Journal pruning is intentionally not automated. See the activation runbook for
the protected broker, recovery command and retention limits.

Before any restored copy is returned to service:

1. Keep public ingress and all old writers stopped. Restore the application data
   into isolation, apply the lifecycle migration, and obtain the newest independent
   journal from outside the snapshot being restored. Never overwrite it with an
   older journal from that snapshot.
2. Inspect a dry run, then fence restored accounts and queue restored photo removal:

   ```sh
   pnpm privacy --mode reconcile --all --ledger /private/newest-deletions.jsonl
   pnpm privacy --mode reconcile --all --ledger /private/newest-deletions.jsonl --apply
   ```

3. Run bounded deletion batches against the restored private object store. Verify
   no pending/failed jobs or matching live accounts/photos remain, sessions and
   OAuth tokens are refused, and unrelated fictional fixtures survive. Repeat
   reconciliation as an idempotence check before enabling ingress.
4. Preserve the independent journal through future backups and restore drills.
   Prune completed receipts/journal entries only after verifying that **every**
   older restorable copy, including manual dumps and off-host snapshots, is gone,
   then waiting the reviewed recovery margin. This branch does not alter backup
   schedules or automatically prune that journal.

Ledger failure prevents normal acceptance and erasure. The authorized local
intent may already be committed, with access fenced or a photo hidden. The UI
reports ambiguity; the worker retries off-host durability before cleanup. A
timeout may also have persisted the remote entry, so recovery includes it. Never
tell the user that nothing changed after such a failure.

## Activation review

Keep `PRIVACY_DELETION_ENABLED` unset/`0` until the activation runbook passes:
reviewed migrations and exact-head tests, actual object-store permissions,
protected broker socket, independently recoverable journal, pinned worker,
monitored retries, and an isolated recovery rehearsal. Compose forwards
`DELETION_LEDGER_SOCKET` but does not silently mount a host directory. The
read-only web runtime only needs a read-only mount of the broker socket directory;
it does not receive a writable journal or backup credentials.

The production web image lacks the TypeScript CLI/tsx runtime. The worker uses an
immutable builder-image ID stamped with the full reviewed commit, runs direct
Node/tsx as uid 1000, drops capabilities, and receives only DB/storage/socket
configuration. Its default is dry-run. Recovery requires an explicit offline
attestation and a separately recovered journal file.

Retention remains a manual dry-run/apply control with explicit durations; the
deletion timer does not schedule retention or operational-log cleanup. Do not
widen signup based solely on these controls passing tests.

## Migration rehearsal

With an isolated loopback `TEST_DATABASE_URL` ending in `_test`, run
`pnpm exec node scripts/rehearse-privacy-migrations.mjs`. The test role needs
CREATEDB. The rehearsal creates its own random scratch database, migrates through
0021, seeds fictional saved/discarded photos, upgrades through 0023 and checks the
backfill and write/code fences. It drops only that scratch database in cleanup;
it never modifies the database named in the URL. No object-store calls occur.
