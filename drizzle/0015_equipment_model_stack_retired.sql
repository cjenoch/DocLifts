ALTER TABLE "equipment_models" ADD COLUMN "standard_stack_lb" integer;--> statement-breakpoint
ALTER TABLE "equipment_models" ADD COLUMN "standard_stack_note" text;--> statement-breakpoint
ALTER TABLE "equipment_models" ADD COLUMN "retired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "equipment_models" ADD CONSTRAINT "equipment_models_standard_stack_lb_check" CHECK ("equipment_models"."standard_stack_lb" IS NULL OR "equipment_models"."standard_stack_lb" > 0);