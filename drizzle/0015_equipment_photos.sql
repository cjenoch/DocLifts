CREATE TABLE "equipment_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"gym_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"content_type" text NOT NULL,
	"bytes" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"sha256" text NOT NULL,
	"status" text NOT NULL,
	"llm_call_id" uuid,
	"candidate" jsonb,
	"matched_model_id" uuid,
	"created_model_id" uuid,
	"gym_equipment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "equipment_photos_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "equipment_photos_status_check" CHECK ("equipment_photos"."status" IN ('uploaded', 'analyzed', 'confirmed', 'discarded')),
	CONSTRAINT "equipment_photos_size_check" CHECK ("equipment_photos"."bytes" > 0 AND "equipment_photos"."width" > 0 AND "equipment_photos"."height" > 0)
);
--> statement-breakpoint
ALTER TABLE "equipment_photos" ADD CONSTRAINT "equipment_photos_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equipment_photos" ADD CONSTRAINT "equipment_photos_gym_id_fk" FOREIGN KEY ("gym_id") REFERENCES "public"."gyms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equipment_photos" ADD CONSTRAINT "equipment_photos_llm_call_id_fk" FOREIGN KEY ("llm_call_id") REFERENCES "public"."llm_calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equipment_photos" ADD CONSTRAINT "equipment_photos_matched_model_id_fk" FOREIGN KEY ("matched_model_id") REFERENCES "public"."equipment_models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equipment_photos" ADD CONSTRAINT "equipment_photos_created_model_id_fk" FOREIGN KEY ("created_model_id") REFERENCES "public"."equipment_models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "equipment_photos" ADD CONSTRAINT "equipment_photos_gym_equipment_id_fk" FOREIGN KEY ("gym_equipment_id") REFERENCES "public"."gym_equipment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "equipment_photos_user_created_idx" ON "equipment_photos" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "equipment_photos_gym_equipment_idx" ON "equipment_photos" USING btree ("gym_equipment_id");--> statement-breakpoint
CREATE INDEX "equipment_photos_gym_idx" ON "equipment_photos" USING btree ("gym_id");--> statement-breakpoint
CREATE INDEX "equipment_photos_llm_call_idx" ON "equipment_photos" USING btree ("llm_call_id");--> statement-breakpoint
CREATE INDEX "equipment_photos_matched_model_idx" ON "equipment_photos" USING btree ("matched_model_id");--> statement-breakpoint
CREATE INDEX "equipment_photos_created_model_idx" ON "equipment_photos" USING btree ("created_model_id");