ALTER TABLE "sessions" ADD COLUMN "deleted_at" timestamp;
--> statement-breakpoint
DROP INDEX "sessions_one_open_per_day";
--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_one_open_per_day" ON "sessions" USING btree ("day_id") WHERE ended_at IS NULL AND deleted_at IS NULL;