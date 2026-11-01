-- PREPARED 2026-10-31, NOT RUN. Device attribution for usage rows (deletion
-- support). Safe on its own: adds two nullable columns and an index; changes
-- no existing row (every existing row stays NULL = unattributed, and is never
-- assumed to belong to any device).
--
-- Run order for the whole deletion change (Agni Supabase project, name checked
-- first), after the server deploy:
--   1. this file
--   2. schema-billing.sql      (agni_reserve gains p_device_subject; the old
--                               signature is dropped in the same file)
--   3. schema-deletion.sql     (the two deletion functions)
--   4. schema-retention.sql    (adds agni_beta_signup_cleanup)
--   5. schema-dish-cleanup.sql (only if the test-dish cleanup is approved)
--   6. schema-lockdown.sql     (LAST: makes every new function service-role only)
--
-- Deploying the server BEFORE step 2 is safe: the new server passes
-- p_device_subject, and the old 22-argument agni_reserve does not have it, so
-- reservations would FAIL until step 2 runs. Therefore run steps 1 and 2
-- immediately after the deploy is promoted, or (better) apply 1 and 2 first:
-- the old server never passes p_device_subject and the new function defaults
-- it to NULL, so old code keeps working against the new SQL.

begin;
alter table agni_usage_events add column if not exists device_subject text;
alter table agni_actions      add column if not exists device_subject text;
create index if not exists agni_usage_events_device on agni_usage_events (subject_id, device_subject);
commit;
