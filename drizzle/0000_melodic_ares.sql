CREATE TABLE "day_exercises" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"day_id" uuid NOT NULL,
	"exercise_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"tier" text NOT NULL,
	"progression_policy" text DEFAULT 'standard' NOT NULL,
	"notes" text,
	CONSTRAINT "day_exercises_day_position_unique" UNIQUE("day_id","position")
);
--> statement-breakpoint
CREATE TABLE "days" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"program_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"alternate_group_id" text,
	"notes" text,
	CONSTRAINT "days_program_position_unique" UNIQUE("program_id","position")
);
--> statement-breakpoint
CREATE TABLE "exercises" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"equipment_type" text,
	"notes" text,
	CONSTRAINT "exercises_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "pain_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid,
	"set_id" uuid,
	"exercise_id" uuid,
	"location" text NOT NULL,
	"severity" integer NOT NULL,
	"trigger" text,
	"notes" text,
	"occurred_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "pain_events_severity_check" CHECK ("pain_events"."severity" >= 1 AND "pain_events"."severity" <= 10),
	CONSTRAINT "pain_events_parent_required_check" CHECK ("pain_events"."session_id" IS NOT NULL
          OR "pain_events"."set_id" IS NOT NULL
          OR "pain_events"."exercise_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "prescribed_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"day_exercise_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"set_role" text NOT NULL,
	"target_metric" text DEFAULT 'reps' NOT NULL,
	"target_reps_min" integer,
	"target_reps_max" integer,
	"target_rir" integer,
	"initial_load" numeric(6, 2),
	"rest_seconds_min" integer,
	"rest_seconds_max" integer,
	"notes" text,
	CONSTRAINT "prescribed_sets_day_exercise_position_unique" UNIQUE("day_exercise_id","position"),
	CONSTRAINT "prescribed_sets_reps_range_check" CHECK ("prescribed_sets"."target_reps_min" IS NULL OR "prescribed_sets"."target_reps_max" IS NULL
          OR "prescribed_sets"."target_reps_min" <= "prescribed_sets"."target_reps_max"),
	CONSTRAINT "prescribed_sets_rir_range_check" CHECK ("prescribed_sets"."target_rir" IS NULL
          OR ("prescribed_sets"."target_rir" >= 0 AND "prescribed_sets"."target_rir" <= 10)),
	CONSTRAINT "prescribed_sets_reps_min_non_negative" CHECK ("prescribed_sets"."target_reps_min" IS NULL OR "prescribed_sets"."target_reps_min" >= 0),
	CONSTRAINT "prescribed_sets_reps_max_non_negative" CHECK ("prescribed_sets"."target_reps_max" IS NULL OR "prescribed_sets"."target_reps_max" >= 0),
	CONSTRAINT "prescribed_sets_initial_load_non_negative" CHECK ("prescribed_sets"."initial_load" IS NULL OR "prescribed_sets"."initial_load" >= 0),
	CONSTRAINT "prescribed_sets_rest_min_non_negative" CHECK ("prescribed_sets"."rest_seconds_min" IS NULL OR "prescribed_sets"."rest_seconds_min" >= 0),
	CONSTRAINT "prescribed_sets_rest_max_non_negative" CHECK ("prescribed_sets"."rest_seconds_max" IS NULL OR "prescribed_sets"."rest_seconds_max" >= 0),
	CONSTRAINT "prescribed_sets_rest_range_check" CHECK ("prescribed_sets"."rest_seconds_min" IS NULL OR "prescribed_sets"."rest_seconds_max" IS NULL
          OR "prescribed_sets"."rest_seconds_min" <= "prescribed_sets"."rest_seconds_max")
);
--> statement-breakpoint
CREATE TABLE "programs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"source_program_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"day_id" uuid NOT NULL,
	"program_id" uuid NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"ended_at" timestamp,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"exercise_id" uuid NOT NULL,
	"prescribed_set_id" uuid,
	"position" integer NOT NULL,
	"set_role" text NOT NULL,
	"target_metric" text DEFAULT 'reps' NOT NULL,
	"prescribed_load" numeric(6, 2),
	"prescribed_reps_min" integer,
	"prescribed_reps_max" integer,
	"prescribed_rir" integer,
	"executed_load" numeric(6, 2),
	"executed_reps" integer,
	"executed_rir" integer,
	"was_audible" boolean DEFAULT false NOT NULL,
	"notes" text,
	"logged_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "sets_reps_check" CHECK ("sets"."executed_reps" IS NULL OR "sets"."executed_reps" >= 0),
	CONSTRAINT "sets_load_check" CHECK ("sets"."executed_load" IS NULL OR "sets"."executed_load" >= 0),
	CONSTRAINT "sets_rir_check" CHECK ("sets"."executed_rir" IS NULL
          OR ("sets"."executed_rir" >= 0 AND "sets"."executed_rir" <= 10)),
	CONSTRAINT "sets_prescribed_reps_range_check" CHECK ("sets"."prescribed_reps_min" IS NULL OR "sets"."prescribed_reps_max" IS NULL
          OR "sets"."prescribed_reps_min" <= "sets"."prescribed_reps_max"),
	CONSTRAINT "sets_prescribed_reps_min_non_negative" CHECK ("sets"."prescribed_reps_min" IS NULL OR "sets"."prescribed_reps_min" >= 0),
	CONSTRAINT "sets_prescribed_reps_max_non_negative" CHECK ("sets"."prescribed_reps_max" IS NULL OR "sets"."prescribed_reps_max" >= 0),
	CONSTRAINT "sets_prescribed_load_non_negative" CHECK ("sets"."prescribed_load" IS NULL OR "sets"."prescribed_load" >= 0),
	CONSTRAINT "sets_prescribed_rir_check" CHECK ("sets"."prescribed_rir" IS NULL
          OR ("sets"."prescribed_rir" >= 0 AND "sets"."prescribed_rir" <= 10))
);
--> statement-breakpoint
ALTER TABLE "day_exercises" ADD CONSTRAINT "day_exercises_day_id_days_id_fk" FOREIGN KEY ("day_id") REFERENCES "public"."days"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "day_exercises" ADD CONSTRAINT "day_exercises_exercise_id_exercises_id_fk" FOREIGN KEY ("exercise_id") REFERENCES "public"."exercises"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "days" ADD CONSTRAINT "days_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pain_events" ADD CONSTRAINT "pain_events_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pain_events" ADD CONSTRAINT "pain_events_set_id_sets_id_fk" FOREIGN KEY ("set_id") REFERENCES "public"."sets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pain_events" ADD CONSTRAINT "pain_events_exercise_id_exercises_id_fk" FOREIGN KEY ("exercise_id") REFERENCES "public"."exercises"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescribed_sets" ADD CONSTRAINT "prescribed_sets_day_exercise_id_day_exercises_id_fk" FOREIGN KEY ("day_exercise_id") REFERENCES "public"."day_exercises"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "programs" ADD CONSTRAINT "programs_source_program_id_programs_id_fk" FOREIGN KEY ("source_program_id") REFERENCES "public"."programs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_day_id_days_id_fk" FOREIGN KEY ("day_id") REFERENCES "public"."days"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sets" ADD CONSTRAINT "sets_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sets" ADD CONSTRAINT "sets_exercise_id_exercises_id_fk" FOREIGN KEY ("exercise_id") REFERENCES "public"."exercises"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sets" ADD CONSTRAINT "sets_prescribed_set_id_prescribed_sets_id_fk" FOREIGN KEY ("prescribed_set_id") REFERENCES "public"."prescribed_sets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "day_exercises_day_id_idx" ON "day_exercises" USING btree ("day_id");--> statement-breakpoint
CREATE INDEX "day_exercises_exercise_id_idx" ON "day_exercises" USING btree ("exercise_id");--> statement-breakpoint
CREATE INDEX "days_program_id_idx" ON "days" USING btree ("program_id");--> statement-breakpoint
CREATE INDEX "pain_events_exercise_occurred_idx" ON "pain_events" USING btree ("exercise_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "pain_events_location_occurred_idx" ON "pain_events" USING btree ("location","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "pain_events_session_id_idx" ON "pain_events" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "pain_events_set_id_idx" ON "pain_events" USING btree ("set_id");--> statement-breakpoint
CREATE INDEX "prescribed_sets_day_exercise_id_idx" ON "prescribed_sets" USING btree ("day_exercise_id");--> statement-breakpoint
CREATE INDEX "programs_source_program_id_idx" ON "programs" USING btree ("source_program_id");--> statement-breakpoint
CREATE INDEX "sessions_day_started_at_idx" ON "sessions" USING btree ("day_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "sessions_program_id_idx" ON "sessions" USING btree ("program_id");--> statement-breakpoint
CREATE INDEX "sets_session_id_idx" ON "sets" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "sets_prescribed_set_id_idx" ON "sets" USING btree ("prescribed_set_id");--> statement-breakpoint
CREATE INDEX "sets_prefill_idx" ON "sets" USING btree ("exercise_id","set_role","position","logged_at" DESC NULLS LAST);