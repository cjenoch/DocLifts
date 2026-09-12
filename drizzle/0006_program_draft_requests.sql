CREATE TABLE "program_draft_requests" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"fingerprint" text NOT NULL,
	"program_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "program_draft_requests_fingerprint_check" CHECK ("program_draft_requests"."fingerprint" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "program_draft_requests" ADD CONSTRAINT "program_draft_requests_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "program_draft_requests_program_idx" ON "program_draft_requests" USING btree ("program_id");