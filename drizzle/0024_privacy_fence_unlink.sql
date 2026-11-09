-- 0024: let a photo pending removal lose its links (custom SQL; no schema change).
--
-- 0022's privacy_write_fence() refuses ANY UPDATE of an equipment_photos row
-- whose photo_objects row is 'delete_pending' (23514 'Photo removal pending').
-- That also refuses the UPDATE Postgres itself runs for a foreign-key action:
-- equipment_photos.session_exercise_id is ON DELETE SET NULL (0018), so
-- deleting a session_exercises row updates the photo, and the BEFORE UPDATE
-- trigger fires on that update. After Discard (object 'delete_pending' until
-- erased) this broke:
--   * Remove on the photo's workout block (DELETE session_exercises);
--   * permanently deleting a trashed workout holding that block
--     (DELETE sessions -> CASCADE session_exercises -> SET NULL on the photo);
--   * the swap-time placeholder cleanup, which must clear
--     equipment_photos.gym_equipment_id before deleting the machine
--     (that FK is NO ACTION).
--
-- The function below is 0022's body, byte for byte, except the
-- equipment_photos pending branch: an UPDATE whose ONLY changes are
-- session_exercise_id and/or gym_equipment_id becoming NULL is allowed.
-- Every other column (status, candidate, storage key, model links, owner, ...)
-- must be unchanged, compared as jsonb objects (key order does not matter in
-- jsonb), and neither link may move to a different non-null value. An UPDATE
-- that changes nothing at all also passes. privacy_assert_active(owner_id)
-- still runs first, unchanged, so a fenced account (deletion requested) is
-- refused even for the unlinking update.
--
-- CREATE OR REPLACE keeps the function's OID, so every privacy_write_fence
-- trigger 0022 created keeps calling it; no trigger is dropped or recreated,
-- and nothing new is named. 0022 is not edited (append-only).
CREATE OR REPLACE FUNCTION public.privacy_write_fence() RETURNS trigger LANGUAGE plpgsql AS $$
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
 ELSIF TG_ARGV[0] = 'client' THEN SELECT user_id INTO owner_id FROM auth.oauth_client WHERE client_id=NEW.client_id;
 END IF;
 PERFORM privacy_assert_active(owner_id);
 IF TG_TABLE_NAME = 'equipment_photos' AND TG_OP = 'UPDATE' THEN
   IF EXISTS (SELECT 1 FROM photo_objects WHERE photo_id = NEW.id AND state = 'delete_pending')
      AND NOT (
        (to_jsonb(NEW) - 'session_exercise_id' - 'gym_equipment_id')
          = (to_jsonb(OLD) - 'session_exercise_id' - 'gym_equipment_id')
        AND (NEW.session_exercise_id IS NULL OR NEW.session_exercise_id IS NOT DISTINCT FROM OLD.session_exercise_id)
        AND (NEW.gym_equipment_id IS NULL OR NEW.gym_equipment_id IS NOT DISTINCT FROM OLD.gym_equipment_id)
      ) THEN
     RAISE EXCEPTION 'Photo removal pending' USING ERRCODE = '23514';
   END IF;
 END IF;
 RETURN NEW;
END $$;
