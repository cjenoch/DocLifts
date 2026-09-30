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
--   - ON CONFLICT (id) DO NOTHING is the ONLY guard on the sentinel insert,
--     so re-running 0011 is safe. See the comment at the insert for why there
--     is deliberately no "only when there is something to own" condition.
--
-- HISTORY, kept because the rule is to verify by applying and this is what
-- that caught. The first hand-written draft guarded the insert with
-- WHERE NOT EXISTS (...), intending "only create a sentinel if there are rows
-- to backfill". Production holds 4 programs, so NOT EXISTS was false, no
-- sentinel was created, and the very next statement failed the programs
-- foreign key. Inverting it to WHERE EXISTS fixed that database and left a
-- worse version of the same trap — a guard whose coverage had to be kept in
-- sync with the table list, and which failed confusingly whenever a table it
-- did not test first held rows. Unconditional plus ON CONFLICT is the shape
-- that cannot fail quietly.
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
--
--    UNCONDITIONAL, with ON CONFLICT (id) DO NOTHING as the only guard. An
--    earlier draft wrapped this in WHERE EXISTS over the eight owned tables,
--    to avoid littering a fresh install with an unclaimed sentinel. That
--    version had two problems and was replaced rather than repaired:
--
--      - It is a list that has to be kept in sync with the eight tables
--        forever. A ninth owned table, or a renamed one, silently drops out of
--        the guard and the migration fails mid-chain with a confusing foreign
--        key error instead of doing its job.
--      - Its real failure is subtler: a database holding rows in some owned
--        table but not the one the guard happens to test first gets no
--        sentinel, and the backfill then dies on that table. The failure looks
--        like a constraint bug rather than a missing row.
--
--    An unclaimed sentinel on a fresh install is harmless: user:bootstrap
--    already handles both "claim the sentinel" and "create fresh", and the
--    startup warning covers the unclaimed case. A guard that can fail
--    silently is not worth a row nobody can sign in as.
INSERT INTO "auth"."user" (id, name, email, email_verified, created_at, updated_at)
VALUES ('00000000-0000-4000-8000-000000000001', 'Owner', 'owner@localhost', false, now(), now())
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
