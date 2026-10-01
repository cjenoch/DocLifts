# Equipment catalog

Since 0.3.0, `equipment_models` holds a manufacturer catalog: 543 machine
models from 8 brands, browsable at `/equipment` and offered in the model picker
on `/gyms`. It is the index the photo feature will match against, joined on
`manufacturer` + `code`.

## Global rows are catalog data; owned rows are user data

`equipment_models` has two kinds of row, told apart by `owner_user_id`:

| `owner_user_id` | What it is                                                        | Who reads it   | Who writes it              |
| --------------- | ----------------------------------------------------------------- | -------------- | -------------------------- |
| `NULL`          | **Global** catalog row, from a dated snapshot                     | every user     | only `pnpm catalog:import` |
| a user's id     | **Owned** row: a model the user typed in, or their corrected copy | that user only | that user, through the app |

- Reads are `owner_user_id IS NULL OR owner_user_id = userId`, through one
  predicate, `modelVisibleTo(userId)` in `src/lib/server/catalog.ts`. Another
  user's owned row is a 404, the same as a missing id.
- Writes from the app only ever target owned rows: `owner_user_id = userId` is
  in the UPDATE's WHERE. A global row is never edited in place. "Numbers
  wrong? Create your own copy" on a model's page inserts an owned duplicate
  with the user's load fields and `confidence = 'user'`.
- The importer never reads or writes an owned row.

This is the one exception to "every row is owned" in `CLAUDE.md`, and it is
stated there. It does not extend to any other table: a `gym_equipment` row
pointing at a global model is still owned through its gym.

## Where the seed came from

`data/catalog/equipment_models_seed_2026-09-30.csv`, with its own
`data/catalog/README.md`. Built from manufacturer catalog pages fetched
2026-09-29/30, plus reseller listings and owner's manuals where a manufacturer
publishes no list. 543 rows: gym80 128, Matrix 83, Precor 66, Hammer Strength
64, Technogym 62, Life Fitness 61, Nautilus 43, Cybex 36. The files are kept
byte-for-byte as delivered (excluded from prettier).

## Confidence

Every row says how much to trust it:

| `confidence`         | Meaning                                                               | Badge                |
| -------------------- | --------------------------------------------------------------------- | -------------------- |
| `manufacturer_page`  | Name and code read from the manufacturer's own catalog page           | manufacturer         |
| `reseller_or_manual` | From a dealer listing, spec sheet, or owner's manual naming the model | reseller / manual    |
| `inferred`           | Filled from a naming convention or memory. **Check the placard.**     | unverified           |
| `line_only`          | A product line, noted but not enumerated into models                  | unverified           |
| `user`               | A row a user created (never a catalog row)                            | yours (to its owner) |

`source_url` is where the row was read from. It is null on `user` rows and on
most `inferred` rows. Six rows name their source in words ("reseller spec")
rather than a URL; they are stored as written and shown without a link.
`catalog_snapshot` is the catalog date; null on user rows.

## Column mapping

| CSV                                    | `equipment_models`             | Notes                                                    |
| -------------------------------------- | ------------------------------ | -------------------------------------------------------- |
| `manufacturer`, `product_line`, `name` | same                           |                                                          |
| `model_code`                           | `code`                         | the existing column; empty becomes NULL                  |
| `loading_type` `selectorized`          | `loading_type` `machine-stack` | the app's equipment types, which `createMachine` matches |
| `loading_type` `plate_loaded`          | `loading_type` `machine-plate` |                                                          |
| `loading_type` `cable_stack`           | `loading_type` `cable`         |                                                          |
| `laterality` `bilateral`/`independent` | same                           |                                                          |
| `laterality` `n/a`                     | `not_applicable`               | distinct from the column default `unknown`               |
| `body_region`                          | `body_region`                  | empty becomes NULL                                       |
| `starting_resistance_lb`               | `starting_resistance`          | with `starting_resistance_basis` (`total` / `per_arm`)   |
| `confidence`, `source`                 | `confidence`, `source_url`     |                                                          |
| `catalog_snapshot`                     | `catalog_snapshot`             |                                                          |
| `notes`                                | `notes`                        | since 0.3.2 (migration 0014); empty becomes NULL         |
| `replaces_code` (optional, last)       | — (not stored)                 | steers the match; see "A corrected code" below           |

**Not imported, on purpose**, and listed in every import report so nothing is
dropped silently:

- `stack_lb` / `stack_note` (26 rows). Stack size belongs to a gym's instance,
  `gym_equipment.stack_lb`, because manufacturers sell heavier optional stacks
  under the same code. Enter it when adding the machine to a gym.
- `starting_resistance_kg`. Derived from the lb value.

`notes` (298 rows) was in this list until 0.3.2; it is now imported into
`equipment_models.notes`, and the report counts the rows that carry one as
`(kept) notes`. The importer requires the column, so a CSV without it is
refused rather than clearing every note.

## The importer

```bash
pnpm catalog:import data/catalog/equipment_models_seed_2026-09-30.csv --dry-run
pnpm catalog:import data/catalog/equipment_models_seed_2026-09-30.csv
```

`scripts/catalog-import.ts` builds its own database client from
`DATABASE_URL` (like `seed.ts`; no app singleton, no `$env`) and calls
`importCatalog()` in `src/lib/server/catalog-import.ts`.

- **Every row is validated first.** An unknown `loading_type`, `laterality`,
  `body_region` or `confidence`, a resistance with no basis, a bad date, or two
  rows with the same key, and the run stops before writing anything and exits 1.
- **Upsert key:** `(manufacturer, code)` when the code is non-empty, else
  `(manufacturer, product_line, name)`. Codeless rows (210 of the 543, e.g.
  all of Life Fitness Insignia and Signature Series) have no database
  constraint; the importer is their only dedupe. Coded global rows are protected by the partial unique index
  `equipment_models_catalog_code_unique`.
- **On a match**, only the catalog columns change (`name`, `product_line`,
  `loading_type`, `laterality`, `body_region`, `starting_resistance*`,
  `confidence`, `source_url`, `catalog_snapshot`, `notes`). `owner_user_id` is never
  touched, and a row with an owner is never matched.
- **A code added to a codeless model is a promotion, not a new row** (since
  0.3.2). When a CSV row has a code and no global row has that
  `(manufacturer, code)`, the importer looks for a global **codeless** row
  with the same `(manufacturer, product_line, name)`. Exactly one: that row is
  updated in place — it gains the code, and the catalog columns change as on a
  match — so its id, and every `gym_equipment` row pointing at it, stay put.
  It is counted in the `promoted` column and listed as
  `promote line N <manufacturer> <name>: codeless row gains code <code>, kept in place (<columns>)`.
  More than one: the row is skipped as ambiguous and the run fails without
  writing. Two CSV rows claiming the same codeless row (two codes for one
  name, or the name both with and without a code) fail the same way. Owned
  rows are never candidates. After the promotion the row matches on its code,
  so the next run reports it `unchanged`.
- **A corrected code is a recode, not a new row** (since 0.3.2). The optional
  last column `replaces_code` names the code a model was listed under in an
  earlier snapshot, when the manufacturer's code has since been corrected
  (Hammer Strength `IL-DY` → `IL-DRW`). For such a row, when no global row has
  the new `(manufacturer, model_code)` and exactly one has
  `(manufacturer, replaces_code)`, that row is updated in place: the new code,
  the name and the catalog columns. Its id and its `gym_equipment` links stay.
  Counted in the `recoded` column and listed as
  `recode line N <manufacturer> <old> -> <new>: kept in place (<columns>)`.
  Global rows under **both** codes: the row is skipped as a conflict and the
  run fails. Neither: the row imports as any other (insert, or a promotion).
  A row that still lists the old code beside the row replacing it fails the
  same way. Refused at validation: `replaces_code` without a `model_code`,
  equal to the row's own code, or the same old code replaced by two rows.
  The column is optional: a CSV without it (the 2026-09-30 snapshot) imports
  exactly as before. After a recode the old code is gone and the new one
  matches, so the next run reports `unchanged`. Owned rows are never
  candidates.
- **Ambiguous match** (a key matching two existing global rows): reported as
  skipped, and the run fails without writing.
- **Idempotent:** a second run reports 0 inserted, 0 updated, 0 promoted,
  0 recoded.
- Global rows that are not in the CSV are left as they are, and counted.
- The run holds `SHARE ROW EXCLUSIVE` on the table for its transaction, so two
  imports cannot interleave; app reads are not blocked.

### Re-running with a newer snapshot

1. Add the new CSV beside the old one (`equipment_models_seed_<date>.csv`) with
   the same columns, and update `data/catalog/README.md`.
2. `pnpm catalog:import <new csv> --dry-run` locally against a restore of the
   production dump. Read the `update` lines: each names the columns that change.
3. Commit, then in production `scripts/catalog-prod.sh <new csv>`: verified
   dump, dry run printed, real run only when you type `IMPORT`.

A code added to a model that had none is a promotion (above): same row, now
with the code. A code **corrected** between snapshots is a recode when the new
CSV says so in `replaces_code`: same row, new code. Without `replaces_code` a
changed code imports as a **new** row and the old row stays, since a user's
machine may point at it. Models dropped from a catalog stay too.

### Production

`scripts/catalog-prod.sh <csv>` mirrors `migrate-prod.sh`: a verified
pre-import `pg_dump`, the builder image on the Compose network, `DATABASE_URL`
built from `POSTGRES_PASSWORD`, the dry run first and printed, then the real run
only on typed confirmation. It needs the owner's explicit "go", like every
`*-prod.sh`.

Narrow undo of an import (the full undo is the pre-import dump):

```sql
delete from equipment_models
where owner_user_id is null and catalog_snapshot = '2026-09-30'
  and id not in (select equipment_model_id from gym_equipment where equipment_model_id is not null)
  and id not in (select equipment_model_id from exercise_equipment_map);
```

## In the app

- `/equipment`: GET-form filters (manufacturer, then product line as a second
  step; loading type; body region; `q` against name and code), 50 per page.
- `/equipment/[id]`: every field including the catalog's notes, your gyms
  that have one, and "add to a gym" (gym, optional local label, optional stack
  and increment in lb). A blank label stores `<manufacturer> <name>` plus
  ` (<code>)` when there is one, e.g. "Hammer Strength Iso-Lateral Row
  (IL-ROW)"; the field's placeholder shows it.
- `/equipment/[id]/edit`: your own model's starting resistance, basis and
  laterality; or, on a catalog row, "create my own copy" (it carries the
  notes).
- `/gyms`: the known-model picker shows the models of manufacturers already in
  the selected gym, with "Show all manufacturers" and a search box. The label
  is optional there too when a model is chosen or typed in; with no model it
  is required. Each machine has an **Edit** link
  (`/gyms/[gymId]/machines/[id]/edit`): label, stack and increment; a blank
  label falls back the same way.

## Known data questions

Recorded at import, for the owner to decide; the importer stores them as
written:

- 210 of 543 rows have no model code, so they cannot be matched by
  `manufacturer + code` (the photo feature's join key) until a placard
  supplies one.
- Hammer Strength `IL-IP (IL-IPV vertical grip)` carries a parenthetical in the
  code column, so its join key is that whole string, not `IL-IP`.
- 8 `inferred` Hammer Strength MTS rows cite a Life Fitness catalog URL (Hammer
  Strength is a Life Fitness brand), so they have a source despite `inferred`.
- 8 `line_only` rows are product lines, not models (e.g. Cybex VR1, Technogym
  Biostrength). They are imported and badged "unverified"; Biostrength is
  motorized and has no matching loading type. The Cybex VR1 lines are marked
  `plate_loaded` in the CSV.
