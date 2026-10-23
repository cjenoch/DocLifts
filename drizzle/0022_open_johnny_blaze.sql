CREATE TABLE "photo_objects" (
	"storage_key" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"photo_id" uuid NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "photo_objects_state_check" CHECK ("photo_objects"."state" IN ('uploading', 'stored', 'delete_pending'))
);
--> statement-breakpoint
CREATE TABLE "privacy_deletions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"subject_hash" text NOT NULL,
	"owner_id" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"last_error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "privacy_deletions_subject_unique" UNIQUE("kind","subject_hash"),
	CONSTRAINT "privacy_deletions_kind_check" CHECK ("privacy_deletions"."kind" IN ('account', 'photo'))
);
--> statement-breakpoint
ALTER TABLE "auth"."user" ADD COLUMN "deletion_requested_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "photo_objects_user_idx" ON "photo_objects" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "privacy_deletions_owner_idx" ON "privacy_deletions" USING btree ("owner_id");--> statement-breakpoint
-- Backfill every object, including historically discarded ones: DELETE is idempotent.
INSERT INTO photo_objects (storage_key, user_id, photo_id, state, created_at)
 SELECT storage_key, user_id, id, CASE WHEN status = 'discarded' THEN 'delete_pending' ELSE 'stored' END, created_at
 FROM equipment_photos;
--> statement-breakpoint
-- A SHARE row lock serializes even previously authenticated writes against the
-- account deletion fence. No account can receive new children after acceptance.
CREATE FUNCTION public.privacy_assert_active(owner_id text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE deleting timestamptz;
BEGIN
 IF owner_id IS NULL THEN RETURN; END IF;
 SELECT deletion_requested_at INTO deleting FROM auth."user" WHERE id = owner_id FOR SHARE;
 IF NOT FOUND OR deleting IS NOT NULL THEN
   RAISE EXCEPTION 'Account unavailable' USING ERRCODE = '23514';
 END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.privacy_write_fence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_id text;
BEGIN
 IF TG_ARGV[0] = 'direct' THEN owner_id := to_jsonb(NEW)->>TG_ARGV[1];
 ELSIF TG_ARGV[0] = 'program' THEN SELECT user_id INTO owner_id FROM programs WHERE id = NEW.program_id;
 ELSIF TG_ARGV[0] = 'day' THEN SELECT p.user_id INTO owner_id FROM days d JOIN programs p ON p.id=d.program_id WHERE d.id=NEW.day_id;
 ELSIF TG_ARGV[0] = 'prescription' THEN SELECT p.user_id INTO owner_id FROM day_exercises de JOIN days d ON d.id=de.day_id JOIN programs p ON p.id=d.program_id WHERE de.id=NEW.day_exercise_id;
 ELSIF TG_ARGV[0] = 'session' THEN SELECT user_id INTO owner_id FROM sessions WHERE id=NEW.session_id;
 ELSIF TG_ARGV[0] = 'gym' THEN SELECT user_id INTO owner_id FROM gyms WHERE id=NEW.gym_id;
 ELSIF TG_ARGV[0] = 'exercise' THEN SELECT user_id INTO owner_id FROM exercises WHERE id=NEW.exercise_id;
 ELSIF TG_ARGV[0] = 'import' THEN SELECT user_id INTO owner_id FROM workout_log_imports WHERE id=NEW.import_id;
 END IF;
 PERFORM privacy_assert_active(owner_id);
 IF TG_TABLE_NAME = 'equipment_photos' AND TG_OP = 'UPDATE' THEN
   IF EXISTS (SELECT 1 FROM photo_objects WHERE photo_id = NEW.id AND state = 'delete_pending') THEN
     RAISE EXCEPTION 'Photo removal pending' USING ERRCODE = '23514';
   END IF;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
DO $$
DECLARE tab text;
BEGIN
 FOREACH tab IN ARRAY ARRAY['programs','exercises','gyms','sessions','sets','pain_events','workout_log_imports','program_draft_requests','llm_calls','equipment_photos','machine_merges','photo_notice_acknowledgements'] LOOP
   EXECUTE format('CREATE TRIGGER privacy_write_fence BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION privacy_write_fence(''direct'', ''user_id'')', tab);
 END LOOP;
 FOREACH tab IN ARRAY ARRAY['session','account','oauth_access_token','oauth_refresh_token','oauth_consent','oauth_client'] LOOP
   EXECUTE format('CREATE TRIGGER privacy_write_fence BEFORE INSERT OR UPDATE ON auth.%I FOR EACH ROW EXECUTE FUNCTION privacy_write_fence(''direct'', ''user_id'')', tab);
 END LOOP;
END $$;
--> statement-breakpoint
CREATE TRIGGER privacy_write_fence BEFORE INSERT OR UPDATE ON equipment_models FOR EACH ROW EXECUTE FUNCTION privacy_write_fence('direct', 'owner_user_id');
--> statement-breakpoint
CREATE TRIGGER privacy_write_fence BEFORE INSERT OR UPDATE ON days FOR EACH ROW EXECUTE FUNCTION privacy_write_fence('program');
--> statement-breakpoint
CREATE TRIGGER privacy_write_fence BEFORE INSERT OR UPDATE ON day_exercises FOR EACH ROW EXECUTE FUNCTION privacy_write_fence('day');
--> statement-breakpoint
CREATE TRIGGER privacy_write_fence BEFORE INSERT OR UPDATE ON prescribed_sets FOR EACH ROW EXECUTE FUNCTION privacy_write_fence('prescription');
--> statement-breakpoint
CREATE TRIGGER privacy_write_fence BEFORE INSERT OR UPDATE ON session_exercises FOR EACH ROW EXECUTE FUNCTION privacy_write_fence('session');
--> statement-breakpoint
CREATE TRIGGER privacy_write_fence BEFORE INSERT OR UPDATE ON gym_equipment FOR EACH ROW EXECUTE FUNCTION privacy_write_fence('gym');
--> statement-breakpoint
CREATE TRIGGER privacy_write_fence BEFORE INSERT OR UPDATE ON exercise_equipment_map FOR EACH ROW EXECUTE FUNCTION privacy_write_fence('exercise');
--> statement-breakpoint
CREATE TRIGGER privacy_write_fence BEFORE INSERT OR UPDATE ON imported_workouts FOR EACH ROW EXECUTE FUNCTION privacy_write_fence('import');
--> statement-breakpoint
CREATE FUNCTION public.privacy_verification_owner(value text) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
 BEGIN RETURN value::jsonb->>'userId';
 EXCEPTION WHEN invalid_text_representation THEN RETURN value;
 END;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.privacy_verification_fence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_id text; payload jsonb;
BEGIN
 BEGIN
  payload := NEW.value::jsonb;
  IF jsonb_typeof(payload)='object' AND payload ? 'userId' THEN
   PERFORM privacy_assert_active(payload->>'userId'); RETURN NEW;
  END IF;
 EXCEPTION WHEN invalid_text_representation THEN NULL;
 END;
 owner_id := privacy_verification_owner(NEW.value);
 IF EXISTS (SELECT 1 FROM auth."user" WHERE id=owner_id) THEN PERFORM privacy_assert_active(owner_id); END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER privacy_verification_fence BEFORE INSERT OR UPDATE ON auth.verification FOR EACH ROW EXECUTE FUNCTION privacy_verification_fence();
