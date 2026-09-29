# Changelog

## Unreleased

Behavior changes since 0.1.0 that a user would notice:

- Progression judges every working set against its own rep range and RIR target, not position 1's. An exercise that previously advanced can now hold when a later position misses its own range.
- Backoff and top rows on secondary/isolation exercises hold at their last load and say so ("held: no progression rule applies to this set"). One target-resolution helper now serves all three prefill paths, so a null rep-range top on the machine-bound path no longer clears on reps automatically.
- Plate snap returns 0, not the empty bar, for a zero or negative target.
- Reports completion bars render with a `<progress>` element. The strict Content-Security-Policy added on 2026-09-28 blocked the previous inline width style, so every bar drew at the same width.
- "Move to Trash" on an ended session uses the destructive button style again.
- `/history` lists sessions across all programs, including archived ones, by month. `/imported-history` shows the 500 most recent imports and discloses the cap.
- Strict nonce-based Content-Security-Policy on every response.

## 0.1.0 — 2026-09-15

First Apache-2.0 open-source release.

- Standalone Docker Compose demo with fictional workouts, equipment, history, and a visible demo banner.
- Localhost-only access, a separate temporary database, automatic migrations, and guarded seeding that never truncates an existing database.
- Phone-friendly workout entry, searchable exercise selection, inline set/equipment creation, same-tab drafts, and simplified Trash controls.
- Machine-specific performance history, progression suggestions, program editing, and imported-history provenance.
- Apache license and attribution, contribution guidance, and documented demo startup/reset commands.

The demo is disposable and has no authentication. Use private infrastructure and a persistent database for real training data. Historical operational notes are excluded from source archives; existing Git history is not rewritten by this release.
