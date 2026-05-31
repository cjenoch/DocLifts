ALTER TABLE "exercises" ADD COLUMN "is_lower_body" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sets" ADD COLUMN "suggestion_reasoning" text;