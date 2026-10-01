# equipment_models seed — 2026-09-30

543 model rows, 8 brands, built from manufacturer catalog pages fetched 2026-09-29/30 plus reseller/manual listings where the manufacturer publishes no list.

## Columns
- manufacturer, product_line, model_code (empty when not sourced; never invented), name
- loading_type: selectorized | plate_loaded | cable_stack
- laterality: bilateral | independent (dual arms/stacks, converging or diverging) | n/a
- body_region: chest, back, shoulders, arms, legs, glutes, core, full_body, cable, or empty
- starting_resistance_lb / _kg, starting_resistance_basis: total | per_arm  (11 rows; manufacturer-stated only)
- stack_lb, stack_note (26 rows; note says who stated it)
- confidence:
  - manufacturer_page — name/code read from the manufacturer's own catalog page
  - reseller_or_manual — from a dealer listing, spec sheet, or owner's manual naming the model
  - inferred — name or code filled from training data or a naming convention; verify on the placard before trusting
  - line_only — a product line noted but not enumerated
- source: URL the row was read from (empty only on inferred rows)

## Import guidance
- Seed as global rows (owner_user_id NULL). Treat `inferred` rows as candidates: import them, but flag in the UI until a placard confirms.
- `model_code` is the join key for photo capture. Codes with an 'N' suffix (gym80) or trailing generation digit (Nautilus IP..5 vs IP..3) mark revisions; the placard decides.
- Starting resistance stays per model; stack size belongs on gym_equipment (the gym's instance), because several brands sell optional heavier stacks under the same code.
- Biostrength (Technogym) uses motorized resistance and is not a weight stack; it is listed as line_only and needs a new loading_type if ever cataloged.

## Optional column for later snapshots (importer, since 0.3.2)
- replaces_code: added as the LAST column of a newer snapshot when a manufacturer's code was corrected (e.g. Hammer Strength IL-DY -> IL-DRW). Holds the code the model was listed under before. The importer recodes the existing global row in place, so gyms' machines stay linked. Leave it empty on every other row. The 2026-09-30 file does not have this column and does not need it. Details: docs/catalog.md.
