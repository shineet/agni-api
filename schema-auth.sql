-- Metering classes, and the evidence for retiring the legacy token.
--
-- TWO PROBLEMS, ONE FILE.
--
-- 1. agni_attest_gate counts every call it sees against the per-minute,
--    per-hour and per-day AI limits. Routing a dish search through it would
--    burn the ten-per-minute allowance during one session of typing and the
--    next photograph would be refused. Cheap reads need their own counters.
--
-- 2. The legacy shared token cannot be switched off responsibly without knowing
--    who is still using it, on which endpoint. Counting that is the difference
--    between a decision and a guess.

-- MARK: - Per-class counters

-- Added to the existing key table rather than a new one, so a class check and
-- the replay check are the same row lock. Defaulted, so this migration is safe
-- to run against live data: every existing key simply starts at zero.
alter table agni_attest_keys add column if not exists read_minute_count integer not null default 0;
alter table agni_attest_keys add column if not exists read_minute_start timestamptz not null default now();
alter table agni_attest_keys add column if not exists read_day_count integer not null default 0;
alter table agni_attest_keys add column if not exists read_day_start timestamptz not null default now();
alter table agni_attest_keys add column if not exists research_minute_count integer not null default 0;
alter table agni_attest_keys add column if not exists research_minute_start timestamptz not null default now();
alter table agni_attest_keys add column if not exists research_day_count integer not null default 0;
alter table agni_attest_keys add column if not exists research_day_start timestamptz not null default now();
alter table agni_attest_keys add column if not exists research_day_spend_usd numeric not null default 0;

-- Service-wide research spend, kept apart from the AI ceiling on purpose: a
-- runaway resolver must not be able to spend the estimation budget.
alter table agni_service add column if not exists research_day_spend_usd numeric not null default 0;
alter table agni_service add column if not exists research_day_start timestamptz not null default now();

-- The gate for everything that is not an AI call.
--
-- SHARES THE REPLAY COUNTER with agni_attest_gate, deliberately. The counter is
-- a freshness check on the device rather than an allowance, and giving each
-- class its own would reopen the replay window between them: an assertion spent
-- on a read could then be replayed onto an AI call.
create or replace function agni_attest_gate_class(
  p_key_id            text,
  p_counter           bigint,
  p_class             text,
  p_per_minute        integer,
  p_per_day           integer,
  p_previous_cost_usd numeric default 0,
  p_day_spend_cap     numeric default 0,
  p_global_day_cap    numeric default 0
) returns table (allowed boolean, reason text, retry_after integer)
language plpgsql
security definer
as $$
declare
  k       agni_attest_keys%rowtype;
  svc     agni_service%rowtype;
  now_ts  timestamptz := now();
  m_count integer;
  m_start timestamptz;
  d_count integer;
  d_start timestamptz;
  d_spend numeric;
begin
  select * into k from agni_attest_keys where key_id = p_key_id for update;
  if k.key_id is null then
    return query select false, 'unknown_key'::text, 0;
    return;
  end if;

  -- Replay first, before any allowance. A request that cannot prove it is fresh
  -- is not a request and must not consume anybody's budget.
  if p_counter <= k.counter then
    return query select false, 'replay'::text, 0;
    return;
  end if;

  if p_class = 'read' then
    m_count := k.read_minute_count; m_start := k.read_minute_start;
    d_count := k.read_day_count;    d_start := k.read_day_start;
    d_spend := 0;
  else
    m_count := k.research_minute_count; m_start := k.research_minute_start;
    d_count := k.research_day_count;    d_start := k.research_day_start;
    d_spend := k.research_day_spend_usd;
  end if;

  if now_ts - m_start >= interval '1 minute' then m_count := 0; m_start := now_ts; end if;
  if now_ts - d_start >= interval '1 day'    then d_count := 0; d_start := now_ts; d_spend := 0; end if;

  d_spend := d_spend + coalesce(p_previous_cost_usd, 0);

  -- The counter advances whatever the verdict, exactly as the AI gate does: a
  -- refused request still presented a valid, fresh assertion, and letting it be
  -- reused would reopen the window the refusal just closed.
  if p_class = 'read' then
    update agni_attest_keys
       set counter = p_counter, last_seen = now_ts,
           read_minute_count = m_count + 1, read_minute_start = m_start,
           read_day_count = d_count + 1,    read_day_start = d_start
     where key_id = p_key_id;
  else
    update agni_attest_keys
       set counter = p_counter, last_seen = now_ts,
           research_minute_count = m_count + 1, research_minute_start = m_start,
           research_day_count = d_count + 1,    research_day_start = d_start,
           research_day_spend_usd = d_spend
     where key_id = p_key_id;

    select * into svc from agni_service where id = 1 for update;
    if now_ts - svc.research_day_start >= interval '1 day' then
      update agni_service set research_day_start = now_ts, research_day_spend_usd = 0 where id = 1;
      svc.research_day_spend_usd := 0;
    end if;
    update agni_service
       set research_day_spend_usd = research_day_spend_usd + coalesce(p_previous_cost_usd, 0)
     where id = 1
     returning * into svc;

    if p_global_day_cap > 0 and svc.research_day_spend_usd >= p_global_day_cap then
      return query select false, 'global_spend'::text, 3600;
      return;
    end if;
    if p_day_spend_cap > 0 and d_spend >= p_day_spend_cap then
      return query select false, 'spend'::text,
        greatest(1, extract(epoch from (d_start + interval '1 day' - now_ts))::integer);
      return;
    end if;
  end if;

  if k.unlimited then
    return query select true, 'unlimited'::text, 0;
    return;
  end if;
  if m_count + 1 > p_per_minute then
    return query select false, 'minute'::text,
      greatest(1, extract(epoch from (m_start + interval '1 minute' - now_ts))::integer);
    return;
  end if;
  if d_count + 1 > p_per_day then
    return query select false, 'day'::text,
      greatest(1, extract(epoch from (d_start + interval '1 day' - now_ts))::integer);
    return;
  end if;

  return query select true, 'ok'::text, 0;
end;
$$;

-- MARK: - Telemetry
--
-- COUNTS ONLY. No query text, no install id, no key id, nothing that says who
-- anybody is or what they searched for. The question this answers is narrow:
-- how much traffic is still arriving on the legacy token, on which endpoint,
-- from which build. That is all it is allowed to know.

create table if not exists agni_auth_events (
  day         date    not null default current_date,
  endpoint    text    not null,
  auth_path   text    not null,   -- attested | legacy | development | refused
  meter_class text,               -- ai | read | research
  allowed     boolean not null,
  build       text,
  hits        bigint  not null default 0,
  primary key (day, endpoint, auth_path, meter_class, allowed, build)
);

alter table agni_auth_events enable row level security;

create or replace function agni_auth_record(
  p_endpoint    text,
  p_auth_path   text,
  p_meter_class text,
  p_allowed     boolean,
  p_build       text
) returns void
language sql
security definer
as $$
  insert into agni_auth_events as e (day, endpoint, auth_path, meter_class, allowed, build, hits)
  values (current_date, p_endpoint, p_auth_path, coalesce(p_meter_class, ''), p_allowed,
          coalesce(p_build, ''), 1)
  on conflict (day, endpoint, auth_path, meter_class, allowed, build)
  do update set hits = e.hits + 1;
$$;

-- The question, answered in one read: is it safe to switch the legacy token off.
create or replace function agni_auth_summary(p_days integer default 14)
returns table (
  day          date,
  endpoint     text,
  auth_path    text,
  meter_class  text,
  allowed      boolean,
  build        text,
  hits         bigint
) language sql security definer as $$
  select day, endpoint, auth_path, meter_class, allowed, build, hits
    from agni_auth_events
   where day >= current_date - p_days
   order by day desc, hits desc;
$$;
