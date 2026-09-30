# Changelog

## Unreleased

Behavior changes since 0.1.0 that a user would notice:

- **CSP `unsafe-eval` violation on `/programs/new` and `/programs/[id]/edit`.** Since 0.1.0 both program-editor routes raised a `script-src blocked eval` violation against the strict nonce CSP. The cause is zod 4's `allowsEval` probe (`zod/v4/core/util.js`), a `new Function('')` whose throw is swallowed but still reported by the browser. Fixed with `z.config({ jitless: true })` in `src/lib/program-draft.ts` — no CSP change and no dependency change. The crawl was clean over the routes it visited; it did not visit these two, which is why this survived since 0.1.0. The crawl floor in `e2e/csp.e2e.ts` now covers all ten route patterns and fails by name if one is listed but never reached.
- **Deployment is Compose-only.** The systemd unit (`deploy/doclifts.service`), `scripts/deploy-safe.sh`, `scripts/verify-doclifts-up.sh`, and the `pnpm redeploy` script are removed. The unit was already `not-found` on the host; production runs through Compose. Use `scripts/compose-prod.sh` for Compose and `scripts/migrate-prod.sh` for migrations — both pass the production env file explicitly. The old path's one unique feature, the pre-migrate dump, is preserved: `scripts/migrate-prod.sh` takes a custom-format `pg_dump`, verifies it with `pg_restore --list`, refuses to migrate if that fails, and keeps the newest 14. Rollback is a documented manual `pg_restore` in the README, not automatic.
- **Production's env file moved out of the checkout, for good.** It lives at `/srv/doclifts/.env` (or `DOCLIFTS_PROD_ENV`). The checkout's `.env` was a symlink to it, which made every tool run from the checkout — vitest, drizzle-kit, `tsx` — read production credentials by default. The symlink is gone and the checkout now has its own development `.env` with no `POSTGRES_PASSWORD`, so a bare `docker compose` there fails loudly instead of quietly reusing production. `TEST_DATABASE_URL` moved out of the production file into the development one.
- **A test run can no longer write to a real database.** `db/index.ts` refuses to build a client under vitest against any database whose name does not end in `_test`, and `vite.config.ts` forces `DATABASE_URL` to the test database before any test module loads. Both are covered by tests.
- License changed from Apache-2.0 to the Functional Source License, Version 1.1, ALv2 Future License (FSL-1.1-ALv2). Self-hosting, internal use, and non-commercial use are unaffected; offering DocLifts as a competing commercial service is not permitted until each version's two-year conversion to Apache-2.0. Release 0.1.0 and everything before it stay Apache-2.0. `CONTRIBUTING.md` now carries DCO sign-off and contribution license terms; `.mailmap` normalizes author identities.

- Progression judges every working set against its own rep range and RIR target, not position 1's. An exercise that previously advanced can now hold when a later position misses its own range.
- Backoff and top rows on secondary/isolation exercises hold at their last load and say so ("held: no progression rule applies to this set"). One target-resolution helper now serves all three prefill paths, so a null rep-range top on the machine-bound path no longer clears on reps automatically.
- Plate snap returns 0, not the empty bar, for a zero or negative target.
- Reports completion bars render with a `<progress>` element. The strict Content-Security-Policy added on 2026-09-28 blocked the previous inline width style, so every bar drew at the same width.
- "Move to Trash" on an ended session uses the destructive button style again.
- `/history` lists sessions across all programs, including archived ones, by month. `/imported-history` shows the 500 most recent imports and discloses the cap.
- Strict nonce-based Content-Security-Policy on every response.
- Emptying a program's Trash checks the confirmed count and deletes in one transaction. A session trashed or restored in between now returns a count-changed error instead of being purged unchecked, and a Trash larger than 1000 sessions can be emptied.
- `/imported-history` labels the estimated-set count and the search as covering only the records shown when the 500-record cap is in effect.
- The favicon is served from `static/` instead of being inlined as a `data:` URI, which the Content-Security-Policy blocked on every page.
- CI: Prettier is a blocking check, and an end-to-end Chromium pass against the production build fails on any Content-Security-Policy violation.
- CI runs as one workflow inside the Playwright container image, including the component tests that the separate Browser CI workflow had silently stopped running after GitHub disabled it for inactivity on 2026-08-02. No browser install step; the image tag must match the `playwright` version.

## 0.1.0 — 2026-09-15

First Apache-2.0 open-source release.

- Standalone Docker Compose demo with fictional workouts, equipment, history, and a visible demo banner.
- Localhost-only access, a separate temporary database, automatic migrations, and guarded seeding that never truncates an existing database.
- Phone-friendly workout entry, searchable exercise selection, inline set/equipment creation, same-tab drafts, and simplified Trash controls.
- Machine-specific performance history, progression suggestions, program editing, and imported-history provenance.
- Apache license and attribution, contribution guidance, and documented demo startup/reset commands.

The demo is disposable and has no authentication. Use private infrastructure and a persistent database for real training data. Historical operational notes are excluded from source archives; existing Git history is not rewritten by this release.
