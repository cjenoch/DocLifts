# Catalog research brief (2026-10-01)

You are improving the DocLifts strength-equipment catalog: one CSV row per manufacturer machine model. The current snapshot is `seed-2026-09-30.csv` (543 rows, 8 brands); its column meanings and confidence levels are in `README-seed.md`. Read both first.

The app matches a machine photographed in a gym against this catalog by **manufacturer + model_code**, so model codes are the most valuable thing you can add. A wrong code is worse than a missing one.

## Your job, for your assigned brand(s) only

1. **Fill missing `model_code`** on codeless rows from authoritative sources: the manufacturer's own product pages, PDF spec sheets, owner's or assembly manuals, parts catalogs, and authorized dealer listings that state the code. Codes are often in URLs, PDF titles, spec tables and image filenames.
2. **Verify `inferred` rows.** Confirm or correct name and code from a source, then raise `confidence` to `manufacturer_page` or `reseller_or_manual` and set `source`. If you can't confirm a row, leave it `inferred` and say so in the change log.
3. **`line_only` rows:** if the line can be enumerated into real models, replace the line_only row with model rows. Otherwise leave it.
4. **Add models that are missing** from lines already in the catalog, and current models of the brand that aren't in it. Stay with selectorized, plate-loaded and cable-stack strength machines. No cardio, benches, racks or free weights unless the brand lists the item as a machine with a stack or plate horns.
5. **Fill `starting_resistance_lb`/`_kg` and `starting_resistance_basis`** (`total`/`per_arm`), and `stack_lb`, only where the manufacturer or its manual states the number. Put who stated it in `stack_note`.
6. **Fill an empty `body_region`** where it's obvious from the machine (chest, back, shoulders, arms, legs, glutes, core, full_body, cable).
7. Do the **brand-specific fixes** in your assignment.

## Rules, non-negotiable

- **Never invent a code or a number.** Every new or changed code, name or number must come from a page you actually fetched in this session. Put that URL in `source`. Training-data memory is not a source. If the only basis is memory or a naming pattern, leave the field empty, or keep the row `inferred` with an empty source.
- `confidence`: `manufacturer_page` if read from the manufacturer's own site or PDF; `reseller_or_manual` for a dealer listing, manual or spec sheet hosted elsewhere; `inferred` and `line_only` as defined in the README.
- `source` must be a URL (`http…`). If a row cites a description instead of a URL, find the URL or blank the source and keep the confidence honest.
- **Keep every existing row's identity:** don't delete rows and don't rename `manufacturer`. When you add a code to a codeless row, keep its `product_line` and `name` unchanged in that row, so the importer can match it to the existing row. If the name is also wrong, explain in the change log and the merger will decide. Only exception: a `line_only` row you replace with enumerated models.
- If one row in the seed is really two models (two codes), keep the original row with the first code and add a row for the second, and say so.
- Same 16 columns, same order, same header as the seed. `catalog_snapshot` is `2026-10-01` on every row you add or change, and unchanged otherwise. Write UTF-8 CSV with proper quoting (use Python's `csv` module, not hand-built strings).
- Revision or generation suffixes (gym80 `N`, Nautilus `…5` vs `…3`) are different codes. Record the one the source shows, and note the variants in `notes`.
- Be polite to sites: no hammering. A failed fetch or a 403 isn't a reason to guess. Try the manufacturer PDF, a dealer page or a manual-hosting site, or leave the gap.
- Do **not** touch anything outside `/home/chris/code/catalog-research/out/`. No repo, no databases, no production, no git.

## Tools

Load the web tools first: `ToolSearch` with query `select:WebSearch,WebFetch`. Use Python (`python3`, stdlib `csv`) to read and write CSVs, in `/home/chris/code/catalog-research/out/` only.

## Deliverables, in `/home/chris/code/catalog-research/out/`

- `<brand-slug>.csv`: **every** row for your brand(s): all seed rows, corrected where you have a source and unchanged otherwise, plus new rows. Same header as the seed.
- `<brand-slug>-changes.md`: a table of every changed or added row (code, what changed, source URL), then lists of rows you could not resolve and why, and sources you tried that failed.
- Final report back (concise): before and after counts per brand (rows, codeless, inferred, line_only, with starting resistance), the biggest wins, and anything the merger must decide.
