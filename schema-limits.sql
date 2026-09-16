-- Agni rate, burst and spend protection. Run once in the Supabase SQL editor,
-- AFTER schema-attest.sql.
--
-- WHY THE COUNTERS LIVE ON THE KEY ROW rather than in a table of their own.
-- Every AI request already reads and writes that row to advance the App Attest
-- replay counter. Putting the windows beside it means the limits cost no extra
-- round trip at all: the write that was already happening does the checking too.
-- A separate events table would be more precise and would add a query per
-- request to a path that already makes three.
--
-- Fixed windows rather than sliding. Sliding needs a row per request; the
-- boundary imprecision is irrelevant at ten a minute.

alter table agni_attest_keys add column if not exists unlimited     boolean not null default false;
alter table agni_attest_keys add column if not exists minute_count  integer not null default 0;
alter table agni_attest_keys add column if not exists minute_start  timestamptz not null default now();
alter table agni_attest_keys add column if not exists hour_count    integer not null default 0;
alter table agni_attest_keys add column if not exists hour_start    timestamptz not null default now();
alter table agni_attest_keys add column if not exists day_count     integer not null default 0;
alter table agni_attest_keys add column if not exists day_start     timestamptz not null default now();
alter table agni_attest_keys add column if not exists day_spend_usd numeric(10,5) not null default 0;

-- Global state: one row, so a bug or an attack cannot produce an open-ended
-- bill overnight even if every per-key limit is somehow satisfied.
create table if not exists agni_service (
  id             integer primary key default 1,
  day_start      timestamptz not null default now(),
  day_spend_usd  numeric(12,5) not null default 0,
  constraint one_row check (id = 1)
);
alter table agni_service enable row level security;
insert into agni_service (id) values (1) on conflict (id) do nothing;

-- ONE CALL replacing agni_attest_claim + agni_attest_lookup.
--
-- Claims the challenge and returns the key in a single round trip. The claim is
-- still single-use and still time-bounded: nothing about replay protection
-- changes, it simply stops being a separate journey to the database.
create or replace function agni_attest_begin(
  p_key_id text, p_nonce text, p_max_age_seconds integer
) returns table (
  claimed boolean, public_key_pem text, counter bigint, environment text,
  free_ai_used integer, revoked boolean, unlimited boolean
)
language plpgsql
security definer
as $$
declare
  rows_claimed integer;
begin
  update agni_attest_challenges
     set used_at = now()
   where nonce = p_nonce
     and used_at is null
     and issued_at > now() - make_interval(secs => p_max_age_seconds);
  get diagnostics rows_claimed = row_count;

  delete from agni_attest_challenges where issued_at < now() - interval '1 day';

  return query
    select (rows_claimed = 1), k.public_key_pem, k.counter, k.environment,
           k.free_ai_used, k.revoked, k.unlimited
      from agni_attest_keys k
     where k.key_id = p_key_id;
end;
$$;

-- ONE CALL replacing agni_attest_advance, and doing the limits in the same
-- write.
--
-- ATOMIC ON PURPOSE. Two requests arriving together must not both pass a limit
-- they jointly exceed, so the row is locked for the duration and every window
-- is rolled, checked and incremented inside one statement.
--
-- `p_previous_cost_usd` is what the LAST call actually cost, reported by
-- Anthropic. Spend is therefore enforced from the next request: it can overshoot
-- by one request and never by a session. Charging an estimate before the answer
-- exists would be the alternative, and it would bill people for failures.
create or replace function agni_attest_gate(
  p_key_id text,
  p_counter bigint,
  p_previous_cost_usd numeric,
  p_per_minute integer,
  p_per_hour integer,
  p_per_day integer,
  p_day_spend_cap numeric,
  p_global_day_cap numeric
) returns table (allowed boolean, reason text, retry_after integer)
language plpgsql
security definer
as $$
declare
  k            agni_attest_keys%rowtype;
  svc          agni_service%rowtype;
  now_ts       timestamptz := now();
begin
  select * into k from agni_attest_keys where key_id = p_key_id for update;
  if k.key_id is null then
    return query select false, 'unknown_key'::text, 0;
    return;
  end if;

  -- REPLAY FIRST, before any limit. A request that cannot prove it is fresh is
  -- not a request, and must not consume anybody's allowance.
  if p_counter <= k.counter then
    return query select false, 'replay'::text, 0;
    return;
  end if;

  -- Roll any window that has expired.
  if now_ts - k.minute_start >= interval '1 minute' then
    k.minute_count := 0; k.minute_start := now_ts;
  end if;
  if now_ts - k.hour_start >= interval '1 hour' then
    k.hour_count := 0; k.hour_start := now_ts;
  end if;
  if now_ts - k.day_start >= interval '1 day' then
    k.day_count := 0; k.day_start := now_ts; k.day_spend_usd := 0;
  end if;

  -- The previous call's real cost lands now, whatever happens next.
  k.day_spend_usd := k.day_spend_usd + coalesce(p_previous_cost_usd, 0);

  select * into svc from agni_service where id = 1 for update;
  if now_ts - svc.day_start >= interval '1 day' then
    update agni_service set day_start = now_ts, day_spend_usd = 0 where id = 1;
    svc.day_spend_usd := 0;
  end if;
  update agni_service
     set day_spend_usd = day_spend_usd + coalesce(p_previous_cost_usd, 0)
   where id = 1
   returning * into svc;

  -- The counter advances regardless of the verdict. A refused request still
  -- presented a valid, fresh assertion, and letting its counter be reused would
  -- reopen the replay window that refusal just closed.
  update agni_attest_keys
     set counter       = p_counter,
         last_seen     = now_ts,
         minute_count  = k.minute_count + 1,
         minute_start  = k.minute_start,
         hour_count    = k.hour_count + 1,
         hour_start    = k.hour_start,
         day_count     = k.day_count + 1,
         day_start     = k.day_start,
         day_spend_usd = k.day_spend_usd
   where key_id = p_key_id;

  -- Testers and anybody deliberately marked unlimited skip every limit, but
  -- their spend is still recorded so the global ceiling still sees it.
  if k.unlimited then
    return query select true, 'unlimited'::text, 0;
    return;
  end if;

  if svc.day_spend_usd >= p_global_day_cap then
    return query select false, 'global_spend'::text, 3600;
    return;
  end if;
  if k.day_spend_usd >= p_day_spend_cap then
    return query select false, 'spend'::text,
      greatest(1, extract(epoch from (k.day_start + interval '1 day' - now_ts))::integer);
    return;
  end if;
  if k.minute_count + 1 > p_per_minute then
    return query select false, 'minute'::text,
      greatest(1, extract(epoch from (k.minute_start + interval '1 minute' - now_ts))::integer);
    return;
  end if;
  if k.hour_count + 1 > p_per_hour then
    return query select false, 'hour'::text,
      greatest(1, extract(epoch from (k.hour_start + interval '1 hour' - now_ts))::integer);
    return;
  end if;
  if k.day_count + 1 > p_per_day then
    return query select false, 'day'::text,
      greatest(1, extract(epoch from (k.day_start + interval '1 day' - now_ts))::integer);
    return;
  end if;

  return query select true, 'ok'::text, 0;
end;
$$;

-- Pre-launch testers keep working without a subscription.
--
-- THIS PROTECTS AN INSTALL, NOT A PERSON. App Attest issues a key per install,
-- so a reinstall or a new phone loses it. See LAUNCH-CHECKLIST.md.
--
--   update agni_attest_keys set unlimited = true, note = 'pre-launch tester'
--    where first_seen < '2026-10-01';
