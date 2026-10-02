CREATE TABLE "machine_merges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"dropped_id" uuid NOT NULL,
	"kept_id" uuid NOT NULL,
	"moved" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"undone_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "exercises" ADD COLUMN "body_region" text;--> statement-breakpoint
ALTER TABLE "exercises" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gym_equipment" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "gym_equipment" ADD COLUMN "merged_into_id" uuid;--> statement-breakpoint
ALTER TABLE "gyms" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "machine_merges" ADD CONSTRAINT "machine_merges_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_merges" ADD CONSTRAINT "machine_merges_dropped_id_fk" FOREIGN KEY ("dropped_id") REFERENCES "public"."gym_equipment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_merges" ADD CONSTRAINT "machine_merges_kept_id_fk" FOREIGN KEY ("kept_id") REFERENCES "public"."gym_equipment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "machine_merges_user_idx" ON "machine_merges" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "machine_merges_dropped_idx" ON "machine_merges" USING btree ("dropped_id");--> statement-breakpoint
CREATE INDEX "machine_merges_kept_idx" ON "machine_merges" USING btree ("kept_id");--> statement-breakpoint
ALTER TABLE "gym_equipment" ADD CONSTRAINT "gym_equipment_merged_into_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."gym_equipment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gym_equipment_merged_into_idx" ON "gym_equipment" USING btree ("merged_into_id");--> statement-breakpoint
ALTER TABLE "exercises" ADD CONSTRAINT "exercises_body_region_check" CHECK ("exercises"."body_region" IS NULL OR "exercises"."body_region" IN ('legs', 'back', 'chest', 'arms', 'shoulders', 'glutes', 'core', 'full body'));
--> statement-breakpoint
-- Body regions for the 23 starter exercises, by name (machines spec Part J). Only rows
-- still without a region; exercises a user created stay empty ("Other").
UPDATE "exercises" SET "body_region" = 'chest' WHERE "body_region" IS NULL AND "name" IN ('Barbell bench press', 'Incline dumbbell press', 'Dumbbell press', 'Cable fly');--> statement-breakpoint
UPDATE "exercises" SET "body_region" = 'arms' WHERE "body_region" IS NULL AND "name" IN ('Triceps pushdown', 'Dumbbell curl', 'Barbell curl');--> statement-breakpoint
UPDATE "exercises" SET "body_region" = 'shoulders' WHERE "body_region" IS NULL AND "name" IN ('Overhead press', 'Face pull');--> statement-breakpoint
UPDATE "exercises" SET "body_region" = 'back' WHERE "body_region" IS NULL AND "name" IN ('Lat pulldown', 'Barbell row', 'Seated cable row');--> statement-breakpoint
UPDATE "exercises" SET "body_region" = 'legs' WHERE "body_region" IS NULL AND "name" IN ('Back squat', 'Deadlift', 'Leg press', 'Leg curl', 'Leg extension', 'Calf raise', 'Goblet squat', 'Romanian deadlift');--> statement-breakpoint
UPDATE "exercises" SET "body_region" = 'core' WHERE "body_region" IS NULL AND "name" IN ('Plank', 'Cable crunch', 'Pallof press');
