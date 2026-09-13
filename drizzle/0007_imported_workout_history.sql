CREATE TABLE "workout_log_imports" (
  "id" uuid PRIMARY KEY NOT NULL,
  "source_sha256" text NOT NULL UNIQUE,
  "source_name" text NOT NULL,
  "source_text" text NOT NULL,
  "imported_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "imported_workouts" (
  "id" uuid PRIMARY KEY NOT NULL,
  "import_id" uuid NOT NULL REFERENCES "workout_log_imports"("id") ON DELETE CASCADE,
  "source_line" integer NOT NULL,
  "workout_date" date,
  "earliest_date" date,
  "latest_date" date,
  "title" text NOT NULL,
  "gym" text,
  "date_note" text NOT NULL,
  "lines" jsonb NOT NULL,
  CONSTRAINT "imported_workouts_source_unique" UNIQUE("import_id", "source_line"),
  CONSTRAINT "imported_workouts_date_range" CHECK ("earliest_date" IS NULL OR "latest_date" IS NULL OR "earliest_date" <= "latest_date")
);
--> statement-breakpoint
CREATE INDEX "imported_workouts_import_idx" ON "imported_workouts" ("import_id");
--> statement-breakpoint
CREATE INDEX "imported_workouts_date_idx" ON "imported_workouts" ("workout_date");
