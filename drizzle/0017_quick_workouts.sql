ALTER TABLE "programs" ADD COLUMN "system_kind" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "gym_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_gym_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "programs_one_quick_per_user" ON "programs" USING btree ("user_id") WHERE system_kind = 'quick';--> statement-breakpoint
CREATE INDEX "sessions_gym_id_idx" ON "sessions" USING btree ("gym_id");--> statement-breakpoint
ALTER TABLE "programs" ADD CONSTRAINT "programs_system_kind_check" CHECK ("programs"."system_kind" IS NULL OR "programs"."system_kind" = 'quick');