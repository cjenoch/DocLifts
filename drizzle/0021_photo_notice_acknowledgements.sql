CREATE TABLE "photo_notice_acknowledgements" (
	"user_id" text PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"acknowledged_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "photo_notice_acknowledgements" ADD CONSTRAINT "photo_notice_acknowledgements_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;