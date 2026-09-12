# Physical machine identity: pilot design

Execution and review state belongs to Kanban `default` / `t_ec638eb4`, not this document. This scoped multi-gym slice is explicitly owner-approved; deployment and live migration are separate approval gates.

## Identity and compatibility

Existing exercise IDs and names are not deduplicated or remapped. Nullable `exercises.canonical_movement` groups discovery only. User-supplied equipment model metadata is not a verified manufacturer catalog. `exercise_equipment_map` is many-to-many for combo machines. `gym_equipment` identifies an actual physical machine; two copies of a model remain different performance identities.

The performance key is `(exercise_id, gym_equipment_id, load_convention, set_role, position)`. Legacy rows keep NULL machine and `legacy` convention. Machine history never falls back to legacy or another machine/model. History filters remain ended, nondeleted, executed load/reps non-NULL. Backwards streaks choose the latest execution per slot per completed session, rather than counting repeated occurrences as different workouts.

`session_exercises` records a session-local occurrence and snapshots exercise name, machine label, gym name, user-supplied model description, equipment type, tier and progression policy. Sets carry occurrence/machine/convention alongside existing immutable prescriptions. No legacy physical identities are inferred. Old rows use their existing display context until a newly started session creates explicit occurrences.

## Load meaning

Conventions: plates_per_side, total_plates, per_arm, displayed, unknown, plus existing legacy. The recorded number is never converted using starting resistance. Snap remains after engine: the existing legacy equipment router is unchanged; explicit plates_per_side on machine-plate uses per-side plate math. Other explicit conventions pass through until verified inventory/conversion rules exist. Starting resistance and model code are nullable descriptive metadata, not computed equivalence.

Selecting a new machine clears template/legacy load suggestions. Cold-start load stays blank rather than carrying over an unrelated machine's initial load. Warmups use matching machine history without engine progression. Secondary/isolation suggestions aggregate all working slots and use typed engine decisions. Inputs remain editable.

## User path and safety

Home navigation → Gyms and machines → create gym → add named physical machine (model optional). Return to an active workout and select/change its machine before logging, or quick-add an existing/new exercise to this workout only. Gym and machine must match; exercise and machine equipment types must match. New exercises explicitly declare lower-body increment metadata. Quick-add does not modify days, day-exercises, prescriptions or program activation.

Machine selection requires an explicit confirmation checkbox. Any saved execution field or note prevents rebinding; after logging, use a separate occurrence. Session-row locks serialize binding, quick-add and set updates. Every machine-bound set update includes an identity token captured with its mounted inputs; stale tabs get a reload error instead of storing old-machine values under a refreshed identity. Ended sessions cannot acquire or switch identities.

Template editing is not exposed by this slice. `duplicateProgramForEdit` provides and tests the required transactional deep-copy boundary for future template actions: fresh program/day/day-exercise/prescription IDs, old program inactive, lineage preserved, old session/set references untouched. Do not mutate a template in place.

## Migration and verification

Schema source: `src/lib/server/db/schema.ts`; generated migration: `drizzle/0005_jittery_gladiator.sql`. Additive only. Migration/rollback must be reviewed before production; no automatic live migration is part of the pilot.

Use an isolated PostgreSQL instance. Existing `test-db.ts` can CREATE DATABASE and TRUNCATE application tables; always set an explicit isolated TEST_DATABASE_URL. The pilot uses a distinct container bound to 127.0.0.1:55439, with synthetic browser DB, separate integration DB, and separate private restore DB. Never upload a database archive or row contents as evidence.

`pnpm check`, `pnpm test`, `pnpm build` are standard gates. `scripts/pilot-browser-check.ts` exercises real Chromium UI against synthetic data and reads back the exact rows. `scripts/pilot-migration-check.ts` verifies original table columns/IDs using in-memory hashes on the isolated restored backup, without exporting private records. Both scripts refuse non-pilot database URLs.

## Intentional limits

No catalog import, model equivalence, verified starting resistance data, inventory editing, persistent per-program gym defaults, template editor UI, authentication, deployment or production writes. Machine selection is explicit each workout; quick-add changes only that session. Unknown pre-existing active sessions retain legacy context (start a fresh workout for explicit occurrence binding). Reports split exercise counts by machine/convention and show historical snapshot names; differently named snapshots may appear as separate count rows after a rename.
