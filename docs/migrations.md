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
single transaction. Production is at migration 8 of 8 until then; 0009–0011
have never been applied to it.

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
