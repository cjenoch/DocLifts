ALTER TABLE "equipment_models" ADD COLUMN "body_region" text;--> statement-breakpoint
ALTER TABLE "equipment_models" ADD COLUMN "starting_resistance_basis" text;--> statement-breakpoint
ALTER TABLE "equipment_models" ADD COLUMN "confidence" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "equipment_models" ADD COLUMN "source_url" text;--> statement-breakpoint
ALTER TABLE "equipment_models" ADD COLUMN "catalog_snapshot" date;--> statement-breakpoint
ALTER TABLE "gym_equipment" ADD COLUMN "stack_lb" integer;--> statement-breakpoint
ALTER TABLE "gym_equipment" ADD COLUMN "increment_lb" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "equipment_models_catalog_code_unique" ON "equipment_models" USING btree ("manufacturer","code") WHERE "equipment_models"."code" IS NOT NULL AND "equipment_models"."code" <> '' AND "equipment_models"."owner_user_id" IS NULL;--> statement-breakpoint
ALTER TABLE "equipment_models" ADD CONSTRAINT "equipment_models_confidence_check" CHECK ("equipment_models"."confidence" IN ('manufacturer_page', 'reseller_or_manual', 'inferred', 'line_only', 'user'));--> statement-breakpoint
ALTER TABLE "equipment_models" ADD CONSTRAINT "equipment_models_body_region_check" CHECK ("equipment_models"."body_region" IS NULL OR "equipment_models"."body_region" IN ('chest', 'back', 'shoulders', 'arms', 'legs', 'glutes', 'core', 'full_body', 'cable'));--> statement-breakpoint
ALTER TABLE "equipment_models" ADD CONSTRAINT "equipment_models_resistance_basis_check" CHECK ("equipment_models"."starting_resistance_basis" IS NULL OR "equipment_models"."starting_resistance_basis" IN ('total', 'per_arm'));--> statement-breakpoint
ALTER TABLE "gym_equipment" ADD CONSTRAINT "gym_equipment_stack_lb_check" CHECK ("gym_equipment"."stack_lb" IS NULL OR "gym_equipment"."stack_lb" > 0);--> statement-breakpoint
ALTER TABLE "gym_equipment" ADD CONSTRAINT "gym_equipment_increment_lb_check" CHECK ("gym_equipment"."increment_lb" IS NULL OR "gym_equipment"."increment_lb" > 0);