-- Schema hardening (v3) — DB-level CHECKs that mirror application invariants.
--
-- Why: the cross-model code review (2026-05-29, Phase 2) flagged three
-- defensive gaps. Each is a "silently wrong" failure mode under the current
-- schema:
--   1. exercises.equipment_type was nullable; snapForEquipment(load, null)
--      returns pass-through, so a missing equipment type silently prints
--      wrong-by-bar-weight loads on what should be a barbell exercise.
--   2. sessions.ended_at could land earlier than started_at (clock skew on
--      a multi-device write, bad UPDATE).
--   3. The four position columns are 1-indexed by convention but the schema
--      didn't enforce >= 1. A 0 or negative would bend prefill ordering.

-- Backfill: any orphan NULL equipment_type rows (defensive — should never
-- fire on a real DB since seed paths always set it) get 'bodyweight' so the
-- NOT NULL ALTER doesn't error.
UPDATE "exercises" SET "equipment_type" = 'bodyweight' WHERE "equipment_type" IS NULL;
--> statement-breakpoint
ALTER TABLE "exercises" ALTER COLUMN "equipment_type" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "day_exercises" ADD CONSTRAINT "day_exercises_position_non_neg_check" CHECK ("day_exercises"."position" >= 1);--> statement-breakpoint
ALTER TABLE "days" ADD CONSTRAINT "days_position_non_neg_check" CHECK ("days"."position" >= 1);--> statement-breakpoint
ALTER TABLE "exercises" ADD CONSTRAINT "exercises_equipment_type_check" CHECK ("exercises"."equipment_type" IN (
      'barbell', 'barbell-ez', 'machine-plate', 'machine-stack',
      'cable', 'dumbbell', 'smith', 'bodyweight', 'band'
    ));--> statement-breakpoint
ALTER TABLE "prescribed_sets" ADD CONSTRAINT "prescribed_sets_position_non_neg_check" CHECK ("prescribed_sets"."position" >= 1);--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_ended_after_started_check" CHECK ("sessions"."ended_at" IS NULL OR "sessions"."ended_at" >= "sessions"."started_at");--> statement-breakpoint
ALTER TABLE "sets" ADD CONSTRAINT "sets_position_non_neg_check" CHECK ("sets"."position" >= 1);
