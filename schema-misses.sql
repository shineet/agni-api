-- What Agni did not know. Run once in the Agni Supabase project.
--
-- Every phone is already keeping this list locally: the dishes a photo could
-- not match, the searches that came back empty, the barcodes with nothing
-- behind them, and the strongest signal of all, a dish somebody looked at their
-- own plate and NAMED that the table had no entry for. None of it reaches
-- anyone, so the one question worth answering, "what should be added next",
-- is still being answered by guessing.
--
-- Different from agni_dish_submissions in one important way. That table is
-- republished to strangers, so it needs two independent submitters before
-- anything is shown. This one is read only by Shine, deciding what to build,
-- and its whole value is the LONG TAIL: a dish one person wanted is exactly the
-- kind of thing a curated table misses. So single reports are kept, and the
-- install count is surfaced instead so the list can be ordered by how many
-- people wanted a thing rather than how loudly one person did.
--
-- It holds dish names and an anonymous install id. No account, no email,
-- nothing that says who anybody is.

create table if not exists agni_dish_misses (
  key         text        not null,   -- normalised, matching DishDatabase.normalise
  name        text        not null,   -- as typed or as the model said it
  kind        text        not null,   -- photoNotAnchored | searchFoundNothing | barcodeNotFound | namedByYou
  install_id  text        not null,
  times       integer     not null default 1,
  first_seen  timestamptz not null default now(),
  last_seen   timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- One row per dish per kind per phone. The phone sends its running count, so
  -- re-sending the same list is idempotent rather than additive: an upload that
  -- happens twice must not double what it reports.
  primary key (key, kind, install_id)
);

create index if not exists agni_dish_misses_key_idx on agni_dish_misses (key);

alter table agni_dish_misses enable row level security;

-- The backlog, most wanted first.
--
--   select * from agni_missing_dishes limit 50;
create or replace view agni_missing_dishes as
  select
    m.key,
    mode() within group (order by m.name)      as name,
    count(distinct m.install_id)::int          as people,
    sum(m.times)::int                          as times,
    -- Named by a person beats anything a model or a search produced, so it is
    -- worth seeing at a glance which kind of miss this mostly is.
    mode() within group (order by m.kind)      as mostly,
    bool_or(m.kind = 'namedByYou')             as someone_named_it,
    max(m.last_seen)                           as last_seen
  from agni_dish_misses m
  group by m.key;

create or replace function agni_report_miss(
  p_install_id text,
  p_key        text,
  p_name       text,
  p_kind       text,
  p_times      integer,
  p_first_seen timestamptz,
  p_last_seen  timestamptz
) returns void
language plpgsql
security definer
as $$
begin
  -- A name is a dish, not a sentence somebody wrote to themselves.
  if p_key is null or length(p_key) < 3 or length(p_key) > 60 then return; end if;
  if p_install_id is null or length(p_install_id) < 8 then return; end if;
  if p_kind not in ('photoNotAnchored', 'searchFoundNothing',
                    'barcodeNotFound', 'namedByYou') then return; end if;

  insert into agni_dish_misses as d
    (key, name, kind, install_id, times, first_seen, last_seen)
  values
    (p_key, p_name, p_kind, p_install_id,
     greatest(coalesce(p_times, 1), 1),
     coalesce(p_first_seen, now()), coalesce(p_last_seen, now()))
  on conflict (key, kind, install_id) do update set
    name = excluded.name,
    -- The phone's running total REPLACES what is stored rather than adding to
    -- it. Adding would make an upload that ran twice look like twice the
    -- interest, which is the one thing this list must not get wrong.
    times = greatest(excluded.times, d.times),
    last_seen = greatest(excluded.last_seen, d.last_seen),
    updated_at = now();
end;
$$;
