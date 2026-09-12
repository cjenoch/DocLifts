# Program builder (local implementation)

## User path

Home → **Create program** → **Start blank draft** or **Use Traveling PPL preset** → edit structured fields → **Review program** → **Save program**. Choosing a preset does not save anything. **Back to editing** returns to the draft. The editor requires JavaScript; persistence uses ordinary POST server actions with server-side validation, not client-only validation or a JSON textarea.

A draft has a name, optional description, ordered named days (optional notes and alternate group), library or quick-added exercises, progression tier/policy, and ordered prescription rows. Draft rows can be moved or removed; there is no saved-program tree deletion control. New exercises explicitly declare generic equipment type and lower-body increment metadata. Existing library metadata is not silently changed. Sets support warmup/top/backoff/working roles, reps or seconds, ranges, RIR, rest, notes and optional cold-start initial load. There is no template current-load or physical-machine default.

From a saved program, **Edit program as new version** → review → **Save as new version** creates fresh program/day/exercise-prescription/set IDs and archives the source transactionally. Source child rows and ended workout snapshots stay unchanged. Creating an unrelated new program leaves existing active programs active.

A stable request UUID and persisted payload fingerprint make identical retries return the same program. Reusing a request ID with changed content is rejected. Nested validation and reference errors must roll back the entire save, including quick-added library rows and source archival.

## Traveling PPL

The preset is an editable generic template, not an imported workout log or a manufacturer catalog. Roll Push → Pull → **one** Legs variant, resting as needed. Legs A and Legs B share `alternateGroupId = 'legs'`; they are alternatives, not consecutive mandatory workouts.

Standing strict barbell overhead press is first on Push with cautious policy. Conventional deadlift is first on Legs A with hold policy. Both use **SECONDARY** because these are straight working sets; the internal engine tier does not mean second-priority exercise. MAIN instead requires one top set followed by backoffs, with optional leading warmups.

Work sets initially have NULL loads. Warmup guidance is notes only and assumes no bar weight or ramp load. Select a physical machine explicitly in the workout. Optional second triceps, abs, fresh-day leg extension and RDL fallback remain notes, not mandatory rows. Equipment definitions are generic and editable; there are no verified model/manufacturer or starting-resistance claims.

The required preset has 5/6/5/5 exercises and 11/12/11/12 working sets for Push/Pull/Legs A/Legs B. Prescription details live in `src/lib/traveling-ppl.ts` and pass through the same save validation as blank drafts.

## Migration and scope

`drizzle/0006_program_draft_requests.sql` adds the durable idempotency receipt table, fingerprint constraint, program FK and index; generated snapshot/journal metadata accompanies it. Review the additive migration before any future production rollout. Only the isolated local browser database has been used by this acceptance lane. Production migration, backups/rollback execution, deployment and imported logs are not part of this work.

For a fresh, approved isolated local database only:

```sh
DATABASE_URL=postgresql://builder@127.0.0.1:55441/builder_browser pnpm db:migrate
DATABASE_URL=postgresql://builder@127.0.0.1:55441/builder_browser pnpm exec vite dev --host 127.0.0.1 --port 5179
```

Do not run the application's seed command: acceptance needs no real Sunrise program, physical-machine data or historical logs. Server integration tests use the separate `builder_test` database, never the browser database.

## Real mobile acceptance

With the already migrated isolated database and local server above:

```sh
DATABASE_URL=postgresql://builder@127.0.0.1:55441/builder_browser pnpm exec tsx scripts/program-builder-browser-check.ts
```

The script hard-refuses any other DATABASE_URL (including an unset URL), does not load `.env`, does not truncate tables, refuses unfamiliar programs/library data, and never navigates outside the fixed local app origin. It inserts one synthetic exercise definition for existing-library selection. All programs, prescriptions and workout rows are created by real browser forms; the script never seeds a program or guesses workout fixtures. Reruns append uniquely named synthetic records and overwrite the current evidence report; there is no cleanup of historical test records.

Coverage:

- 390×844 Chromium, real structured blank three-day PPL creation, existing library plus two quick-adds, explicit lower-body metadata, reps and seconds, MAIN warmup/top/backoff, draft add/remove/reorder.
- Explicit review before save, saved program on home, UI start/log/end with database readback.
- UI edit/save-as-version with fresh child IDs, source inactive/new version active, exact source child-tree equality, and exact ended session/occurrence/set snapshot equality. Only source activation/update timestamp may change.
- Capture the actual hidden payload/requestId **before** each UI save; replay the exact browser POST body concurrently twice with same-origin headers. Each retry must redirect to the original program ID with no additional tree/library/receipt rows. This covers blank, edit and preset saves.
- Invalid nested range returns 400; missing nested exercise UUID rolls back newly added library rows and the entire tree. Failed edit leaves its source unchanged and active.
- Preset choose/edit/review/save, four days, exact mandatory exercise lists, legs alternation, and blank initial loads. Start and end all four days; verify actual set/occurrence counts, blank visible load inputs, NULL prescribed loads and NULL machine IDs.
- Every screenshot checkpoint checks document/body width against the mobile viewport and rejects JavaScript or console errors.

Artifacts: `../evidence/result.json` and the screenshots listed in that report. A failed run writes `passed: false` and `failure.png`; do not treat stale screenshots as proof of a successful run. Evidence contains synthetic names and generated IDs only, with hashes for immutable snapshot comparisons rather than database dumps. Imported log rows: **zero**.

Use explicit accessible select labels and whitespace-tolerant text assertions. Run acceptance against a stable build, not a development server undergoing concurrent edits; the harness rejects JavaScript errors rather than ignoring transient failures. Final verification also exercised the built adapter-node runtime with its default request-body limit: 262 server/client tests passed, type checking had zero errors/warnings, build passed, and the full mobile harness passed. Missing program edit URLs return HTTP 404.

Before review, the editor enforces both 250,000 serialized JSON characters and 500,000 URL-encoded form bytes (including the request UUID). The byte check protects Unicode-heavy notes from exceeding adapter-node's default 512 KiB request limit. Rejected drafts remain editable before navigation. Server actions independently reject oversized JSON and handle unreadable request bodies without reflecting their contents. No runtime body-limit increase is required.

## Limitations

The mobile editor is intentionally structured but long and verbose, especially for the preset. This is a responsive web form, not a native app/PWA. It needs JavaScript for draft editing/review. This browser script is not a replacement for the full server/client regression suites, concurrency/transaction unit coverage or build/type-check gates. No authentication, model catalog import, persistent gym defaults, cloud deployment or production writes were added by this acceptance work.
