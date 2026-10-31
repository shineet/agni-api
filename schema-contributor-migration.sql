-- One-off: convert the raw install ids already stored in agni_dish_submissions
-- and agni_dish_misses to the contributor hash new rows get (contributorId in
-- api/_lib.js). PREPARED 2026-10-31. Applying this file changes no data; it
-- only creates the tables and functions the conversion uses.
--
-- WHY IT IS SPLIT THIS WAY. The hash is keyed on a server secret
-- (CONTRIBUTOR_SALT or IP_HASH_SALT). The first draft of this cleanup was a SQL
-- script with the secret pasted into it, which would have put the secret in an
-- editor, its history and possibly a file. Here the secret never leaves the
-- Vercel runtime: the admin op in api/_contrib-migration.js reads the raw ids,
-- computes each hash in Node, and hands this SQL a map of raw id to hash. The
-- database never sees the secret, only the values it produces.
--
-- WHAT THE HASH IS AND IS NOT. It is pseudonymous, not anonymous. The server
-- can recompute it from any install id it is given, so a row stays linkable to
-- a phone by anyone holding the secret and the id. What it removes is the raw
-- install id stored beside dish data, which is also the key of that phone's
-- usage records (`dev:<install id>`), so the tables cannot be joined by a plain
-- equality without the secret.
--
-- Runbook: migrations/README.md. Apply after schema-misses.sql and
-- schema-community.sql, then run schema-lockdown.sql LAST, so the new tables
-- are closed to anon and the functions are service-role only.

-- Every row the conversion changes or deletes, as it was, so the conversion
-- can be undone exactly. Holds raw install ids: drop it once the conversion
-- is verified (the runbook says when).
create table if not exists agni_dish_contrib_backup_20261031 (
  row_key        text        primary key,   -- tbl|key|kind|install_id, as it was
  tbl            text        not null,      -- 'submissions' or 'misses'
  raw_install_id text        not null,      -- the raw id whose conversion touched this row
  hashed         text        not null,      -- what that raw id converts to
  snapshot       jsonb       not null,      -- the whole row before the change
  backed_up_at   timestamptz not null default now()
);
alter table agni_dish_contrib_backup_20261031 enable row level security;

-- Distinct contributors per dish before the conversion, counting a phone's raw
-- row and its newer hashed row as one phone. The conversion must leave every
-- one of these unchanged; verify compares.
create table if not exists agni_dish_contrib_counts_20261031 (
  tbl                 text not null,
  key                 text not null,
  kind                text not null,          -- '' for submissions, which have no kind
  contributors_before int  not null,
  primary key (tbl, key, kind)
);
alter table agni_dish_contrib_counts_20261031 enable row level security;

-- The map the admin op passes in: [{ "raw": "...", "hashed": "c1:..." }].
-- Anything that is not a well-formed pair stops the call, so a bug on the
-- Node side cannot write a malformed contributor.
create or replace function agni__contrib_map(p_map jsonb)
returns table (raw text, hashed text)
language plpgsql
stable
as $$
begin
  if p_map is null or jsonb_typeof(p_map) <> 'array' then
    raise exception 'contributor map must be a JSON array';
  end if;
  if exists (
    select 1 from jsonb_to_recordset(p_map) as x(raw text, hashed text)
     where x.raw is null or length(x.raw) < 8 or x.raw like 'c1:%'
        or x.hashed is null or x.hashed !~ '^c1:[0-9a-f]{32}$'
  ) then
    raise exception 'contributor map has a malformed entry';
  end if;
  return query select x.raw, x.hashed from jsonb_to_recordset(p_map) as x(raw text, hashed text);
end;
$$;

-- Distinct raw ids still stored, a page at a time (keyset on the id).
create or replace function agni_contrib_raw_ids(p_after text default '', p_limit int default 1000)
returns setof text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select id from (
    select install_id as id from agni_dish_submissions where install_id not like 'c1:%'
    union
    select install_id from agni_dish_misses where install_id not like 'c1:%'
  ) ids
  where id > coalesce(p_after, '')
  order by id
  limit greatest(1, least(coalesce(p_limit, 1000), 5000));
$$;

-- Read only. How many rows the map would convert, and how many raw rows
-- already have a hashed twin from the same phone (written after the server
-- change was deployed) and would be merged into it instead.
create or replace function agni_contrib_preview(p_map jsonb)
returns table (tbl text, raw_rows int, merges int)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with m as (select * from agni__contrib_map(p_map))
  select 'submissions',
         count(*)::int,
         count(*) filter (where exists (
           select 1 from agni_dish_submissions t where t.key = s.key and t.install_id = m.hashed))::int
    from agni_dish_submissions s join m on s.install_id = m.raw
  union all
  select 'misses',
         count(*)::int,
         count(*) filter (where exists (
           select 1 from agni_dish_misses t
            where t.key = d.key and t.kind = d.kind and t.install_id = m.hashed))::int
    from agni_dish_misses d join m on d.install_id = m.raw;
$$;

-- Records distinct contributors per dish BEFORE anything changes. Takes the
-- FULL map (all raw ids), so a phone's raw and hashed rows count as one phone
-- whichever chunk later converts them. First write wins: re-running it after a
-- partial conversion cannot overwrite the true "before".
create or replace function agni_contrib_snapshot(p_map jsonb)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count int;
begin
  with m as (select * from agni__contrib_map(p_map)),
  touched as (
    select 'submissions'::text as tbl, s.key, ''::text as kind
      from agni_dish_submissions s join m on s.install_id = m.raw
    union
    select 'misses', d.key, d.kind
      from agni_dish_misses d join m on d.install_id = m.raw
  ),
  counted as (
    select t.tbl, t.key, t.kind,
           (select count(distinct coalesce(m2.hashed, s.install_id))
              from agni_dish_submissions s left join m m2 on m2.raw = s.install_id
             where t.tbl = 'submissions' and s.key = t.key)
         + (select count(distinct coalesce(m2.hashed, d.install_id))
              from agni_dish_misses d left join m m2 on m2.raw = d.install_id
             where t.tbl = 'misses' and d.key = t.key and d.kind = t.kind) as contributors
      from touched t
  )
  insert into agni_dish_contrib_counts_20261031 (tbl, key, kind, contributors_before)
  select tbl, key, kind, contributors from counted
  on conflict (tbl, key, kind) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- The conversion, for the ids in p_map, in ONE transaction (the call). Backs
-- up every row it will change or delete first; a backup that already exists
-- is kept, so the oldest state survives a re-run. Idempotent: ids already
-- converted have no raw rows left and touch nothing.
create or replace function agni_contrib_apply(p_map jsonb)
returns table (tbl text, backed_up int, merged int, converted int)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  b_s int; b_m int; mg_s int; mg_m int; c_s int; c_m int;
begin
  create temporary table if not exists contrib_map (raw text primary key, hashed text not null) on commit drop;
  truncate contrib_map;
  insert into contrib_map select * from agni__contrib_map(p_map) on conflict do nothing;

  -- 1. Backup: the raw rows, and any hashed twin a merge would change.
  insert into agni_dish_contrib_backup_20261031 (row_key, tbl, raw_install_id, hashed, snapshot)
  select 'submissions|' || s.key || '||' || s.install_id, 'submissions', m.raw, m.hashed, to_jsonb(s)
    from agni_dish_submissions s join contrib_map m on s.install_id = m.raw
  union all
  select 'submissions|' || t.key || '||' || t.install_id, 'submissions', m.raw, m.hashed, to_jsonb(t)
    from agni_dish_submissions s join contrib_map m on s.install_id = m.raw
    join agni_dish_submissions t on t.key = s.key and t.install_id = m.hashed
  on conflict (row_key) do nothing;
  get diagnostics b_s = row_count;

  insert into agni_dish_contrib_backup_20261031 (row_key, tbl, raw_install_id, hashed, snapshot)
  select 'misses|' || d.key || '|' || d.kind || '|' || d.install_id, 'misses', m.raw, m.hashed, to_jsonb(d)
    from agni_dish_misses d join contrib_map m on d.install_id = m.raw
  union all
  select 'misses|' || t.key || '|' || t.kind || '|' || t.install_id, 'misses', m.raw, m.hashed, to_jsonb(t)
    from agni_dish_misses d join contrib_map m on d.install_id = m.raw
    join agni_dish_misses t on t.key = d.key and t.kind = d.kind and t.install_id = m.hashed
  on conflict (row_key) do nothing;
  get diagnostics b_m = row_count;

  -- 2. Merges. A raw submission with a hashed twin: the hashed row is newer
  --    (written after the deploy), so it wins and the raw row goes.
  delete from agni_dish_submissions s using contrib_map m, agni_dish_submissions t
   where s.install_id = m.raw and t.key = s.key and t.install_id = m.hashed;
  get diagnostics mg_s = row_count;

  -- A raw miss with a hashed twin: the phone's running total is the larger.
  update agni_dish_misses t set
    times = greatest(t.times, d.times),
    first_seen = least(t.first_seen, d.first_seen),
    last_seen = greatest(t.last_seen, d.last_seen)
    from agni_dish_misses d join contrib_map m on d.install_id = m.raw
   where t.key = d.key and t.kind = d.kind and t.install_id = m.hashed;
  delete from agni_dish_misses d using contrib_map m, agni_dish_misses t
   where d.install_id = m.raw and t.key = d.key and t.kind = d.kind and t.install_id = m.hashed;
  get diagnostics mg_m = row_count;

  -- 3. Everything else converts in place.
  update agni_dish_submissions s set install_id = m.hashed
    from contrib_map m where s.install_id = m.raw;
  get diagnostics c_s = row_count;
  update agni_dish_misses d set install_id = m.hashed
    from contrib_map m where d.install_id = m.raw;
  get diagnostics c_m = row_count;

  return query values ('submissions'::text, b_s, mg_s, c_s), ('misses'::text, b_m, mg_m, c_m);
end;
$$;

-- Read only. Zero raw rows left, and no dish whose distinct-contributor count
-- moved from the snapshot. A non-zero changed_counts means STOP and roll back.
create or replace function agni_contrib_verify()
returns table (check_name text, value int)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select 'raw_submissions_left', (select count(*)::int from agni_dish_submissions where install_id not like 'c1:%')
  union all
  select 'raw_misses_left', (select count(*)::int from agni_dish_misses where install_id not like 'c1:%')
  union all
  select 'changed_counts', (
    select count(*)::int from agni_dish_contrib_counts_20261031 c
     where c.contributors_before <> case c.tbl
       when 'submissions' then (select count(distinct install_id) from agni_dish_submissions s where s.key = c.key)
       else (select count(distinct install_id) from agni_dish_misses d where d.key = c.key and d.kind = c.kind)
     end)
  union all
  select 'backup_rows', (select count(*)::int from agni_dish_contrib_backup_20261031)
  union all
  select 'snapshot_dishes', (select count(*)::int from agni_dish_contrib_counts_20261031);
$$;

-- Puts every backed-up row back exactly as it was: removes the converted and
-- merged rows for each backed-up identity, then re-inserts the snapshots.
-- Leaves the backup in place, so the conversion can be applied again. A row
-- the same phone wrote for the same dish AFTER the conversion is replaced by
-- the snapshot; roll back soon or not at all.
create or replace function agni_contrib_rollback()
returns table (tbl text, removed int, restored int)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r_s int; r_m int; i_s int; i_m int;
begin
  delete from agni_dish_submissions s using agni_dish_contrib_backup_20261031 b
   where b.tbl = 'submissions' and s.key = b.snapshot->>'key'
     and s.install_id in (b.hashed, b.raw_install_id);
  get diagnostics r_s = row_count;
  delete from agni_dish_misses d using agni_dish_contrib_backup_20261031 b
   where b.tbl = 'misses' and d.key = b.snapshot->>'key' and d.kind = b.snapshot->>'kind'
     and d.install_id in (b.hashed, b.raw_install_id);
  get diagnostics r_m = row_count;

  insert into agni_dish_submissions
  select (jsonb_populate_record(null::agni_dish_submissions, b.snapshot)).*
    from agni_dish_contrib_backup_20261031 b where b.tbl = 'submissions';
  get diagnostics i_s = row_count;
  insert into agni_dish_misses
  select (jsonb_populate_record(null::agni_dish_misses, b.snapshot)).*
    from agni_dish_contrib_backup_20261031 b where b.tbl = 'misses';
  get diagnostics i_m = row_count;

  return query values ('submissions'::text, r_s, i_s), ('misses'::text, r_m, i_m);
end;
$$;
