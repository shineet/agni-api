-- NOT RUN. PREPARED 2026-10-31 FOR SHINE TO REVIEW AND RUN BY HAND.
--
-- Converts the raw install ids already stored in agni_dish_submissions and
-- agni_dish_misses to the keyed hash new rows get (contributorId in
-- api/_lib.js), so no existing row can be joined to a phone's usage records.
--
-- ORDER: deploy the contributorId server change FIRST, then run this. Rows
-- written in between are already hashed and are skipped (`c1:` prefix).
--
-- BEFORE RUNNING: replace PASTE_IP_HASH_SALT_HERE below with the production
-- IP_HASH_SALT value (the same secret the server keys the hash with). If the
-- value differs, old rows and new rows from the same phone will not match and
-- that phone could count as two voices for one dish. Do not save the edited
-- file anywhere; paste it straight into the Supabase SQL editor.
--
-- Needs pgcrypto, which Supabase installs in the `extensions` schema.

-- 1. PREVIEW (read only). How many rows each table would change, and how many
--    raw rows already have a hashed twin from the same phone for the same dish
--    (written after the deploy); those raw rows are deleted rather than
--    converted, keeping the newer hashed row.
with s(salt) as (values ('PASTE_IP_HASH_SALT_HERE'))
select 'submissions' as tbl,
       count(*) filter (where d.install_id not like 'c1:%') as raw_rows,
       count(*) filter (where d.install_id not like 'c1:%' and exists (
         select 1 from agni_dish_submissions t
          where t.key = d.key
            and t.install_id = 'c1:' || left(encode(extensions.hmac('dish-contributor|' || d.install_id, s.salt, 'sha256'), 'hex'), 32)
       )) as raw_with_hashed_twin
  from agni_dish_submissions d, s
union all
select 'misses',
       count(*) filter (where m.install_id not like 'c1:%'),
       count(*) filter (where m.install_id not like 'c1:%' and exists (
         select 1 from agni_dish_misses t
          where t.key = m.key and t.kind = m.kind
            and t.install_id = 'c1:' || left(encode(extensions.hmac('dish-contributor|' || m.install_id, s.salt, 'sha256'), 'hex'), 32)
       ))
  from agni_dish_misses m, s;

-- 2. THE CHANGE, in one transaction.
begin;

create temporary table cleanup_salt on commit drop as
  select 'PASTE_IP_HASH_SALT_HERE'::text as salt;

-- Raw rows superseded by a hashed row from the same phone: the hashed one is
-- newer. For misses the phone's running total is kept at the larger value.
update agni_dish_misses t set
  times = greatest(t.times, m.times),
  first_seen = least(t.first_seen, m.first_seen),
  last_seen = greatest(t.last_seen, m.last_seen)
  from agni_dish_misses m, cleanup_salt s
 where m.install_id not like 'c1:%'
   and t.key = m.key and t.kind = m.kind
   and t.install_id = 'c1:' || left(encode(extensions.hmac('dish-contributor|' || m.install_id, s.salt, 'sha256'), 'hex'), 32);

delete from agni_dish_misses m using agni_dish_misses t, cleanup_salt s
 where m.install_id not like 'c1:%'
   and t.key = m.key and t.kind = m.kind
   and t.install_id = 'c1:' || left(encode(extensions.hmac('dish-contributor|' || m.install_id, s.salt, 'sha256'), 'hex'), 32);

delete from agni_dish_submissions d using agni_dish_submissions t, cleanup_salt s
 where d.install_id not like 'c1:%'
   and t.key = d.key
   and t.install_id = 'c1:' || left(encode(extensions.hmac('dish-contributor|' || d.install_id, s.salt, 'sha256'), 'hex'), 32);

update agni_dish_submissions d
   set install_id = 'c1:' || left(encode(extensions.hmac('dish-contributor|' || d.install_id, s.salt, 'sha256'), 'hex'), 32)
  from cleanup_salt s
 where d.install_id not like 'c1:%';

update agni_dish_misses m
   set install_id = 'c1:' || left(encode(extensions.hmac('dish-contributor|' || m.install_id, s.salt, 'sha256'), 'hex'), 32)
  from cleanup_salt s
 where m.install_id not like 'c1:%';

-- Must be zero before committing. If not, run `rollback;` instead.
select (select count(*) from agni_dish_submissions where install_id not like 'c1:%')
     + (select count(*) from agni_dish_misses where install_id not like 'c1:%') as raw_rows_left;

commit;

-- Supabase's backups still hold the raw ids until they age out of the backup
-- window; see docs/retention.md.
