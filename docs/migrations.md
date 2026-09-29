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
