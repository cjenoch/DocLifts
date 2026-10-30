# Privacy activation and recovery

This runbook prepares 0.19.0 Alpha's explicit account/photo removal. It is not a
claim that a host is configured: use STATUS.md and the private release evidence.
Migrations 0022/0023 and the default-off app already passed a production-snapshot
restore rehearsal before build `5b6f9e3` was deployed. No real account was deleted.

## Durability boundary

A valid request commits its local intent/access fence in a short transaction.
The broker must then acknowledge a verified encrypted off-host record before the
app reports acceptance or a worker erases data. Failure returns an unfinished,
possibly recorded request; cleanup remains pending. The worker retries the same
intent. Local files and restored caches are never sufficient proof.

The broker is reachable only through a private Unix socket, checks peer UID,
bounds input/concurrency/time, and keeps backup credentials outside web. It saves
one strict pseudonymous entry per encrypted restic snapshot, verifies it with
`restic dump`, and acknowledges the exact entry. Entries contain no account email,
raw account/photo IDs, object keys, or training data.

Dedicated snapshots use `doclifts-deletion-ledger-v1`, never `complete`. Current
ordinary backup pruning is filtered by its configured host and `complete` tag.
Keep those filters: a repository-wide forget command could destroy deletion
history. A disposable local encrypted-repository test proves ordinary pruning
preserves journal entries; it does not authorize running live prune tests.

Recovery unions every dedicated journal snapshot, deduplicating by kind and
subject hash. Never substitute a journal from the old snapshot being restored.
No journal pruning is automated. Retain entries until every older restorable copy
has expired plus the reviewed recovery margin; the normal last-three-snapshots
floor means there is no universal six-month upper bound. Restic encryption does
not make this repository immutable: a compromised host administrator or storage
provider can still remove its contents. Preserve recovery credentials and enforce
provider access controls independently.

## Install in stages

1. Keep `PRIVACY_DELETION_ENABLED=0`; confirm exact-head CI/local evidence and a
   verified backup. Retain at least two previous application images. Apply the
   lifecycle migrations only after rehearsing them against an isolated restore.
2. Copy `journal.py` and `worker.py` into a root-owned immutable installation
   directory named for the full reviewed commit. The `.example` units deliberately
   contain `REVIEWED_COMMIT`; replace it before installation. They are templates,
   not an installer. Verify Node/image dependencies and host restic separately.
3. Use the existing protected backup config for the broker. Create its private
   state directory and a socket directory traversable by group 1000. The example
   broker unit creates `/run/doclifts-privacy-journal` as root:1000 mode 0750 and
   a mode-0660 socket. Preserve the runtime directory across broker restarts so
   web does not retain a bind mount of an unlinked directory. Inspect local
   cache/config paths before using its sandbox.
4. Build `--target privacy-worker --build-arg DOCLIFTS_BUILD_SHA=FULL_COMMIT`, pin its
   immutable Docker image ID, and retain that image. The worker checks both its
   ID and full source stamp. Its direct Node/tsx command needs no runtime install.
5. Prepare a root-owned mode-0600 worker environment containing exactly
   `DATABASE_URL`, `PHOTO_STORE=s3`, and the five `S3_*` configuration keys used by
   the app. Never give it auth, model or email-provider credentials. Create a
   protected JSON config from `worker-config.json.example`, with the pinned image,
   full commit, environment path, Docker network, socket directory and batch cap.
6. Start the broker and prove encrypted off-host append/read-back/recovery using
   a fictional random subject hash. Mount only its socket directory read-only into
   web using the override example through `scripts/compose-prod.sh`. Set
   `DELETION_LEDGER_SOCKET=/run/doclifts-privacy-journal/journal.sock`; no live path
   falls back to `DELETION_LEDGER_PATH`. Preserve the override on future deploys.
7. Verify S3 listing and exact erasure with disposable keys. The actual October 24
   bucket had versioning never enabled: live checks exercised null-version
   listing/delete/absence. Historical versions/delete markers are covered by
   fixtures; this is not a claim that they were present in production. Do not
   change global bucket versioning just to run this test.
8. Run the pinned worker in dry-run, then rehearse the complete flow and recovery
   below. Start bounded retry monitoring, then enable the UI and complete a
   disposable public-browser check. Record deployed/acceptance-pending status.

The worker template retries every minute after the previous run completes and
has a bounded per-run deadline. Overlapping runs of the same unit are prevented
by systemd. Inspect `systemctl status`, timer last/next run, and journal counts;
failures return nonzero and jobs retain a safe stage code. Wire the host's approved
alerting channel to failed runs and excessive pending age before calling this
unattended operation. A timer being enabled alone is not proof of monitoring.
Do not log raw provider errors, environment contents or account identifiers.

## Recovery rehearsal and final disposable verification

First rehearse in isolation before enabling removal for normal use, then repeat
the public UI check with a disposable account after activation. Use a newly
created disposable account and generated, non-personal images. Save
an isolated pre-deletion database snapshot. Remove a saved photo through the UI
and verify its lifting records survive; then remove the account using the current
password. Confirm session/agent revocation, completed receipt, absent database
rows and absent object versions. Check unrelated account totals remain unchanged.

Keep restored ingress and old writers stopped. Recover the journal into a **new**
absolute file; the recovery command refuses overwriting old evidence:

```sh
python3 journal.py recover --backup-config /private/backup-config.json --output /private/recovery/newest.jsonl
python3 worker.py --config /private/isolated-worker.json --recover-ledger /private/recovery/newest.jsonl --offline-confirmed
python3 worker.py --config /private/isolated-worker.json --recover-ledger /private/recovery/newest.jsonl --offline-confirmed --apply
```

The broker writes recovered JSONL as root mode 0600. For the uid-1000 worker,
provide a private traversable parent and root:1000 mode 0640 on that file; mount
it read-only. Do not make it world-readable. Use an isolated worker config and
isolated credentials/object copies, never the live object store for a restore
drill. The wrapper deliberately requires S3; a memory-store fixture rehearsal
uses the pinned direct CLI instead, with no live S3 credentials. Run cleanup until no pending/failed fixture jobs remain. Reconcile again
and verify idempotence, refusal of old sessions/tokens, and unrelated fixtures.
Only then allow ingress to a restored service. Delete temporary restore payloads
once redacted evidence is saved.

## Retention controls

The scheduled worker handles explicit deletion jobs only. Retention stays manual,
dry-run first, with the reviewed proposed defaults: diagnostic details 30 days,
unreferenced usage 90 days, expired-auth grace 7 days, discarded objects 30 days.
Invoke the pinned direct-node CLI with explicit flags and minimal protected
configuration; `--apply` additionally requires the durable broker. No saved-photo,
workout, import or note age purge is included. Operational-log retention is a
separate host policy. See [the inventory](data-lifecycle.md).
