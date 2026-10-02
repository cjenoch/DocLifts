# Private data directory

Some data stays out of this public repository: researched catalog snapshots
and their research logs, prompt and model evaluations, and photos the vision
model got wrong. It lives in a separate private repository that only the VPS
writes to. This repository never names it, imports it, or vendors it (no
submodule), and **public CI never needs it**.

## The setting

`DOCLIFTS_DATA_DIR` is the absolute path to a checkout of that data. It is
read only by scripts and private tests, through `dataDir()` in
`src/lib/server/data-dir.ts`, never by the app at run time:

- **unset or empty:** the normal case (CI, a fresh clone). Callers skip.
- **set:** it must be an existing absolute directory; anything else throws,
  so a typo cannot pass for "no data here".

On the VPS it is set in the owner's login profile.

## Layout the app relies on

| Path                                                                     | Used by                                                                                                     |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `catalog/snapshots/equipment_models_seed_<date>.csv`                     | `catalog-prod.sh` (below) and `private-data.test.ts`                                                        |
| `hard-photos/manifest.csv` (`id, sha256, bucket_key, true_model, notes`) | `private-data.test.ts`; the image is at `bucket_key` in the app's bucket, under `private-data/hard-photos/` |
| `hard-photos/files/` (not in git)                                        | the VPS copy of each photo; checked against its `sha256` when present                                       |

## Private tests

`src/lib/server/private-data.test.ts` runs in the server project and is
skipped when the setting is unset. Where the data is:

```sh
DOCLIFTS_DATA_DIR=/path/to/data pnpm run test:unit --project server private-data
```

It checks that every snapshot is dated and maps through `mapCatalogCsv` with
no row errors, and that the hard-photo manifest has unique ids, sha256
fingerprints, keys under `private-data/hard-photos/`, and a true model for
each photo.

## Importing a private snapshot

`catalog-prod.sh` runs under `sudo`, which drops the environment, so let your
own shell expand the setting before sudo runs:

```sh
sudo -n scripts/catalog-prod.sh "$DOCLIFTS_DATA_DIR/catalog/snapshots/equipment_models_seed_2026-10-01b.csv"
```

That is an absolute path outside the repository, so the existing rule applies:
the file is bind-mounted read-only and never enters the image
(`scripts/catalog-csv-path.sh`).
