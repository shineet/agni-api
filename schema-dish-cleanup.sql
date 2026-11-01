-- Removing self-test dishes from the shared dish table. PREPARED 2026-10-31,
-- NOT APPLIED TO PRODUCTION, NOT RUN. Run after schema-community.sql and before
-- schema-lockdown.sql. Driven by POST /api/quota?op=test-dish-cleanup
-- (api/_dish-cleanup.js); proposal and evidence in
-- docs/readonly-queries/test-dish-cleanup-proposal.md.
--
-- EXACT ROWS ONLY. Every function takes an explicit list of (key, install_id)
-- pairs and matches them by equality: no wildcard, no pattern, no dish name.
-- Node expands each pair to both forms a row may hold (the raw install id and
-- its c1: contributor hash), so the list works before or after the
-- contributor conversion. The salt never comes here.
--
-- PUBLICATION is what agni_community_dishes decides: a key is offered to
-- people once it has at least two submission rows.
--
-- BACKUP. apply copies every row it will delete into
-- agni_dish_cleanup_backup_20261031 in the same transaction. rollback puts
-- them back. Drop the table 7 days after a clean verify (runbook in the
-- proposal); until then it holds contributor values, so it is locked down like
-- every agni table.

create table if not exists agni_dish_cleanup_backup_20261031 (
  key             text        not null,
  name            text        not null,
  install_id      text        not null,
  unit            text        not null,
  grams_per_unit  numeric,
  kcal            numeric,
  protein_g       numeric,
  carbs_g         numeric,
  fat_g           numeric,
  created_at      timestamptz,
  updated_at      timestamptz,
  backed_up_at    timestamptz not null default now(),
  primary key (key, install_id)
);
alter table agni_dish_cleanup_backup_20261031 enable row level security;

create or replace function agni__dish_pairs(p_pairs jsonb)
returns table (key text, install_id text)
language sql
immutable
as $$
  select distinct p->>'key', p->>'install_id'
    from jsonb_array_elements(coalesce(p_pairs, '[]'::jsonb)) p
   where coalesce(p->>'key', '') <> '' and length(coalesce(p->>'install_id', '')) >= 8;
$$;

-- What would happen, per key: rows matched, contributors now and after, and
-- whether the key is offered to people now and after. No install id returned.
create or replace function agni_dish_cleanup_preview(p_pairs jsonb)
returns table (key text, matched integer, contributors_now integer, contributors_after integer,
               published_now boolean, published_after boolean)
language sql
security definer
as $$
  with pairs as (select * from agni__dish_pairs(p_pairs)),
  hit as (
    select s.key, count(*)::int as matched
      from agni_dish_submissions s join pairs p on p.key = s.key and p.install_id = s.install_id
     group by s.key
  ),
  totals as (
    select s.key, count(*)::int as n from agni_dish_submissions s where s.key in (select h.key from hit h) group by s.key
  )
  select h.key, h.matched, t.n, t.n - h.matched, t.n >= 2, (t.n - h.matched) >= 2
    from hit h join totals t using (key)
   order by h.key;
$$;

create or replace function agni_dish_cleanup_apply(p_pairs jsonb)
returns table (backed_up bigint, deleted bigint, keys_unpublished bigint)
language plpgsql
security definer
as $$
declare
  b bigint;
  d bigint;
  u bigint;
  published_before text[];
begin
  select coalesce(array_agg(c.key), '{}') into published_before
    from (select s.key from agni_dish_submissions s
           where s.key in (select key from agni__dish_pairs(p_pairs))
           group by s.key having count(*) >= 2) c;

  insert into agni_dish_cleanup_backup_20261031
    (key, name, install_id, unit, grams_per_unit, kcal, protein_g, carbs_g, fat_g, created_at, updated_at)
  select s.key, s.name, s.install_id, s.unit, s.grams_per_unit, s.kcal, s.protein_g, s.carbs_g, s.fat_g,
         s.created_at, s.updated_at
    from agni_dish_submissions s
    join agni__dish_pairs(p_pairs) p on p.key = s.key and p.install_id = s.install_id
  on conflict (key, install_id) do nothing;
  get diagnostics b = row_count;

  delete from agni_dish_submissions s
   using agni__dish_pairs(p_pairs) p
   where p.key = s.key and p.install_id = s.install_id;
  get diagnostics d = row_count;

  select count(*) into u from unnest(published_before) k
   where (select count(*) from agni_dish_submissions s where s.key = k) < 2;

  return query select b, d, u;
end;
$$;

-- After apply: matched rows still present (must be 0), backup size, and the
-- keys that are no longer offered to people.
create or replace function agni_dish_cleanup_verify(p_pairs jsonb)
returns table (remaining bigint, in_backup bigint, unpublished_keys text[])
language sql
security definer
as $$
  select
    (select count(*) from agni_dish_submissions s
       join agni__dish_pairs(p_pairs) p on p.key = s.key and p.install_id = s.install_id),
    (select count(*) from agni_dish_cleanup_backup_20261031),
    (select coalesce(array_agg(distinct b.key order by b.key), '{}')
       from agni_dish_cleanup_backup_20261031 b
      where (select count(*) from agni_dish_submissions s where s.key = b.key) < 2);
$$;

-- Puts every backed-up row back. A row someone has since re-submitted is left
-- as they wrote it.
create or replace function agni_dish_cleanup_rollback()
returns bigint
language plpgsql
security definer
as $$
declare
  n bigint;
begin
  insert into agni_dish_submissions
    (key, name, install_id, unit, grams_per_unit, kcal, protein_g, carbs_g, fat_g, created_at, updated_at)
  select key, name, install_id, unit, grams_per_unit, kcal, protein_g, carbs_g, fat_g, created_at, updated_at
    from agni_dish_cleanup_backup_20261031
  on conflict (key, install_id) do nothing;
  get diagnostics n = row_count;
  return n;
end;
$$;
