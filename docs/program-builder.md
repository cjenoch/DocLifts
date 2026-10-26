# Program builder

## User path

Home → **Create program** → **Start blank** or a starter template (Traveling PPL, Barbell Strength, Machine Full Body, or Machines and Dumbbells) → edit structured fields → **Review program** → **Save program**. Choosing a preset does not save anything. **Back to editing** returns to the draft. The editor requires JavaScript; persistence uses ordinary POST server actions with server-side validation, not client-only validation or a JSON textarea.

A draft has a name, optional description, ordered named days (optional notes and alternate group), library or quick-added exercises, progression tier/policy, and ordered prescription rows. Draft rows can be moved or removed; there is no saved-program tree deletion control. New exercises explicitly declare generic equipment type and lower-body increment metadata. Existing library metadata is not silently changed. Sets support warmup/top/backoff/working roles, reps or seconds, ranges, RIR, rest, notes and optional cold-start initial load. There is no template current-load or physical-machine default.

From a saved program, **Edit program as new version** → review → **Save as new version** creates fresh program/day/exercise-prescription/set IDs and archives the source transactionally. Source child rows and ended workout snapshots stay unchanged. Creating an unrelated new program leaves existing active programs active.

A stable request UUID and persisted payload fingerprint make identical retries return the same program. Reusing a request ID with changed content is rejected. Nested validation and reference errors must roll back the entire save, including quick-added library rows and source archival.

## Traveling PPL

The preset is an editable generic template, not an imported workout log or a manufacturer catalog. Roll Push → Pull → **one** Legs variant, resting as needed. Legs A and Legs B share `alternateGroupId = 'legs'`; they are alternatives, not consecutive mandatory workouts.

Standing strict barbell overhead press is first on Push with cautious policy. Conventional deadlift is first on Legs A with hold policy. Both use **SECONDARY** because these are straight working sets; the internal engine tier does not mean second-priority exercise. MAIN instead requires one top set followed by backoffs, with optional leading warmups.

Work sets initially have NULL loads. Warmup guidance is notes only and assumes no bar weight or ramp load. Select a physical machine explicitly in the workout. Optional second triceps, abs, fresh-day leg extension and RDL fallback remain notes, not mandatory rows. Equipment definitions are generic and editable; there are no verified model/manufacturer or starting-resistance claims.

The required preset has 5/6/5/5 exercises and 11/12/11/12 working sets for Push/Pull/Legs A/Legs B. Prescription details live in `src/lib/traveling-ppl.ts` and pass through the same save validation as blank drafts.

## Phone editor and drafts

The editor moves through Program → Day → Exercise screens. Equal sets have shared
controls; **Customize sets** exposes individual warmups, top sets, backoffs, timed
sets, loads and notes. **Advanced** holds tier and progression settings.
Choosing a starting point replaces only the unsaved draft.

The draft, request ID and current screen survive reloads in this tab's
sessionStorage when available. New programs, edits and drafts made from workouts
have separate keys. This is browser storage, not a saved program or cross-device
synchronization. Cancel clears the stored draft; submission also clears it,
with server validation failures returned for correction.

Before review, the editor enforces both 250,000 serialized JSON characters and
500,000 URL-encoded form bytes, including the request UUID. This keeps
Unicode-heavy notes below adapter-node's default 512 KiB request limit.
Rejected drafts remain editable. Server actions independently reject oversized
payloads and unreadable bodies.

## Save a workout as a program

After finishing a workout, choose **Save as program**, then **New program** or
**Add as a day to** an existing active program. Both open a draft for review;
nothing is saved until the editor's save action succeeds. Adding a day to an
existing program uses the same versioned-edit flow.

The draft preserves exercise order and includes sets with a saved load, reps or
RIR; notes alone do not qualify a set. Roles and target metrics are retained.
Rep ranges come from performed values, with prescription/default fallbacks when
reps are missing. Starting loads and machine bindings are omitted. Unidentified
photo blocks need an exercise chosen before saving. The source workout is read,
not rewritten.

## Implementation and verification

- [ProgramEditor.svelte](../src/lib/components/ProgramEditor.svelte) and [editor-ui.ts](../src/lib/editor-ui.ts): screens, labels and browser drafts.
- [program-draft.ts](../src/lib/program-draft.ts): schema and size limits.
- [starter-templates.ts](../src/lib/starter-templates.ts) and [traveling-ppl.ts](../src/lib/traveling-ppl.ts): editable starter definitions.
- [program-builder.ts](../src/lib/server/program-builder.ts): owner-scoped reads, transactional saves and versioning.
- [workout-to-program.ts](../src/lib/server/workout-to-program.ts): drafts from finished workouts.

Migration [0006_program_draft_requests.sql](../drizzle/0006_program_draft_requests.sql)
introduced the durable idempotency receipt table. New installations apply the
full migration chain and create an account using the [development guide](development.md).
There is no demo seed command.

After local database setup, focused checks are:

```sh
pnpm test:server program-builder
pnpm test:server workout-to-program
pnpm test:client ProgramEditor
pnpm build
CI=1 pnpm test:e2e e2e/program-editor.e2e.ts e2e/starter-templates.e2e.ts e2e/save-as-program.e2e.ts
```

Use the [PowerShell CI syntax](development.md#validation) when needed. These
checks complement the full application gate in [Contributing](../CONTRIBUTING.md).
They use synthetic accounts and an isolated test database. Automated mobile
viewport checks do not establish acceptance on the owner's physical phone;
see [current status](../STATUS.md) and [first-workout acceptance](first-workout-acceptance.md).

The old `scripts/program-builder-browser-check.ts` is a prototype-era harness
with a fixed `builder_browser` database, port and earlier UI assumptions. Its
historical 262-test result is not evidence for the current editor. Use the
maintained Vitest suites above for current changes; do not treat the old script
or its screenshots as the current setup or release gate.
