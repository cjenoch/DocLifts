# Migrations

Operational notes for the `drizzle/` chain. This file outlives the accounts
phase; add to it when a migration teaches us something the next person needs.

The rules themselves live in `CLAUDE.md` under **Migrations**. This file holds
the specifics those rules point at.

## How the migrator actually behaves

`drizzle-orm@0.45.2`, `pg-core/dialect.js`:

```js
await session.transaction(async (tx) => {
	for await (const migration of migrations) {
		if (!lastDbMigration || Number(lastDbMigration.created_at) < migration.folderMillis) {
			for (const stmt of migration.sql) await tx.execute(sql.raw(stmt));
			await tx.execute(sql`insert into ${migrationsSchema}.${migrationsTable} ...`);
		}
	}
});
```

Two consequences worth remembering:

- **One transaction wraps ALL pending migrations**, not one per file, and the
  marker row is written inside it. A partially-applied migration is not
  possible; either the whole pending chain lands or none of it does. This is
  why the release can apply 0008–0010 in a single `db:migrate` call and rely
  on the auth schema rolling back with a failed backfill.
- **The "already applied" test looks only at the most recent applied row**
  (`order by created_at desc limit 1`), comparing its `created_at` against
  each file's timestamp. A renumbered or back-dated file is silently skipped
  rather than rejected. This is why applied migrations are append-only.

## What the migrator reads from the environment

`scripts/migrate-prod.sh` passes **only `DATABASE_URL`** into the migration
container (`docker run --rm --network doclifts_default -e DATABASE_URL … pnpm
db:migrate`). It used to pass the whole production env file with `--env-file`
plus an explicit `BETTER_AUTH_SECRET`, which handed the container the S3 keys,
the OpenRouter key and the auth secret — none of which any part of a migration
reads:

- `drizzle.config.ts` reads `DATABASE_URL` and loads `dotenv/config`, which is a
  no-op in the container (`.env` is dockerignored).
- `src/lib/server/db/schema.ts` is table definitions; it reads no environment.

Adding a second variable is a change to argue for with the import that reads it,
and `src/lib/server/migrate-prod.test.ts` asserts the argv: one `-e`,
`DATABASE_URL`, no `--env-file`, and none of those secret names present.

The wrapper reads the env file itself for `POSTGRES_PASSWORD` and builds the
URL; the value stays in the shell, never in a command line, so it does not
appear in `ps` or in the recorded argv.

The pre-migrate dump is written to a hidden temp file (mode 0600, `umask 077`),
verified with `pg_restore --list` under that temp name, and only then renamed to
`predeploy-<stamp>.dump`. A refused run — dump failure, failed verification, or
a failed migration — keeps every earlier dump and prunes nothing; the prune runs
only after a successful migration.

## Known constraint-name mismatches

The Drizzle snapshot records constraint names it _believes_ Postgres has. When
a table was created by hand-written SQL rather than by `drizzle-kit generate`,
the two can disagree — and a later `DROP CONSTRAINT` then fails on a
constraint that does not exist.

Found by diffing `pg_constraint` against `drizzle/meta/0009_snapshot.json`
against production. Three known:

| Table                    | Postgres name                                                     | Snapshot name                                                      | Cause                                                                                                       | Handled?                                   |
| ------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `workout_log_imports`    | `workout_log_imports_source_sha256_key`                           | `..._source_sha256_unique`                                         | 0007 declared the column as inline `"source_sha256" text NOT NULL UNIQUE`, so Postgres auto-named it `_key` | 0009 drops **both** names with `IF EXISTS` |
| `imported_workouts`      | `imported_workouts_import_id_fkey`                                | `imported_workouts_import_id_workout_log_imports_id_fk`            | 0007 relied on Postgres's default `_fkey` name                                                              | **not yet handled** — see below            |
| `exercise_equipment_map` | `exercise_equipment_map_equipment_model_id_equipment_models_id_f` | `exercise_equipment_map_equipment_model_id_equipment_models_id_fk` | the generated name is 64 bytes; Postgres truncates at 63 and drizzle-kit does not check                     | **not yet handled** — see below            |

For the two unhandled ones: the migration that eventually alters or drops that
constraint must use `DROP CONSTRAINT IF EXISTS` under **both** names, in the
migration that needs it. **Never edit 0007 or its snapshot** — 0007 is applied
in production, and rule 2 above is the reason.

`exercises_name_unique` was _not_ flagged: the name matches in both places, so
0010's generated drop of it will work as emitted.

## Verifying a migration

Rule 3 in `CLAUDE.md` exists because two of the three defects in the 0009 round
were invisible in the SQL and visible only in the applied database. The
procedure:

```bash
# 1. Fresh copy of production
docker exec doclifts-test-db psql -U doclifts -d postgres \
  -c "DROP DATABASE IF EXISTS doclifts_scratch;"
docker exec doclifts-test-db psql -U doclifts -d postgres \
  -c "CREATE DATABASE doclifts_scratch;"
docker exec doclifts-db pg_dump -U doclifts -d doclifts --clean --if-exists \
  | docker exec -i doclifts-test-db psql -U doclifts -d doclifts_scratch

# 2. Apply the full chain
DATABASE_URL=postgresql://...@127.0.0.1:5432/doclifts_scratch pnpm db:migrate

# 3. Check constraints BY NAME, and row counts against the baseline
docker exec doclifts-test-db psql -U doclifts -d doclifts_scratch -c \
  "select conrelid::regclass, conname from pg_constraint
   where connamespace='public'::regnamespace and contype in ('u','f') order by 1,2;"
```

Row-count baseline at the time 0008/0009 were written: programs 4, gyms 2,
exercises 52, sessions 30, sets 435, pain*events 0, workout_log_imports 1,
program_draft_requests 1. These are production's numbers and will drift; the
point of the check is \_unchanged by the migration*, not equal to a constant.

## `drizzle-kit check` needs `DATABASE_URL`

It exits 0 silently when the variable is unset, so an unqualified local run
reads as a pass that never happened. It runs in `ci.yml` (after `pnpm run
check`, where the Postgres service URL is already exported) so the snapshot
chain is checked on every push. Locally, pass `DATABASE_URL` explicitly.

## The ownership migration chain

| Migration                     | Contents                                                                                        | Reversible?                        |
| ----------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------- |
| `0008_auth_schema.sql`        | `CREATE SCHEMA "auth"` + Better Auth's four tables                                              | yes — `DROP SCHEMA "auth" CASCADE` |
| `0009_ownership.sql`          | `user_id` on the eight scoped tables, nullable `owner_user_id` on `equipment_models`            | yes — purely additive              |
| `0010_ownership_not_null.sql` | sentinel insert, eight backfills, eight `SET NOT NULL`, `DROP CONSTRAINT exercises_name_unique` | **no** — the irreversible step     |

0009 keeps the global `UNIQUE(exercises.name)` deliberately:
`program-builder.ts` quick-add does `onConflictDoNothing({ target: exercises.name })`,
which throws at runtime unless the global unique exists. 0010 drops it once T3
has rewritten that call site.

## Restoring from a pre-migrate dump

`scripts/migrate-prod.sh` takes a custom-format dump to
`/srv/doclifts/backups/predeploy-<timestamp>.dump` (mode 600) before applying
anything, and refuses to migrate if the dump fails or will not parse. It keeps
the newest 14.

Restore is **manual and deliberate**, not automatic:

```sh
docker exec -i doclifts-db pg_restore --clean --if-exists --no-owner --no-privileges \
  -U doclifts -d doclifts < /srv/doclifts/backups/predeploy-<timestamp>.dump
```

**`--clean` only drops objects that are present in the dump.** Anything a
migration _created_ is not in the dump, so it survives the restore and must be
dropped explicitly. For the ownership chain that means:

```sql
-- Revert 0009 + 0008. Order matters: drop the FKs before the columns.
DROP SCHEMA IF EXISTS auth CASCADE;   -- 0008, and the 0009 FKs with it
```

`DROP SCHEMA ... CASCADE` removes the nine `user_id` / `owner_user_id`
constraints and columns with it, because they depend on `auth."user"`. The
`workout_log_imports` and `exercises` unique constraints created by 0009 also go
with their columns, but **the global uniques 0009 dropped do not come back** —
re-add them if the pre-0009 shape is required:

```sql
ALTER TABLE exercises ADD CONSTRAINT exercises_name_unique UNIQUE (name);
ALTER TABLE workout_log_imports
  ADD CONSTRAINT workout_log_imports_source_sha256_unique UNIQUE (source_sha256);
```

0010 does not exist yet. When it does, its revert is **not** a restore: the
backfill is lossy (every row points at the sentinel), so reverting 0010 means
restoring a dump taken before it.

Automated rollback is deliberately absent. Rolling back the database without
rolling back the web image leaves the two on different schemas, and image
orchestration is a separate concern from this script.

## 0011 — ownership NOT NULL

`0008` (auth schema) → `0009` (user_id columns) → `0010` (drop
`exercises_name_unique`, add `exercises_user_id_name_unique`) → `0011` are
applied to production in ONE `db:migrate` call at release, which runs as a
single transaction.

**Applied to production on 2026-09-30, as release 0.2.0** (`scripts/migrate-prod.sh`,
one transaction, dump written and verified first). Verified immediately after:

- all eight `user_id` columns report `is_nullable = NO`;
- zero rows with a null `user_id` and zero rows owned by any id other than the
  sentinel, across all eight tables;
- every table's row count identical to the baseline captured immediately before
  the migration (programs 4, gyms 2, exercises 52, sessions 31, sets 454,
  pain_events 0, workout_log_imports 1, program_draft_requests 1);
- `drizzle.__drizzle_migrations` 8 → 12.

The sentinel was then claimed by bootstrap, so `auth."user"` now holds
`chris@enoch.ai` rather than `owner@localhost`, with one `credential` account
row. **The id did not change** — bootstrap claims the existing row rather than
inserting a new user, which is what keeps every backfilled row attached.

Since 2026-11-08 the claim is one transaction (`claimSentinel` in
`src/lib/server/bootstrap.ts`): the email/name update, the credential row and
the starter exercises commit together or not at all, so a failed bootstrap
leaves the sentinel exactly as 0011 wrote it and a re-run is safe. Bootstrap
refuses, exiting 1, once the sentinel has a credential row; a password change
after that is `pnpm user:set-password`. A sentinel with a real email and no
credential row (only the earlier three-statement claim could leave one) is
still claimable, and the startup warning names it as an interrupted bootstrap.
"Unclaimed" in the revert note below means: email `owner@localhost` and no
`auth."account"` row for the sentinel.

0011 sets the eight `user_id` columns NOT NULL. Order inside the file matters
and is hand-written, because the generated content alone is insufficient: on a
database with rows, `SET NOT NULL` fails on the first unowned row. So 0011
inserts a sentinel into `auth."user"`, backfills eight tables, then alters.

The sentinel is `00000000-0000-4000-8000-000000000001` / `owner@localhost`,
`email_verified false`, and deliberately has NO row in `auth."account"` — so it
is not an account anybody can sign in as. It is not a multi-user abstraction;
it is the mechanism that gives pre-existing rows an owner, which
`pnpm user:bootstrap` then claims for a real account at release. It is skipped
entirely when all eight tables are empty, so a fresh install gets no litter.

**Revert.** 0011 is reversible only while the sentinel is unclaimed. If
`user:bootstrap` has already run, the correct action is to LEAVE the NOT NULL in
place — the data is owned and correct, and dropping the constraint reopens the
silent-unowned-insert hole that 0009–0011 exist to close.

```sql
-- Only if the sentinel is still unclaimed.
DELETE FROM "auth"."user" WHERE id = '00000000-0000-4000-8000-000000000001';
ALTER TABLE programs ALTER COLUMN "user_id" DROP NOT NULL;  -- and the other 7
UPDATE programs SET user_id = NULL WHERE user_id = '00000000-0000-4000-8000-000000000001';
```

**Verified by applying, not by reading** (the CLAUDE.md rule-3 rule, and the
reason 0011 is correct): the full pending chain 0008→0011 applied to a fresh
restore of `pg_dump` of production, then per table `count(*)` and
`count(*) WHERE user_id = <sentinel>` compared against the pre-migration
baseline. All eight matched. This caught a defect no amount of reading would
have: the sentinel's own guard was written `WHERE NOT EXISTS (...)` when it
needed `WHERE EXISTS (...)`, so on production — which has 4 programs — the
sentinel was never created and the very next statement failed the `programs`
foreign key. The inversion is recorded in the file itself.

**Out of band.** `workout_log_imports` and `imported_workouts` have no write
path in the application; whatever loads the archive does so outside the
codebase. After 0011 that load MUST set `user_id` or the insert is rejected.
That sentence is the only protection the archive path has.

## 0024 — narrow the pending-photo write fence

`0024_privacy_fence_unlink.sql` is custom SQL (`drizzle-kit generate --custom`):
no schema change, so `0024_snapshot.json` is 0023's with a new id. It is one
`CREATE OR REPLACE FUNCTION public.privacy_write_fence()`, 0022's body except the
`equipment_photos` pending branch, which now allows an UPDATE whose only changes
are `session_exercise_id` and/or `gym_equipment_id` becoming null. The reason is
a foreign-key action: `ON DELETE SET NULL` on `session_exercise_id` (0018) is an
UPDATE the `BEFORE UPDATE` trigger sees, so 0022 made removing a block, and
permanently deleting a trashed workout (cascade sessions → session_exercises),
fail after the block's photo was discarded. `CREATE OR REPLACE` keeps the
function's OID, so 0022's triggers are untouched and nothing new is named.

Verify after applying (rule 3): `\df+ privacy_write_fence` shows the new branch;
on a pending photo, setting either link to null succeeds while a status change
is refused (23514 `Photo removal pending`); on a fenced account the unlink is
refused (23514 `Account unavailable`); row counts are unchanged.
Revert: rerun 0022's `CREATE FUNCTION` body as `CREATE OR REPLACE` (no data
changes to undo).

## 0025 — one credential row per account

`0025_account_unique_privacy_claim_tz.sql` (generated, then hand-ordered):

- **`auth_account_provider_account_unique`**: a unique index on
  `auth.account (provider_id, account_id)`. It replaces the plain
  `auth_account_provider_pair_idx` on the same columns (dropped). Before it,
  nothing stopped a second credential row for one user, although two comments
  said something did.
- **`privacy_deletions_completed_no_error_check`**: `completed_at IS NULL OR
last_error IS NULL`. The migration first clears `last_error` on every
  completed job (`deletionJobState()` already let completion win, so no reader
  changes).
- **`privacy_deletions.claimed_until`** (timestamptz, nullable, no default): a
  deletion job's claim expiry, written only by `privacy/lifecycle.ts`.
- **`auth.user.time_zone`** (text, nullable; an IANA name, NULL = UTC) with
  **`auth_user_time_zone_length_check`** (NULL or 1 to 64 characters). It is
  not a Better Auth field: Better Auth's update-user endpoint drops it, and only
  DocLifts server code writes it.

**Duplicates stop it.** The unique index cannot be built over existing
duplicate pairs, and the migration never chooses which credential to delete. A
`DO` block counts them first and raises
`0025 refused: auth.account has N (provider_id, account_id) pair(s) held by M rows`
(SQLSTATE 23505). The migrator runs the chain in one transaction, so nothing
from 0025 is applied and the database is as 0024 left it.

**Preflight, on a restore of the nightly dump (never production):**

```bash
psql -X -v ON_ERROR_STOP=1 -d doclifts_scratch -f scripts/auth-account-duplicates.sql
```

It is read-only (`BEGIN TRANSACTION READ ONLY` … `ROLLBACK`) and prints a count,
then each duplicate row's id, user id, timestamps and whether it has a password.
It never prints a hash, a token or an email. Zero pairs: run the full chain on
the restore, then `migrate-prod.sh`.

**If it finds rows**, stop and report them to the owner; do not migrate. The
only expected case is `provider_id = 'credential'` with `account_id = user_id`:
one user with two password rows, from a pre-0025 double claim or create. Sign-in
reads whichever row comes first, so which password works is undefined. The fix,
with the owner's go, on production after a verified dump:

1. `scripts/user-prod.sh set-password --email <that user> --password-stdin`,
   the password from the owner's own shell. `updatePassword` writes every credential row of the user,
   so the duplicates now hold the same hash.
2. Delete all but the most recently updated row of that pair, by row id, in one
   transaction that first re-checks the pair still has exactly the rows the
   preflight listed.
3. Rerun the preflight on a fresh dump: zero pairs. Then migrate.

Any other provider in the list is not a known path in this app: report it and
leave it alone.

Verify after applying (rule 3): `\d auth.account` shows
`auth_account_provider_account_unique` and no `auth_account_provider_pair_idx`;
`pg_constraint` lists both CHECKs by name; `select count(*) from
privacy_deletions where completed_at is not null and last_error is not null` is 0;
`\d privacy_deletions` and `\d auth.user` show the two new nullable columns;
row counts are unchanged.
Revert (no data to restore except the cleared `last_error` text on completed
jobs, which no reader used): drop the two CHECKs and the two columns, drop the
unique index and recreate `auth_account_provider_pair_idx`.

## Later

Not scheduled. Recorded so the reasoning survives the end of the ownership work.

- **The import archive is populated out of band, and after 0011 that has a
  hard requirement.** `workout_log_imports` and `imported_workouts` have no
  write path in the application: the only inserts into either table anywhere
  in the tree are three in `src/routes/imported-history/page.server.test.ts`.
  Whatever loads the archive does so outside the codebase. After 0011 sets
  `workout_log_imports.user_id` NOT NULL, any out-of-band load **must** set
  `user_id` or the insert is rejected outright. There is no application code
  to update, which makes that sentence the only protection the archive path
  has — a future loader that omits the column fails loudly at the database
  rather than writing an unowned row, which is the intended outcome.
- **`program_draft_requests` should key on `(user_id, request_id)`, not
  `request_id` alone.** `request_id` is a global primary key, so a colliding id
  from a second user falls through to the insert and surfaces a raw PostgreSQL 23505. The current handling hashes `userId` into the fingerprint and keeps the
  lookup global, which turns a cross-user collision into the existing "different
  request" refusal with no `program_id` leak. The residual oracle — a second user
  learns that a random UUID is taken — is negligible for client-generated UUIDs.
  The composite key is the cleaner shape but needs a primary-key migration.
- **A branded `UserId` type, to catch the adjacent-parameter swap.**
  `(db, userId, sessionId)` are adjacent `string` parameters, so TypeScript
  cannot catch a caller that passes A's id where B's belongs. This is not
  hypothetical: three such swaps in `machines.db.test.ts` were caught only by the
  not-found rule turning them into test failures. A branded type would catch them
  at compile time, but it is a sweep across every signature in the ownership
  surface. Until then the cross-tenant tests are the detector.
