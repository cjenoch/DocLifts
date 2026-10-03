CREATE TABLE "mail_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"provider_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_sends_status_check" CHECK ("mail_sends"."status" in ('pending', 'sent', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "signup_admissions" (
	"user_id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth"."signup_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ip_hash" text NOT NULL,
	"email_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mail_sends" ADD CONSTRAINT "mail_sends_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signup_admissions" ADD CONSTRAINT "signup_admissions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mail_sends_user_time_idx" ON "mail_sends" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "mail_sends_time_idx" ON "mail_sends" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "signup_attempts_ip_time_idx" ON "auth"."signup_attempts" USING btree ("ip_hash","created_at");--> statement-breakpoint
CREATE INDEX "signup_attempts_email_time_idx" ON "auth"."signup_attempts" USING btree ("email_hash","created_at");--> statement-breakpoint
CREATE INDEX "signup_attempts_time_idx" ON "auth"."signup_attempts" USING btree ("created_at");