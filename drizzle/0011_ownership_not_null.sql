-- 0011_ownership_not_null
--
-- HAND-ADDED ABOVE THE GENERATED CONTENT BELOW. drizzle-kit generated only the
-- eight ALTER TABLE ... SET NOT NULL statements, which is exactly right and
-- exactly insufficient: on a database that already has rows, every one of those
-- alters fails on the first unowned row. So this file adds, in this order:
--
--   1. a sentinel row in "auth"."user"
--   2. eight UPDATE ... SET user_id = <sentinel> WHERE user_id IS NULL
--   3. the eight generated ALTERs
--
-- The sentinel exists so pre-existing rows have an owner, not so they have an
-- abstraction. `pnpm user:bootstrap` claims those rows for a real account at
-- release. A sentinel that is never claimed is inert: no credential row is
-- created for it, so nobody can sign in as it.
--
-- WHY THE SENTINEL INSERT IS GUARDED
--   - ON CONFLICT (id) DO NOTHING: re-running 0011 (or applying it to a
--     database where the id already exists) must not fail.
--   - SKIPPED ENTIRELY WHEN THE EIGHT TABLES ARE ALL EMPTY: on a fresh install
--     there is nothing to backfill, and an unclaimed sentinel row would be pure
--     litter that `user:bootstrap` then has to reason about. With no rows to
--     own, the NOT NULL alters succeed without it.
--
--     Note the direction of that guard, because it is the whole ballgame and it
--     was written backwards the first time: the sentinel is inserted when the
--     tables are NOT all empty. An earlier draft had the EXISTS/NOT EXISTS the
--     other way round, which is superficially reasonable — "only create it if
--     there is something to own" — and which silently did the opposite on
--     production: programs holds 4 rows, so the NOT EXISTS was false, no
--     sentinel was created, and the very next statement failed the programs
--     foreign key. Caught by applying the chain to a fresh restore, not by
--     reading it.
--
-- REVERT (see docs/migrations.md). 0011 is reversible only if the sentinel is
-- unclaimed. If `user:bootstrap` has already claimed these rows, the correct
-- revert is to leave the NOT NULL in place: the data is owned and correct, and
-- dropping the constraint would only reopen the silent-unowned-insert hole.
--
--   DELETE FROM "auth"."user" WHERE id = '00000000-0000-4000-8000-000000000001';
--   ALTER TABLE <table> ALTER COLUMN "user_id" DROP NOT NULL;  -- x8
--   -- then reassign the rows the sentinel owned, if you want them back to NULL:
--   UPDATE <table> SET user_id = NULL WHERE user_id = '00000000-0000-4000-8000-000000000001';

-- 1. The sentinel owner. email_verified false and deliberately NO row in
--    "auth"."account": this is not a real account, no address was ever mailed,
--    and there is no password to sign in with.
INSERT INTO "auth"."user" (id, name, email, email_verified, created_at, updated_at)
SELECT '00000000-0000-4000-8000-000000000001', 'Owner', 'owner@localhost', false, now(), now()
WHERE EXISTS (
	SELECT 1 FROM programs
	UNION ALL SELECT 1 FROM gyms
	UNION ALL SELECT 1 FROM exercises
	UNION ALL SELECT 1 FROM sessions
	UNION ALL SELECT 1 FROM sets
	UNION ALL SELECT 1 FROM pain_events
	UNION ALL SELECT 1 FROM workout_log_imports
	UNION ALL SELECT 1 FROM program_draft_requests
)
ON CONFLICT (id) DO NOTHING;--> statement-breakpoint

-- 2. Backfill. Every pre-existing row predates per-user ownership, so it has no
--    owner to recover; the sentinel is the honest placeholder until
--    `pnpm user:bootstrap` claims it. WHERE user_id IS NULL keeps this a no-op
--    for rows T3 code already stamped with a real user.
UPDATE programs SET user_id = '00000000-0000-4000-8000-000000000001' WHERE user_id IS NULL;--> statement-breakpoint
UPDATE gyms SET user_id = '00000000-0000-4000-8000-000000000001' WHERE user_id IS NULL;--> statement-breakpoint
UPDATE exercises SET user_id = '00000000-0000-4000-8000-000000000001' WHERE user_id IS NULL;--> statement-breakpoint
UPDATE sessions SET user_id = '00000000-0000-4000-8000-000000000001' WHERE user_id IS NULL;--> statement-breakpoint
UPDATE sets SET user_id = '00000000-0000-4000-8000-000000000001' WHERE user_id IS NULL;--> statement-breakpoint
UPDATE pain_events SET user_id = '00000000-0000-4000-8000-000000000001' WHERE user_id IS NULL;--> statement-breakpoint
UPDATE workout_log_imports SET user_id = '00000000-0000-4000-8000-000000000001' WHERE user_id IS NULL;--> statement-breakpoint
UPDATE program_draft_requests SET user_id = '00000000-0000-4000-8000-000000000001' WHERE user_id IS NULL;--> statement-breakpoint

-- 3. Generated. The type system now enforces ownership: an insert that forgets
--    user_id is a type error in the app and a constraint violation out of band.
ALTER TABLE "exercises" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "gyms" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "pain_events" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "program_draft_requests" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "programs" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "sets" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "workout_log_imports" ALTER COLUMN "user_id" SET NOT NULL;
