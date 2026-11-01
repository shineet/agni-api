-- PREPARED 2026-10-31, NOT RUN. Device attribution for usage rows (deletion
-- support). Safe on its own: adds two nullable columns and an index; changes
-- no existing row (every existing row stays NULL = unattributed, and is never
-- assumed to belong to any device).
--
-- Run order for the whole deletion change (Agni Supabase project, name checked
-- first), BEFORE the server deploy is promoted:
--   1. this file
--   2. schema-billing.sql      (agni_reserve gains p_device_subject; the old
--                               signature is dropped in the same file)
--   3. schema-deletion.sql     (the two deletion functions)
--   4. schema-retention.sql    (adds agni_beta_signup_cleanup)
--   5. schema-dish-cleanup.sql (only if the test-dish cleanup is approved)
--   6. schema-lockdown.sql     (LAST: makes every new function service-role only)
--
-- SQL BEFORE SERVER. The new server passes p_device_subject; the old
-- 22-argument agni_reserve does not accept it, so a new server against old SQL
-- would fail every reservation. The reverse is safe: the new agni_reserve
-- defaults p_device_subject to NULL, so the old server keeps working against
-- the new SQL. Apply steps 1 to 6, then promote the deploy.

-- UPGRADE OR FRESH. On a fresh database the billing tables do not exist yet
-- (schema-billing.sql creates them, with these same columns), so every step
-- here is skipped rather than failing. Found 2026-10-31 by running the
-- 3ef4e97 test suite against the new SQL from an empty database.
begin;
do $$
begin
  if to_regclass('public.agni_usage_events') is not null then
    alter table agni_usage_events add column if not exists device_subject text;
    create index if not exists agni_usage_events_device on agni_usage_events (subject_id, device_subject);
  end if;
  if to_regclass('public.agni_actions') is not null then
    alter table agni_actions add column if not exists device_subject text;
  end if;
end $$;
commit;
