-- FILLED COPY 2026-10-31: simulator install ids collected locally with -AgniWriteInstallID.
-- Still SELECT-only in a read-only transaction. Not run.
-- READ ONLY. Candidate test-contamination rows in the shared dish tables.
-- Prepared 2026-10-31. NOT RUN. Nothing here writes: every statement is a
-- SELECT inside `begin read only; ... rollback;`, so even a pasted INSERT
-- would be refused by Postgres.
--
-- WHY. Every -AgniSelfTest run saved fixture meals, and saving a meal posted
-- its dishes to /api/dishes (about 13 rows per run). Two runs are known from the
-- Vercel request log: 2026-10-31 18:19:55 and 18:35:57 America/Chicago. Older
-- runs on any simulator or device did the same.
--
-- HOW A ROW BECOMES A CANDIDATE. Only on EVIDENCE:
--   (a) its contributor is one of the self-test installs listed below, or
--   (b) its created_at/updated_at falls inside a known self-test window.
-- A dish NAME is never evidence on its own: a real person can type "Idli".
--
-- FILL IN BEFORE RUNNING:
--   test_installs: raw install ids of simulator/device installs that ran
--     self-tests (read from each simulator's Keychain via a Debug build, or
--     from the x-agni-install header in Vercel logs for the windows below).
--     If server change 3b2845c has been deployed and converted, ALSO list each
--     install's contributor value `c1:...` (computed by the server's
--     contrib-migrate preview or contributorId(); the salt never goes here).
--   windows: add any other self-test runs found in the request log.
--
-- PUBLICATION STATUS is computed exactly as GET /api/dishes decides it:
-- agni_search_dishes reads agni_community_dishes, which publishes a key when
-- count(*) of agni_dish_submissions rows for that key >= 2 (one row per
-- contributor, primary key (key, install_id)). So a key is published iff it
-- has at least two contributor rows; a candidate row "makes" publication if
-- removing it would drop that key below two.

begin read only;

with test_installs(contributor) as (
  values ('42A5F948-3CF6-4898-86FB-1A2B0879F7A0'), -- sim AgniSE3 (self-tests to Oct 26)
         ('1DF058F8-F6A1-40A4-A8E6-F49C9E707F49'), -- sim iPhone 17 (self-tests Sep 22)
         ('05F7BACD-A5F2-404F-B087-11564CBB2659'), -- sim iPhone 17 Pro (self-tests Oct 31)
         ('13923BC8-6341-47C7-9C86-C87506BC5250'), -- sim iPhone 16e (self-tests Oct 8)
         ('E01AEE34-0681-4687-97B5-DEDF5358FACB'), -- sim iPhone 17e F9E5 (self-tests Oct 31)
         ('3763FC69-50AE-41F8-944A-F1EE0BD8EFCA'), -- sim iPhone Air (no self-test history; id may be new)
         ('F0287485-6B98-4B2A-A1E4-B9D68695CB4D'), -- sim iPhone 17 Pro Max (no history; id may be new)
         ('7DD0B35D-C3F6-4028-BDCD-458CE86C93E8') -- sim iPhone 17e A128 (no history; id may be new)
),
windows(starts, ends, label) as (
  values (timestamptz '2026-10-31 18:19:00 America/Chicago', timestamptz '2026-10-31 18:21:00 America/Chicago', 'self-test run 18:19:55'),
         (timestamptz '2026-10-31 18:35:00 America/Chicago', timestamptz '2026-10-31 18:37:00 America/Chicago', 'self-test run 18:35:57')
         -- , (timestamptz 'PLACEHOLDER', timestamptz 'PLACEHOLDER', 'other run')
),
per_key as (
  select key, count(*) as contributors from agni_dish_submissions group by key
),
candidates as (
  select s.key, s.name, s.install_id as contributor, s.created_at, s.updated_at,
         (s.install_id in (select contributor from test_installs)) as by_install,
         (select string_agg(w.label, '; ') from windows w
           where s.created_at between w.starts and w.ends
              or s.updated_at between w.starts and w.ends) as by_window
    from agni_dish_submissions s
)
select c.key, c.name, c.contributor, c.created_at, c.updated_at,
       case when c.by_install and c.by_window is not null then 'install + window'
            when c.by_install then 'install'
            else 'window: ' || c.by_window end                         as evidence,
       k.contributors                                                   as contributors_for_key,
       (k.contributors >= 2)                                            as published_now,
       (k.contributors >= 2 and k.contributors - 1 < 2)                 as this_row_makes_it_published,
       -- Contributors on this key that are NOT candidates: real corroboration.
       (select count(*) from candidates o
         where o.key = c.key and not o.by_install and o.by_window is null) as non_candidate_contributors
  from candidates c
  join per_key k using (key)
 where c.by_install or c.by_window is not null
 order by published_now desc, c.key, c.created_at;

rollback;

-- Missed-dish rows from the same evidence. Misses are never published; they
-- feed the "add to the bundled table" list, so test rows skew that list.
begin read only;

with test_installs(contributor) as (
  values ('42A5F948-3CF6-4898-86FB-1A2B0879F7A0'), -- sim AgniSE3 (self-tests to Oct 26)
         ('1DF058F8-F6A1-40A4-A8E6-F49C9E707F49'), -- sim iPhone 17 (self-tests Sep 22)
         ('05F7BACD-A5F2-404F-B087-11564CBB2659'), -- sim iPhone 17 Pro (self-tests Oct 31)
         ('13923BC8-6341-47C7-9C86-C87506BC5250'), -- sim iPhone 16e (self-tests Oct 8)
         ('E01AEE34-0681-4687-97B5-DEDF5358FACB'), -- sim iPhone 17e F9E5 (self-tests Oct 31)
         ('3763FC69-50AE-41F8-944A-F1EE0BD8EFCA'), -- sim iPhone Air (no self-test history; id may be new)
         ('F0287485-6B98-4B2A-A1E4-B9D68695CB4D'), -- sim iPhone 17 Pro Max (no history; id may be new)
         ('7DD0B35D-C3F6-4028-BDCD-458CE86C93E8') -- sim iPhone 17e A128 (no history; id may be new)
),
windows(starts, ends, label) as (
  values (timestamptz '2026-10-31 18:19:00 America/Chicago', timestamptz '2026-10-31 18:21:00 America/Chicago', 'self-test run 18:19:55'),
         (timestamptz '2026-10-31 18:35:00 America/Chicago', timestamptz '2026-10-31 18:37:00 America/Chicago', 'self-test run 18:35:57')
)
select m.key, m.name, m.kind, m.install_id as contributor, m.times, m.first_seen, m.last_seen,
       (m.install_id in (select contributor from test_installs)) as by_install,
       (select string_agg(w.label, '; ') from windows w
         where m.first_seen between w.starts and w.ends
            or m.last_seen between w.starts and w.ends) as by_window,
       (select count(distinct install_id) from agni_dish_misses o where o.key = m.key) as phones_for_key
  from agni_dish_misses m
 where m.install_id in (select contributor from test_installs)
    or exists (select 1 from windows w
                where m.first_seen between w.starts and w.ends
                   or m.last_seen between w.starts and w.ends)
 order by m.key, m.kind;

rollback;

-- Context only, NOT a classifier: how many submissions and misses arrived in
-- each minute of the known windows, to see whether real users were also active.
begin read only;
select date_trunc('minute', created_at at time zone 'America/Chicago') as minute_ct,
       count(*) as submissions, count(distinct install_id) as contributors
  from agni_dish_submissions
 where created_at between timestamptz '2026-10-31 18:00 America/Chicago' and timestamptz '2026-10-31 19:00 America/Chicago'
 group by 1 order by 1;
rollback;

-- NOTE ON FIXTURE NAMES. The dish names the app's self-tests save (in the
-- Agni repo's test fixtures: RepeatMealTests, MealDraft offer tests, etc.) may
-- be listed beside the output for a human to compare. They are NOT used as a
-- filter above, and a match on name alone must not mark a row for deletion.
