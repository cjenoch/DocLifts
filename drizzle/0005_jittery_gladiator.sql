CREATE TABLE "equipment_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"manufacturer" text NOT NULL,
	"product_line" text,
	"name" text NOT NULL,
	"code" text,
	"starting_resistance" numeric(6, 2),
	"loading_type" text NOT NULL,
	"laterality" text DEFAULT 'unknown' NOT NULL,
	CONSTRAINT "model_resistance_check" CHECK ("equipment_models"."starting_resistance" IS NULL OR "equipment_models"."starting_resistance" >= 0)
);
--> statement-breakpoint
CREATE TABLE "exercise_equipment_map" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"exercise_id" uuid NOT NULL,
	"equipment_model_id" uuid NOT NULL,
	CONSTRAINT "exercise_equipment_map_pair" UNIQUE("exercise_id","equipment_model_id")
);
--> statement-breakpoint
CREATE TABLE "gym_equipment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"gym_id" uuid NOT NULL,
	"equipment_model_id" uuid,
	"local_label" text NOT NULL,
	"equipment_type" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gyms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_exercises" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"exercise_id" uuid NOT NULL,
	"gym_equipment_id" uuid,
	"position" integer NOT NULL,
	"exercise_name" text NOT NULL,
	"machine_label" text,
	"gym_name" text,
	"model_name" text,
	"equipment_type" text NOT NULL,
	"load_convention" text DEFAULT 'legacy' NOT NULL,
	"tier" text NOT NULL,
	"progression_policy" text NOT NULL,
	CONSTRAINT "session_exercises_position_unique" UNIQUE("session_id","position")
);
--> statement-breakpoint
ALTER TABLE "exercises" ADD COLUMN "canonical_movement" text;--> statement-breakpoint
ALTER TABLE "sets" ADD COLUMN "session_exercise_id" uuid;--> statement-breakpoint
ALTER TABLE "sets" ADD COLUMN "gym_equipment_id" uuid;--> statement-breakpoint
ALTER TABLE "sets" ADD COLUMN "load_convention" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "exercise_equipment_map" ADD CONSTRAINT "exercise_equipment_map_exercise_id_exercises_id_fk" FOREIGN KEY ("exercise_id") REFERENCES "public"."exercises"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exercise_equipment_map" ADD CONSTRAINT "exercise_equipment_map_equipment_model_id_equipment_models_id_fk" FOREIGN KEY ("equipment_model_id") REFERENCES "public"."equipment_models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gym_equipment" ADD CONSTRAINT "gym_equipment_gym_id_gyms_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gym_equipment" ADD CONSTRAINT "gym_equipment_equipment_model_id_equipment_models_id_fk" FOREIGN KEY ("equipment_model_id") REFERENCES "public"."equipment_models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_exercises" ADD CONSTRAINT "session_exercises_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_exercises" ADD CONSTRAINT "session_exercises_exercise_id_exercises_id_fk" FOREIGN KEY ("exercise_id") REFERENCES "public"."exercises"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_exercises" ADD CONSTRAINT "session_exercises_gym_equipment_id_gym_equipment_id_fk" FOREIGN KEY ("gym_equipment_id") REFERENCES "public"."gym_equipment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "exercise_equipment_map_exercise_idx" ON "exercise_equipment_map" USING btree ("exercise_id");--> statement-breakpoint
CREATE INDEX "exercise_equipment_map_model_idx" ON "exercise_equipment_map" USING btree ("equipment_model_id");--> statement-breakpoint
CREATE INDEX "gym_equipment_gym_idx" ON "gym_equipment" USING btree ("gym_id");--> statement-breakpoint
CREATE INDEX "gym_equipment_model_idx" ON "gym_equipment" USING btree ("equipment_model_id");--> statement-breakpoint
CREATE INDEX "session_exercises_session_idx" ON "session_exercises" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "session_exercises_exercise_idx" ON "session_exercises" USING btree ("exercise_id");--> statement-breakpoint
CREATE INDEX "session_exercises_machine_idx" ON "session_exercises" USING btree ("gym_equipment_id");--> statement-breakpoint
ALTER TABLE "sets" ADD CONSTRAINT "sets_session_exercise_id_session_exercises_id_fk" FOREIGN KEY ("session_exercise_id") REFERENCES "public"."session_exercises"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sets" ADD CONSTRAINT "sets_gym_equipment_id_gym_equipment_id_fk" FOREIGN KEY ("gym_equipment_id") REFERENCES "public"."gym_equipment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sets_session_exercise_idx" ON "sets" USING btree ("session_exercise_id");--> statement-breakpoint
CREATE INDEX "sets_machine_idx" ON "sets" USING btree ("gym_equipment_id");--> statement-breakpoint
CREATE INDEX "sets_identity_idx" ON "sets" USING btree ("exercise_id","gym_equipment_id","load_convention","set_role","position","logged_at");--> statement-breakpoint
ALTER TABLE "sets" ADD CONSTRAINT "sets_convention_check" CHECK ("sets"."load_convention" IN ('legacy', 'unknown', 'plates_per_side', 'total_plates', 'per_arm', 'displayed'));--> statement-breakpoint
ALTER TABLE "sets" ADD CONSTRAINT "sets_machine_convention_check" CHECK ("sets"."gym_equipment_id" IS NULL OR "sets"."load_convention" <> 'legacy');