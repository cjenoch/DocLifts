-- Preflight for migration 0025 (auth_account_provider_account_unique).
--
-- READ ONLY. Lists every (provider_id, account_id) pair held by more than one
-- auth.account row, which would make 0025 refuse to apply. Prints counts, row
-- ids, user ids, timestamps and whether a password is set. NEVER the password
-- hash, tokens or emails.
--
-- Run it on a RESTORE of the nightly dump, never on production:
--   psql -X -v ON_ERROR_STOP=1 -d doclifts_scratch -f scripts/auth-account-duplicates.sql
-- Zero groups: 0025 will apply. Any group: stop, and follow docs/migrations.md,
-- "0025 — one credential row per account".
BEGIN TRANSACTION READ ONLY;

SELECT count(*) AS duplicate_pairs, coalesce(sum(n), 0) AS rows_in_duplicate_pairs
FROM (
	SELECT count(*) AS n FROM auth.account
	GROUP BY provider_id, account_id HAVING count(*) > 1
) d;

SELECT a.provider_id,
       a.account_id,
       a.id AS account_row_id,
       a.user_id,
       a.created_at,
       a.updated_at,
       (a.password IS NOT NULL) AS has_password,
       (a.account_id = a.user_id) AS account_id_is_user_id
FROM auth.account a
JOIN (
	SELECT provider_id, account_id FROM auth.account
	GROUP BY provider_id, account_id HAVING count(*) > 1
) d USING (provider_id, account_id)
ORDER BY a.provider_id, a.account_id, a.updated_at DESC, a.id;

ROLLBACK;
