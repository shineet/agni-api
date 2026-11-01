-- Agni subscription allowances, server-computed cost and the emergency ceiling.
-- Run once in the Supabase SQL editor, AFTER schema-attest.sql,
-- schema-limits.sql and schema-auth.sql. Safe to re-run: every statement is
-- idempotent.
--
-- WHAT THIS REPLACES. The $25/day global cap in agni_attest_gate added up a
-- cost the APP reported about itself, covered only /api/estimate, and when it
-- tripped it took photo analysis away from everybody, paying or not. Here:
--
--   * the SERVER computes what every provider call cost, from the usage the
--     provider reports, on every paid route;
--   * allowances belong to a durable subject -- a verified App Store
--     subscription, or a device -- not to an App Attest key a reinstall resets;
--   * a conservative cost is RESERVED before the provider is called and
--     reconciled to the real figure afterwards, inside a row lock, so two
--     requests at once cannot both pass a limit they jointly exceed;
--   * the global ceiling is set by the operator, grows only with verified paid
--     subscriptions and only within a bound, and degrades Free first.
--
-- NOTHING HERE STORES A PHOTO, A QUERY OR A MEAL. A usage event is a feature
-- name, a model, token counts, money and an outcome.

-- MARK: - Subjects: who an allowance belongs to

-- subject_id is one of
--   sub:<originalTransactionId>   a verified PRODUCTION App Store subscription
--   sbx:<originalTransactionId>   a verified SANDBOX one (TestFlight, App Review):
--                                 unlocks Pro, metered as tier 'sandbox', never
--                                 a paid subscriber
--   dev:<install id>              one device, for the Free introductory sample
--   legacy:<install id or ip>     a client still on the shared token (testers)
create table if not exists agni_subjects (
  subject_id               text primary key,
  kind                     text not null check (kind in ('subscription', 'device', 'legacy')),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  -- Subscription state, written only from a JWS whose Apple signature verified.
  environment              text,
  product_id               text,
  -- Not unique: Sandbox and Production number their transactions separately,
  -- and the subject id (sub: or sbx:) is what tells them apart.
  original_transaction_id  text,
  transaction_id           text,
  purchase_date            timestamptz,
  original_purchase_date   timestamptz,
  expires_date             timestamptz,
  revocation_date          timestamptz,
  revocation_reason        integer,
  offer_type               integer,
  offer_discount_type      text,
  is_trial                 boolean not null default false,
  grace_expires_date       timestamptz,
  auto_renew               boolean,
  signed_date              timestamptz,
  -- Device state.
  -- DeviceCheck said this device already used its Free sample (bit0 photo, bit1 search).
  free_photo_exhausted     boolean not null default false,
  free_search_exhausted    boolean not null default false,
  devicecheck_checked_at   timestamptz,
  flagged                  text
);
alter table agni_subjects enable row level security;
alter table agni_subjects drop constraint if exists agni_subjects_original_transaction_id_key;
create index if not exists agni_subjects_otid on agni_subjects (original_transaction_id);

-- Which subjects an attested key acts for.
--
-- THE DEVICE LINK NEVER CHANGES once made. A key is one install on one device;
-- letting it move to a fresh device subject would hand out a fresh Free sample
-- per request.
create table if not exists agni_key_links (
  key_id                  text primary key,
  device_subject          text not null references agni_subjects(subject_id),
  subscription_subject    text references agni_subjects(subject_id),
  linked_at               timestamptz not null default now(),
  subscription_linked_at  timestamptz
);
alter table agni_key_links enable row level security;
create index if not exists agni_key_links_subscription on agni_key_links (subscription_subject);

-- MARK: - Allowances

-- One row per subject per allowance period. The period is computed by the
-- server (api/_billing.js periodFor) from verified subscription dates, and is
-- the lifetime of the install for Free.
create table if not exists agni_allowance_periods (
  subject_id         text not null references agni_subjects(subject_id),
  period_start       timestamptz not null,
  period_end         timestamptz not null,
  tier               text not null,
  photo_used         integer not null default 0,
  search_used        integer not null default 0,
  web_used           integer not null default 0,
  -- COMMITTED cost: the reservation while a call is open, the real figure once
  -- it settles. Never less than what was actually spent.
  cost_usd           numeric(12,6) not null default 0,
  open_reservations  integer not null default 0,
  -- The earlier period this one's usage was carried from, when a paid period
  -- began less than a month after the previous one (see agni__carry_source).
  carried_from       timestamptz,
  updated_at         timestamptz not null default now(),
  primary key (subject_id, period_start)
);
alter table agni_allowance_periods enable row level security;
alter table agni_allowance_periods add column if not exists carried_from timestamptz;

-- Per subject per UTC day: the photo burst guard, the cap on calls that use no
-- credit, and the per-day cost cap for beta and legacy subjects.
create table if not exists agni_subject_days (
  subject_id        text not null,
  day               date not null,
  photo_count       integer not null default 0,
  uncredited_count  integer not null default 0,
  cost_usd          numeric(12,6) not null default 0,
  primary key (subject_id, day)
);
alter table agni_subject_days enable row level security;

-- ONE USER ACTION, ONE CREDIT. A photo is a drink check plus an estimate; a
-- search can be a deeper lookup plus a variant call; an automatic retry
-- repeats a call. They all carry the action id of the tap that started them,
-- and the credit is charged once per action and bucket, never per call.
create table if not exists agni_actions (
  subject_id    text not null,
  action_id     text not null,
  bucket        text not null,
  period_start  timestamptz not null,
  calls         integer not null default 0,
  credited      boolean not null default false,
  succeeded     boolean not null default false,
  created_at    timestamptz not null default now(),
  primary key (subject_id, action_id, bucket)
);
alter table agni_actions enable row level security;

-- MARK: - The usage ledger

create table if not exists agni_usage_events (
  subject_id             text not null,
  request_id             text not null,
  action_id              text,
  feature                text not null,
  bucket                 text not null,
  counts                 boolean not null default false,
  tier                   text not null,
  auth_path              text not null,
  model                  text not null,
  period_start           timestamptz not null,
  day                    date not null,
  status                 text not null default 'reserved'
                         check (status in ('reserved', 'settled', 'expired')),
  credited               boolean not null default false,
  outcome                text,
  reserved_usd           numeric(12,6) not null,
  actual_usd             numeric(12,6),
  input_tokens           integer,
  output_tokens          integer,
  cache_read_tokens      integer,
  cache_write_5m_tokens  integer,
  cache_write_1h_tokens  integer,
  web_searches           integer,
  cache_status           text,
  http_status            integer,
  provider_request_id    text,
  created_at             timestamptz not null default now(),
  settled_at             timestamptz,
  primary key (subject_id, request_id)
);
alter table agni_usage_events enable row level security;
-- Device attribution (2026-10-31): see agni_reserve's p_device_subject.
alter table agni_usage_events add column if not exists device_subject text;
alter table agni_actions add column if not exists device_subject text;
create index if not exists agni_usage_events_device on agni_usage_events (subject_id, device_subject);
create index if not exists agni_usage_events_open on agni_usage_events (created_at) where status = 'reserved';
create index if not exists agni_usage_events_day on agni_usage_events (day);

-- MARK: - The emergency ceiling

-- Operator-set. Changing a value here takes effect from the next UTC day, or
-- immediately by updating today's agni_budget_days.ceiling_usd by hand.
create table if not exists agni_budget_config (
  id                        integer primary key default 1 check (id = 1),
  -- The ceiling with no paying subscribers at all.
  base_ceiling_usd          numeric not null default 25,
  -- Added per active, verified, Production, non-trial subscription. About a
  -- day of the paid allowance ($2.50/month is $0.083/day), so paying users
  -- grow the ceiling and nobody else can.
  per_paid_subscriber_usd   numeric not null default 0.10,
  -- Never exceeded without an operator raising it.
  hard_max_ceiling_usd      numeric not null default 150,
  -- The most the ceiling may rise from one day to the next.
  max_daily_growth          numeric not null default 1.5,
  -- Free and legacy AI stop at this share of the ceiling, trial at the next,
  -- paid and beta only at the ceiling itself.
  free_share                numeric not null default 0.5,
  trial_share               numeric not null default 0.8,
  -- The shared-token path's own daily ceiling, while it exists.
  legacy_day_cap_usd        numeric not null default 10,
  -- Sandbox (TestFlight, App Review) has its own daily ceiling. Its spend is
  -- real and counts toward the day's total; it never raises the ceiling.
  sandbox_day_cap_usd       numeric not null default 5,
  -- The voice companion PROTOTYPE: its own daily ceiling across everyone, so
  -- a development feature can never eat into what subscribers pay for.
  companion_day_cap_usd     numeric not null default 2,
  updated_at                timestamptz not null default now()
);
alter table agni_budget_config enable row level security;
alter table agni_budget_config add column if not exists sandbox_day_cap_usd numeric not null default 5;
alter table agni_budget_config add column if not exists companion_day_cap_usd numeric not null default 2;
insert into agni_budget_config (id) values (1) on conflict (id) do nothing;

create table if not exists agni_budget_days (
  day              date primary key,
  ceiling_usd      numeric not null,
  paid_subscribers integer not null default 0,
  free_usd         numeric(12,6) not null default 0,
  trial_usd        numeric(12,6) not null default 0,
  paid_usd         numeric(12,6) not null default 0,
  beta_usd         numeric(12,6) not null default 0,
  legacy_usd       numeric(12,6) not null default 0,
  sandbox_usd      numeric(12,6) not null default 0,
  companion_usd    numeric(12,6) not null default 0,
  alerted_level    integer not null default 0,     -- highest of 50, 80, 100 already alerted
  degraded_tiers   text[] not null default '{}'
);
alter table agni_budget_days enable row level security;
alter table agni_budget_days add column if not exists sandbox_usd numeric(12,6) not null default 0;
alter table agni_budget_days add column if not exists companion_usd numeric(12,6) not null default 0;

create table if not exists agni_alerts (
  id      bigserial primary key,
  at      timestamptz not null default now(),
  kind    text not null,
  detail  jsonb
);
alter table agni_alerts enable row level security;

-- App Store Server Notifications already processed, so a redelivery is a no-op.
create table if not exists agni_store_notifications (
  notification_uuid        text primary key,
  notification_type        text,
  subtype                  text,
  original_transaction_id  text,
  signed_date              timestamptz,
  received_at              timestamptz not null default now()
);
alter table agni_store_notifications enable row level security;

-- Coarse per-IP windows for unauthenticated surfaces: attestation challenges
-- and registration, and the legacy token. The IP is hashed with a server salt
-- before it gets here.
create table if not exists agni_ip_windows (
  bucket        text not null,
  ip_hash       text not null,
  window_start  timestamptz not null default now(),
  count         integer not null default 0,
  primary key (bucket, ip_hash)
);
alter table agni_ip_windows enable row level security;

-- MARK: - Functions

-- Today's budget row, created on first touch with its ceiling fixed for the day.
--
-- GROWTH IS BOUNDED THREE WAYS: only verified Production paid subscriptions
-- raise it, it may not rise more than max_daily_growth over the previous day,
-- and it never passes hard_max_ceiling_usd. Free installs, trials and abuse
-- cannot move it at all.
create or replace function agni__budget_day(p_day date)
returns agni_budget_days
language plpgsql
security definer
as $$
declare
  b     agni_budget_days%rowtype;
  cfg   agni_budget_config%rowtype;
  paid  integer;
  prev  numeric;
  raw   numeric;
begin
  select * into b from agni_budget_days where day = p_day for update;
  if found then return b; end if;

  select * into cfg from agni_budget_config where id = 1;
  select count(*) into paid from agni_subjects
   where kind = 'subscription' and environment = 'Production' and not is_trial
     and revocation_date is null
     and greatest(expires_date, coalesce(grace_expires_date, expires_date)) > now();
  select ceiling_usd into prev from agni_budget_days where day < p_day order by day desc limit 1;

  raw := cfg.base_ceiling_usd + cfg.per_paid_subscriber_usd * paid;
  insert into agni_budget_days (day, ceiling_usd, paid_subscribers)
  values (p_day,
          least(cfg.hard_max_ceiling_usd, raw,
                greatest(cfg.base_ceiling_usd, coalesce(prev, cfg.base_ceiling_usd) * cfg.max_daily_growth)),
          paid)
  on conflict (day) do nothing;

  select * into b from agni_budget_days where day = p_day for update;
  return b;
end;
$$;

-- Closes one open or expired event. The CALLER holds the period row lock.
--
-- Shared by settle and by the sweep, so a reconciled call and an abandoned one
-- follow the same arithmetic and the same credit rules.
create or replace function agni__finish(
  p_subject text, p_request_id text, p_actual numeric, p_success boolean,
  p_outcome text, p_new_status text,
  p_input integer, p_output integer, p_cache_read integer,
  p_cache_w5 integer, p_cache_w1h integer, p_web integer,
  p_cache_status text, p_http_status integer, p_provider_request_id text
) returns boolean   -- true when a user credit was given back
language plpgsql
security definer
as $$
declare
  e         agni_usage_events%rowtype;
  a         agni_actions%rowtype;
  committed numeric;
  delta     numeric;
  heir      text;
  released  boolean := false;
begin
  select * into e from agni_usage_events
   where subject_id = p_subject and request_id = p_request_id for update;
  if not found or e.status = 'settled' then return false; end if;

  committed := case when e.status = 'expired' then e.actual_usd else e.reserved_usd end;
  delta := greatest(0, coalesce(p_actual, 0)) - committed;

  update agni_usage_events
     set status = p_new_status,
         actual_usd = greatest(0, coalesce(p_actual, 0)),
         outcome = p_outcome,
         input_tokens = p_input, output_tokens = p_output,
         cache_read_tokens = p_cache_read,
         cache_write_5m_tokens = p_cache_w5, cache_write_1h_tokens = p_cache_w1h,
         web_searches = p_web, cache_status = p_cache_status,
         http_status = p_http_status, provider_request_id = p_provider_request_id,
         settled_at = now()
   where subject_id = p_subject and request_id = p_request_id;

  update agni_allowance_periods
     set cost_usd = greatest(0, cost_usd + delta),
         open_reservations = greatest(0, open_reservations - (case when e.status = 'reserved' then 1 else 0 end)),
         updated_at = now()
   where subject_id = p_subject and period_start = e.period_start;

  insert into agni_subject_days (subject_id, day) values (p_subject, e.day) on conflict do nothing;
  update agni_subject_days set cost_usd = greatest(0, cost_usd + delta)
   where subject_id = p_subject and day = e.day;

  perform agni__budget_day(e.day);
  update agni_budget_days
     set free_usd   = free_usd   + case when e.tier = 'free'   then delta else 0 end,
         trial_usd  = trial_usd  + case when e.tier = 'trial'  then delta else 0 end,
         paid_usd   = paid_usd   + case when e.tier = 'pro'    then delta else 0 end,
         beta_usd   = beta_usd   + case when e.tier = 'beta'   then delta else 0 end,
         legacy_usd = legacy_usd + case when e.tier = 'legacy' then delta else 0 end,
         sandbox_usd = sandbox_usd + case when e.tier = 'sandbox' then delta else 0 end,
         companion_usd = companion_usd + case when e.tier = 'companion' then delta else 0 end
   where day = e.day;

  -- THE CREDIT IS DECIDED ONCE, when the call first closes. A late settle of an
  -- expired call corrects the money and leaves the allowance alone.
  if e.status <> 'reserved' or e.action_id is null then return false; end if;

  if p_success then
    -- Only a call that COUNTS can make an action a success. A drink check that
    -- worked must not keep the credit for an estimate that then failed.
    if e.counts then
      update agni_actions set succeeded = true
       where subject_id = p_subject and action_id = e.action_id and bucket = e.bucket;
    end if;
    return false;
  end if;

  if not e.credited then return false; end if;

  select * into a from agni_actions
   where subject_id = p_subject and action_id = e.action_id and bucket = e.bucket for update;
  if a.succeeded then return false; end if;

  -- Another call of the same action is still running and may yet succeed: it
  -- inherits the credit rather than the person being charged twice or not at all.
  select request_id into heir from agni_usage_events
   where subject_id = p_subject and action_id = e.action_id and bucket = e.bucket
     and status = 'reserved' and counts and request_id <> p_request_id
   order by created_at limit 1;
  if heir is not null then
    update agni_usage_events set credited = true where subject_id = p_subject and request_id = heir;
    update agni_usage_events set credited = false where subject_id = p_subject and request_id = p_request_id;
    return false;
  end if;

  -- A FAILED ANALYSIS COSTS NO CREDIT. The provider spend above stays recorded.
  update agni_allowance_periods
     set photo_used  = greatest(0, photo_used  - case when e.bucket = 'photo'  then 1 else 0 end),
         search_used = greatest(0, search_used - case when e.bucket = 'search' then 1 else 0 end),
         web_used    = greatest(0, web_used    - case when e.bucket = 'web'    then 1 else 0 end)
   where subject_id = p_subject and period_start = a.period_start;
  if e.bucket = 'photo' then
    update agni_subject_days set photo_count = greatest(0, photo_count - 1)
     where subject_id = p_subject and day = e.day;
  end if;
  update agni_actions set credited = false
   where subject_id = p_subject and action_id = e.action_id and bucket = e.bucket;
  update agni_usage_events set credited = false where subject_id = p_subject and request_id = p_request_id;
  released := true;
  return released;
end;
$$;

-- Where a new PAID period's usage comes from, if anywhere.
--
-- SWITCHING NEVER BUYS A FRESH ALLOWANCE. A paid period that begins less than
-- a month (less a day, for month-end clamping and early renewal charges) after
-- the previous paid period began is not a new month: a refund and repurchase,
-- an immediate upgrade if the group's levels are ever changed, or Sandbox's
-- accelerated renewals. It carries that period's usage and cost forward.
-- Ordinary renewals, crossgrades at renewal and annual sub-periods all begin a
-- full month after the last, so they start fresh. Trial periods are neither a
-- source nor a destination: trial to paid always starts fresh.
create or replace function agni__carry_source(p_subject text, p_start timestamptz, p_tier text)
returns setof agni_allowance_periods
language sql
stable
security definer
as $$
  select * from agni_allowance_periods q
   where p_tier = 'pro' and q.subject_id = p_subject and q.tier = 'pro'
     and q.period_start < p_start
     and p_start < q.period_start + interval '1 month' - interval '1 day'
   order by q.period_start desc
   limit 1;
$$;

-- RESERVE: the one gate in front of every paid provider call.
--
-- Everything is decided inside one transaction holding the period row, the
-- subject's day row and the day's budget row, in that order (settle takes them
-- in the same order, so the two cannot deadlock). Limits are passed in by the
-- server, which reads them from configuration: changing an allowance is an
-- environment variable, not a migration.
--
-- p_tier is what the caller is ENTITLED to (its allowance period's tier);
-- p_budget_tier is what the call is ACCOUNTED as (ledger, day budget,
-- degradation order). They differ only for Sandbox: entitled 'pro', accounted
-- 'sandbox'.
drop function if exists agni_reserve(text, text, text, text, text, text, boolean, text, text, text,
  timestamptz, timestamptz, integer, numeric, numeric, integer, integer, numeric, integer, integer);
-- The 22-argument version, before p_device_subject (2026-10-31). Dropped so
-- the call below cannot be ambiguous between the two.
drop function if exists agni_reserve(text, text, text, text, text, text, boolean, text, text, text,
  timestamptz, timestamptz, integer, numeric, numeric, integer, integer, numeric, integer, integer, text, integer);
create or replace function agni_reserve(
  p_subject              text,
  p_subject_kind         text,
  p_request_id           text,
  p_action_id            text,
  p_feature              text,
  p_bucket               text,      -- photo | search | web
  p_counts               boolean,   -- does this call consume a credit
  p_tier                 text,      -- free | trial | pro | beta | legacy
  p_auth_path            text,
  p_model                text,
  p_period_start         timestamptz,
  p_period_end           timestamptz,
  p_limit                integer,   -- credits in this bucket this period; null = uncounted
  p_cost_cap             numeric,   -- committed cost allowed this period; null = none
  p_day_cost_cap         numeric,   -- committed cost allowed today; null = none
  p_burst                integer,   -- photo credits allowed today; null = none
  p_uncredited_day_cap   integer,   -- calls using no credit allowed today; null = none
  p_reserve_usd          numeric,
  p_max_calls_per_action integer,
  p_stale_seconds        integer,
  p_budget_tier          text default null,
  p_max_open             integer default null,  -- calls in flight per subject; null = none
  -- WHICH DEVICE MADE THE CALL. Pro usage is pooled on the subscription
  -- subject across every device on it; this lets one device delete only its
  -- own history (schema-deletion.sql). Null for legacy callers and for every
  -- row written before 2026-10-31, and never inferred afterwards.
  p_device_subject       text default null
) returns table (allowed boolean, reason text, credited boolean, used integer,
                 lim integer, period_cost numeric, retry_after integer, alert text)
language plpgsql
security definer
as $$
declare
  now_ts       timestamptz := now();
  today        date := (now() at time zone 'utc')::date;
  next_midnight integer := greatest(1, extract(epoch from
                     (((now() at time zone 'utc')::date + 1)::timestamp at time zone 'utc') - now())::integer);
  until_end    integer;
  p            agni_allowance_periods%rowtype;
  d            agni_subject_days%rowtype;
  a            agni_actions%rowtype;
  have_action  boolean := false;
  b            agni_budget_days%rowtype;
  cfg          agni_budget_config%rowtype;
  need_credit  boolean;
  used_now     integer;
  total        numeric;
  share        numeric;
  level        integer;
  alert_text   text := null;
  stale        record;
  bt           text := coalesce(p_budget_tier, p_tier);
begin
  until_end := case when p_period_end = 'infinity'::timestamptz then 0
                    else greatest(1, extract(epoch from (p_period_end - now_ts))::integer) end;

  insert into agni_subjects (subject_id, kind) values (p_subject, p_subject_kind)
  on conflict (subject_id) do nothing;
  insert into agni_allowance_periods (subject_id, period_start, period_end, tier,
                                      photo_used, search_used, web_used, cost_usd, carried_from)
  select p_subject, p_period_start, p_period_end, p_tier,
         coalesce(c.photo_used, 0), coalesce(c.search_used, 0), coalesce(c.web_used, 0),
         coalesce(c.cost_usd, 0), c.period_start
    from (select 1) one
    left join agni__carry_source(p_subject, p_period_start, p_tier) c on true
  on conflict (subject_id, period_start) do nothing;

  select * into p from agni_allowance_periods
   where subject_id = p_subject and period_start = p_period_start for update;

  -- Abandoned calls in this period close at their reservation: the provider
  -- may have billed, so the money stays committed, and the credit comes back
  -- because nobody received an answer.
  for stale in
    select request_id from agni_usage_events
     where subject_id = p_subject and period_start = p_period_start and status = 'reserved'
       and created_at < now_ts - make_interval(secs => p_stale_seconds)
  loop
    perform agni__finish(p_subject, stale.request_id,
      (select reserved_usd from agni_usage_events where subject_id = p_subject and request_id = stale.request_id),
      false, 'ambiguous_expired', 'expired',
      null, null, null, null, null, null, null, null, null);
  end loop;
  select * into p from agni_allowance_periods
   where subject_id = p_subject and period_start = p_period_start;

  -- THE SAME REQUEST TWICE never reaches the provider twice.
  if exists (select 1 from agni_usage_events where subject_id = p_subject and request_id = p_request_id) then
    return query select false,
      (select case when status = 'reserved' then 'in_flight' else 'duplicate' end
         from agni_usage_events where subject_id = p_subject and request_id = p_request_id),
      false, 0, p_limit, p.cost_usd, 5, null::text;
    return;
  end if;

  if p_action_id is not null then
    select * into a from agni_actions
     where subject_id = p_subject and action_id = p_action_id and bucket = p_bucket for update;
    have_action := found;
  end if;

  -- BOUNDED RETRIES. One tap can make a few calls and a few retries, not an
  -- unbounded stream on one credit.
  if have_action and a.calls >= p_max_calls_per_action then
    return query select false, 'action_limit'::text, false, 0, p_limit, p.cost_usd, 0, null::text;
    return;
  end if;

  -- BOUNDED CONCURRENCY. Each open call holds a reservation that the real cost
  -- should not beat; capping how many are open caps how far a misestimate
  -- (a web search's result size is an estimate, not a bound) can carry a
  -- period past its ceiling.
  if p_max_open is not null and p.open_reservations >= p_max_open then
    return query select false, 'busy'::text, false, 0, p_limit, p.cost_usd, 2, null::text;
    return;
  end if;

  need_credit := p_counts and not (have_action and a.credited);
  used_now := case p_bucket when 'photo' then p.photo_used
                            when 'search' then p.search_used
                            when 'web' then p.web_used else 0 end;

  -- An exhausted allowance refuses new credits, and also refuses the free
  -- helper calls in front of them (a drink check before a photo nobody can
  -- analyse would be money spent on a dead end).
  if p_limit is not null and used_now >= p_limit
     and (need_credit or not (have_action and a.credited)) then
    return query select false, 'allowance'::text, false, used_now, p_limit, p.cost_usd, until_end, null::text;
    return;
  end if;

  insert into agni_subject_days (subject_id, day) values (p_subject, today) on conflict do nothing;
  select * into d from agni_subject_days where subject_id = p_subject and day = today for update;

  if need_credit and p_bucket = 'photo' and p_burst is not null and d.photo_count >= p_burst then
    return query select false, 'burst'::text, false, used_now, p_limit, p.cost_usd, next_midnight, null::text;
    return;
  end if;
  if not need_credit and p_uncredited_day_cap is not null and d.uncredited_count >= p_uncredited_day_cap then
    return query select false, 'burst'::text, false, used_now, p_limit, p.cost_usd, next_midnight, null::text;
    return;
  end if;
  if p_cost_cap is not null and p.cost_usd + p_reserve_usd > p_cost_cap then
    -- The cost cap is a safeguard sized above the advertised counts. If it
    -- stops someone with credits left, the operator hears about it (once a
    -- day; no subject in the alert) and can restore them.
    if p_limit is not null and used_now < p_limit and not exists (
         select 1 from agni_alerts where kind = 'cost_cap_before_counts' and at >= date_trunc('day', now_ts)) then
      insert into agni_alerts (kind, detail) values ('cost_cap_before_counts',
        jsonb_build_object('tier', p_tier, 'bucket', p_bucket, 'used', used_now, 'limit', p_limit,
                           'cost_usd', p.cost_usd, 'cap_usd', p_cost_cap));
    end if;
    return query select false, 'budget'::text, false, used_now, p_limit, p.cost_usd, until_end, null::text;
    return;
  end if;
  if p_day_cost_cap is not null and d.cost_usd + p_reserve_usd > p_day_cost_cap then
    return query select false, 'spend'::text, false, used_now, p_limit, p.cost_usd, next_midnight, null::text;
    return;
  end if;

  b := agni__budget_day(today);
  select * into cfg from agni_budget_config where id = 1;
  total := b.free_usd + b.trial_usd + b.paid_usd + b.beta_usd + b.legacy_usd + b.sandbox_usd + b.companion_usd;
  share := case bt when 'free' then cfg.free_share
                   when 'legacy' then cfg.free_share
                   when 'trial' then cfg.trial_share
                   when 'sandbox' then cfg.trial_share
                   when 'companion' then cfg.free_share
                   -- Expressed as a share so pro's limit is hard_max_ceiling_usd.
                   when 'pro' then greatest(1, cfg.hard_max_ceiling_usd / greatest(b.ceiling_usd, 0.000001))
                   else 1 end;

  -- PAYING USERS ARE NOT ROUTINE CASUALTIES OF THE DAILY CEILING. Free,
  -- legacy, trial, Sandbox and the companion stop at their share of the
  -- dynamic ceiling, so they can never use more than trial_share of it. A
  -- Production subscriber ('pro') stops only at hard_max_ceiling_usd: their
  -- own spend is already bounded per period (costCapUSD) and per day (burst),
  -- and they are what the ceiling grows from. An operator can still stop
  -- everyone by lowering hard_max_ceiling_usd.
  if total + p_reserve_usd > b.ceiling_usd * share
     or (bt = 'legacy' and b.legacy_usd + p_reserve_usd > cfg.legacy_day_cap_usd)
     or (bt = 'sandbox' and b.sandbox_usd + p_reserve_usd > cfg.sandbox_day_cap_usd)
     or (bt = 'companion' and b.companion_usd + p_reserve_usd > cfg.companion_day_cap_usd) then
    if not (bt = any(b.degraded_tiers)) then
      update agni_budget_days set degraded_tiers = array_append(degraded_tiers, bt) where day = today;
      insert into agni_alerts (kind, detail) values ('degraded',
        jsonb_build_object('day', today, 'tier', bt, 'total_usd', total, 'ceiling_usd', b.ceiling_usd));
      alert_text := 'degraded:' || bt;
    end if;
    return query select false, 'degraded'::text, false, used_now, p_limit, p.cost_usd, next_midnight, alert_text;
    return;
  end if;

  -- ALLOWED. Everything below is one write, under the locks taken above.
  insert into agni_usage_events (subject_id, request_id, action_id, feature, bucket, counts,
                                 tier, auth_path, model, period_start, day, credited, reserved_usd,
                                 device_subject)
  values (p_subject, p_request_id, p_action_id, p_feature, p_bucket, p_counts,
          bt, p_auth_path, p_model, p_period_start, today, need_credit, p_reserve_usd,
          p_device_subject);

  if p_action_id is not null then
    -- The first call's device owns the action row; a later call on the same
    -- action (a part, a retry) does not move it.
    insert into agni_actions (subject_id, action_id, bucket, period_start, calls, credited, device_subject)
    values (p_subject, p_action_id, p_bucket, p_period_start, 1, need_credit, p_device_subject)
    on conflict (subject_id, action_id, bucket) do update
      set calls = agni_actions.calls + 1,
          credited = agni_actions.credited or excluded.credited,
          period_start = case when excluded.credited then excluded.period_start
                              else agni_actions.period_start end;
  end if;

  update agni_allowance_periods
     set photo_used  = photo_used  + case when need_credit and p_bucket = 'photo'  then 1 else 0 end,
         search_used = search_used + case when need_credit and p_bucket = 'search' then 1 else 0 end,
         web_used    = web_used    + case when need_credit and p_bucket = 'web'    then 1 else 0 end,
         cost_usd = cost_usd + p_reserve_usd,
         open_reservations = open_reservations + 1,
         updated_at = now_ts
   where subject_id = p_subject and period_start = p_period_start;

  update agni_subject_days
     set photo_count = photo_count + case when need_credit and p_bucket = 'photo' then 1 else 0 end,
         uncredited_count = uncredited_count + case when need_credit then 0 else 1 end,
         cost_usd = cost_usd + p_reserve_usd
   where subject_id = p_subject and day = today;

  update agni_budget_days
     set free_usd    = free_usd    + case when bt = 'free'    then p_reserve_usd else 0 end,
         trial_usd   = trial_usd   + case when bt = 'trial'   then p_reserve_usd else 0 end,
         paid_usd    = paid_usd    + case when bt = 'pro'     then p_reserve_usd else 0 end,
         beta_usd    = beta_usd    + case when bt = 'beta'    then p_reserve_usd else 0 end,
         legacy_usd  = legacy_usd  + case when bt = 'legacy'  then p_reserve_usd else 0 end,
         sandbox_usd = sandbox_usd + case when bt = 'sandbox' then p_reserve_usd else 0 end,
         companion_usd = companion_usd + case when bt = 'companion' then p_reserve_usd else 0 end
   where day = today;

  total := total + p_reserve_usd;
  level := case when total >= b.ceiling_usd then 100
                when total >= b.ceiling_usd * 0.8 then 80
                when total >= b.ceiling_usd * 0.5 then 50 else 0 end;
  if level > b.alerted_level then
    update agni_budget_days set alerted_level = level where day = today;
    insert into agni_alerts (kind, detail) values ('ceiling',
      jsonb_build_object('day', today, 'level', level, 'total_usd', total, 'ceiling_usd', b.ceiling_usd));
    alert_text := 'ceiling:' || level;
  end if;

  return query select true, 'ok'::text, need_credit,
    used_now + case when need_credit then 1 else 0 end,
    p_limit, p.cost_usd + p_reserve_usd, 0, alert_text;
end;
$$;

-- SETTLE: replaces a reservation with what the provider says the call cost.
-- Idempotent: settling twice changes nothing the second time.
create or replace function agni_settle(
  p_subject text, p_request_id text, p_actual_usd numeric, p_success boolean,
  p_outcome text,
  p_input integer default null, p_output integer default null,
  p_cache_read integer default null, p_cache_w5 integer default null,
  p_cache_w1h integer default null, p_web integer default null,
  p_cache_status text default null, p_http_status integer default null,
  p_provider_request_id text default null
) returns table (settled boolean, credit_released boolean)
language plpgsql
security definer
as $$
declare
  ps        timestamptz;
  st        text;
  released  boolean;
begin
  select period_start, status into ps, st from agni_usage_events
   where subject_id = p_subject and request_id = p_request_id;
  if ps is null or st = 'settled' then
    return query select false, false;
    return;
  end if;
  perform 1 from agni_allowance_periods
   where subject_id = p_subject and period_start = ps for update;
  released := agni__finish(p_subject, p_request_id, p_actual_usd, p_success, p_outcome, 'settled',
                           p_input, p_output, p_cache_read, p_cache_w5, p_cache_w1h, p_web,
                           p_cache_status, p_http_status, p_provider_request_id);
  return query select true, released;
end;
$$;

-- Closes every abandoned reservation, everywhere. For a scheduled job or the
-- operator; reserve already sweeps the caller's own period on every call.
create or replace function agni_sweep_reservations(p_stale_seconds integer default 120)
returns integer
language plpgsql
security definer
as $$
declare
  r      record;
  closed integer := 0;
begin
  for r in
    select subject_id, request_id, period_start, reserved_usd from agni_usage_events
     where status = 'reserved' and created_at < now() - make_interval(secs => p_stale_seconds)
     order by subject_id, period_start
  loop
    perform 1 from agni_allowance_periods
     where subject_id = r.subject_id and period_start = r.period_start for update;
    perform agni__finish(r.subject_id, r.request_id, r.reserved_usd, false, 'ambiguous_expired',
                         'expired', null, null, null, null, null, null, null, null, null);
    closed := closed + 1;
  end loop;
  return closed;
end;
$$;

-- What the app shows: credits used per bucket this period and photos today.
-- A period not started yet shows what it WILL carry (agni__carry_source), so
-- the app never shows a fresh allowance that the first call would not honour.
drop function if exists agni_allowance_status(text, timestamptz);
create or replace function agni_allowance_status(p_subject text, p_period_start timestamptz,
                                                 p_tier text default null)
returns table (photo_used integer, search_used integer, web_used integer,
               cost_usd numeric, photos_today integer,
               free_photo_exhausted boolean, free_search_exhausted boolean)
language sql
security definer
as $$
  select coalesce(p.photo_used, c.photo_used, 0), coalesce(p.search_used, c.search_used, 0),
         coalesce(p.web_used, c.web_used, 0), coalesce(p.cost_usd, c.cost_usd, 0),
         coalesce((select photo_count from agni_subject_days
                    where subject_id = p_subject and day = (now() at time zone 'utc')::date), 0),
         coalesce((select s.free_photo_exhausted from agni_subjects s where s.subject_id = p_subject), false),
         coalesce((select s.free_search_exhausted from agni_subjects s where s.subject_id = p_subject), false)
    from (select 1) one
    left join agni_allowance_periods p
      on p.subject_id = p_subject and p.period_start = p_period_start
    left join agni__carry_source(p_subject, p_period_start, p_tier) c on p.subject_id is null;
$$;

-- Writes a verified subscription transaction.
--
-- NEVER GOES BACKWARDS. A newer purchase replaces an older one; the same
-- purchase re-signed later (a refund, a revocation) updates it; an OLDER
-- purchase, however recently signed, changes nothing. Without that, a client
-- re-sending last month's transaction could roll back an expiry date, and an
-- App Store notification arriving out of order could undo a refund.
create or replace function agni_subscription_upsert(
  p_original_transaction_id text, p_transaction_id text, p_product_id text,
  p_environment text, p_purchase_date timestamptz, p_original_purchase_date timestamptz,
  p_expires_date timestamptz, p_revocation_date timestamptz, p_revocation_reason integer,
  p_offer_type integer, p_offer_discount_type text, p_is_trial boolean,
  p_grace_expires_date timestamptz, p_auto_renew boolean, p_signed_date timestamptz
) returns table (subject_id text, purchase_date timestamptz, expires_date timestamptz,
                 revocation_date timestamptz, is_trial boolean, product_id text,
                 environment text, grace_expires_date timestamptz, applied boolean)
language plpgsql
security definer
as $$
declare
  -- Production and Sandbox never share a subject.
  sid      text := case when p_environment = 'Production' then 'sub:' else 'sbx:' end
                   || p_original_transaction_id;
  cur      agni_subjects%rowtype;
  apply    boolean;
begin
  insert into agni_subjects (subject_id, kind, original_transaction_id)
  values (sid, 'subscription', p_original_transaction_id)
  on conflict on constraint agni_subjects_pkey do nothing;

  select * into cur from agni_subjects s where s.subject_id = sid for update;
  apply := cur.purchase_date is null
        or p_purchase_date > cur.purchase_date
        or (p_purchase_date = cur.purchase_date
            and (cur.signed_date is null or p_signed_date >= cur.signed_date));

  if apply then
    update agni_subjects s
       set environment = p_environment, product_id = p_product_id,
           transaction_id = p_transaction_id, purchase_date = p_purchase_date,
           original_purchase_date = p_original_purchase_date,
           expires_date = p_expires_date, revocation_date = p_revocation_date,
           revocation_reason = p_revocation_reason, offer_type = p_offer_type,
           offer_discount_type = p_offer_discount_type, is_trial = p_is_trial,
           grace_expires_date = coalesce(p_grace_expires_date, s.grace_expires_date),
           auto_renew = coalesce(p_auto_renew, s.auto_renew),
           signed_date = p_signed_date, updated_at = now()
     where s.subject_id = sid;
  elsif p_grace_expires_date is not null or p_auto_renew is not null then
    -- Renewal information is about the subscription, not one transaction, so
    -- it applies even when the transaction it arrived with is older.
    update agni_subjects s
       set grace_expires_date = coalesce(p_grace_expires_date, s.grace_expires_date),
           auto_renew = coalesce(p_auto_renew, s.auto_renew), updated_at = now()
     where s.subject_id = sid;
  end if;

  return query select s.subject_id, s.purchase_date, s.expires_date, s.revocation_date,
                      s.is_trial, s.product_id, s.environment, s.grace_expires_date, apply
                 from agni_subjects s where s.subject_id = sid;
end;
$$;

-- Ties an attested key to its device subject (once, permanently) and, when a
-- verified subscription is presented, to that subscription.
--
-- A SUBSCRIPTION SHARED TOO WIDELY IS REFUSED, not silently allowed: more than
-- p_max_keys installs in 30 days is a leaked transaction, not a family. The
-- allowance is per subscription anyway, so sharing never multiplies the spend;
-- this stops one leaked JWS becoming a public pool.
create or replace function agni_link_key(
  p_key_id text, p_device_subject text, p_subscription_subject text, p_max_keys integer
) returns table (device_subject text, subscription_subject text, linked boolean, reason text)
language plpgsql
security definer
as $$
declare
  l       agni_key_links%rowtype;
  n       integer;
begin
  insert into agni_subjects (subject_id, kind) values (p_device_subject, 'device')
  on conflict (subject_id) do nothing;
  insert into agni_key_links (key_id, device_subject) values (p_key_id, p_device_subject)
  on conflict (key_id) do nothing;
  select * into l from agni_key_links k where k.key_id = p_key_id for update;

  if p_subscription_subject is null then
    return query select l.device_subject, l.subscription_subject, true, 'ok'::text;
    return;
  end if;

  if l.subscription_subject is distinct from p_subscription_subject then
    select count(*) into n from agni_key_links k
     where k.subscription_subject = p_subscription_subject
       and k.subscription_linked_at > now() - interval '30 days';
    if n >= p_max_keys then
      update agni_subjects set flagged = 'too_many_installs', updated_at = now()
       where agni_subjects.subject_id = p_subscription_subject;
      insert into agni_alerts (kind, detail) values ('subscription_shared',
        jsonb_build_object('subject', p_subscription_subject, 'installs', n));
      return query select l.device_subject, l.subscription_subject, false, 'too_many_installs'::text;
      return;
    end if;
    update agni_key_links k
       set subscription_subject = p_subscription_subject, subscription_linked_at = now()
     where k.key_id = p_key_id;
  end if;

  return query select l.device_subject, p_subscription_subject, true, 'ok'::text;
end;
$$;

-- Everything the server needs to decide a key's tier, in one read.
create or replace function agni_key_context(p_key_id text)
returns table (device_subject text, free_photo_exhausted boolean, free_search_exhausted boolean,
               devicecheck_checked_at timestamptz,
               subscription_subject text, product_id text, environment text,
               purchase_date timestamptz, original_purchase_date timestamptz,
               expires_date timestamptz, revocation_date timestamptz,
               is_trial boolean, grace_expires_date timestamptz)
language sql
security definer
as $$
  select l.device_subject, coalesce(d.free_photo_exhausted, false),
         coalesce(d.free_search_exhausted, false), d.devicecheck_checked_at,
         l.subscription_subject, s.product_id, s.environment,
         s.purchase_date, s.original_purchase_date, s.expires_date, s.revocation_date,
         coalesce(s.is_trial, false), s.grace_expires_date
    from agni_key_links l
    left join agni_subjects d on d.subject_id = l.device_subject
    left join agni_subjects s on s.subject_id = l.subscription_subject
   where l.key_id = p_key_id;
$$;

-- DeviceCheck said this device has used its Free sample already (or we just
-- told DeviceCheck so). An abuse signal, not a ledger: it only ever closes the
-- sample, never reopens it.
create or replace function agni_mark_device(p_subject text, p_photo boolean, p_search boolean)
returns void
language sql
security definer
as $$
  update agni_subjects
     set free_photo_exhausted = free_photo_exhausted or p_photo,
         free_search_exhausted = free_search_exhausted or p_search,
         devicecheck_checked_at = now(), updated_at = now()
   where subject_id = p_subject;
$$;

-- Whether a notification was already applied. Checked BEFORE the write;
-- agni_store_notification_seen records it only AFTER the write succeeded.
create or replace function agni_store_notification_known(p_uuid text)
returns boolean
language sql
stable
security definer
as $$
  select exists (select 1 from agni_store_notifications where notification_uuid = p_uuid);
$$;

-- One App Store notification, once. Returns false for a redelivery.
create or replace function agni_store_notification_seen(
  p_uuid text, p_type text, p_subtype text, p_original_transaction_id text, p_signed_date timestamptz
) returns boolean
language plpgsql
security definer
as $$
declare
  n integer;
begin
  insert into agni_store_notifications (notification_uuid, notification_type, subtype,
                                        original_transaction_id, signed_date)
  values (p_uuid, p_type, p_subtype, p_original_transaction_id, p_signed_date)
  on conflict (notification_uuid) do nothing;
  get diagnostics n = row_count;
  return n = 1;
end;
$$;

-- A fixed window per IP hash. True when the request is inside the limit.
create or replace function agni_ip_window(
  p_bucket text, p_ip_hash text, p_window_seconds integer, p_limit integer
) returns boolean
language plpgsql
security definer
as $$
declare
  c integer;
begin
  insert into agni_ip_windows as w (bucket, ip_hash, window_start, count)
  values (p_bucket, p_ip_hash, now(), 1)
  on conflict (bucket, ip_hash) do update
    set count = case when w.window_start < now() - make_interval(secs => p_window_seconds)
                     then 1 else w.count + 1 end,
        window_start = case when w.window_start < now() - make_interval(secs => p_window_seconds)
                            then now() else w.window_start end
  returning count into c;
  -- Housekeeping, occasionally.
  if random() < 0.01 then
    delete from agni_ip_windows where window_start < now() - interval '1 day';
  end if;
  return c <= p_limit;
end;
$$;

-- MARK: - Operator views

-- Spend per day, tier, feature and model, from the ledger. The number to
-- reconcile against the Anthropic Console's usage page.
-- security_invoker, and no grant to anon or authenticated: a plain view runs
-- as its owner and would read past the ledger's row level security.
create or replace view agni_usage_daily with (security_invoker = true) as
  select day, tier, feature, model,
         count(*)                                   as calls,
         count(*) filter (where outcome = 'ok')     as ok,
         count(*) filter (where status = 'reserved') as open,
         sum(coalesce(actual_usd, reserved_usd))    as cost_usd,
         sum(input_tokens)                          as input_tokens,
         sum(output_tokens)                         as output_tokens,
         sum(cache_read_tokens)                     as cache_read_tokens,
         sum(coalesce(cache_write_5m_tokens, 0) + coalesce(cache_write_1h_tokens, 0)) as cache_write_tokens,
         sum(web_searches)                          as web_searches,
         count(*) filter (where cache_status = 'hit') as prompt_cache_hits
    from agni_usage_events
   group by day, tier, feature, model;

-- MARK: - Shared research cache

-- What a model said a FOOD is, keyed by the normalised words and nothing else.
-- Same rules as agni_ingredient_evidence: no column for a person, no meal, no
-- install. A hit costs nothing and uses no credit.
create table if not exists agni_research_cache (
  key         text primary key,
  payload     jsonb not null,
  hits        integer not null default 0,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);
alter table agni_research_cache enable row level security;

create or replace function agni_research_cache_get(p_key text)
returns jsonb
language plpgsql
security definer
as $$
declare
  found_payload jsonb;
begin
  update agni_research_cache set hits = hits + 1
   where key = p_key and expires_at > now()
   returning payload into found_payload;
  return found_payload;
end;
$$;

create or replace function agni_research_cache_put(p_key text, p_payload jsonb, p_ttl_seconds integer)
returns void
language sql
security definer
as $$
  insert into agni_research_cache (key, payload, expires_at)
  values (p_key, p_payload, now() + make_interval(secs => p_ttl_seconds))
  on conflict (key) do update
    set payload = excluded.payload, expires_at = excluded.expires_at, created_at = now();
$$;

-- MARK: - One read per request

-- Links a key to its device subject if it is not linked yet (never re-links),
-- and returns everything needed to decide its tier. One round trip.
create or replace function agni_caller(p_key_id text, p_device_subject text)
returns table (device_subject text, free_photo_exhausted boolean, free_search_exhausted boolean,
               devicecheck_checked_at timestamptz,
               subscription_subject text, product_id text, environment text,
               purchase_date timestamptz, original_purchase_date timestamptz,
               expires_date timestamptz, revocation_date timestamptz,
               is_trial boolean, grace_expires_date timestamptz)
language plpgsql
security definer
as $$
begin
  if not exists (select 1 from agni_key_links k where k.key_id = p_key_id) then
    insert into agni_subjects (subject_id, kind) values (p_device_subject, 'device')
    on conflict (subject_id) do nothing;
    insert into agni_key_links (key_id, device_subject) values (p_key_id, p_device_subject)
    on conflict (key_id) do nothing;
  end if;
  return query select * from agni_key_context(p_key_id);
end;
$$;

-- MARK: - Who may call these

-- ONLY THE SERVER. Postgres grants EXECUTE on new functions to PUBLIC, and
-- Supabase exposes public functions over its REST API to the anon and
-- authenticated roles. The anon key is not in the app, but a ledger that
-- moves money must not depend on that: every billing function here is
-- callable by service_role alone.
do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('agni__budget_day', 'agni__finish', 'agni__carry_source', 'agni_reserve',
                         'agni_settle', 'agni_sweep_reservations', 'agni_allowance_status',
                         'agni_subscription_upsert', 'agni_link_key', 'agni_key_context',
                         'agni_mark_device', 'agni_store_notification_known',
                         'agni_store_notification_seen', 'agni_ip_window',
                         'agni_research_cache_get', 'agni_research_cache_put', 'agni_caller')
  loop
    execute format('revoke execute on function %s from public', f.sig);
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke execute on function %s from anon', f.sig);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke execute on function %s from authenticated', f.sig);
    end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function %s to service_role', f.sig);
    end if;
  end loop;
end;
$$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on agni_usage_daily from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on agni_usage_daily from authenticated';
  end if;
end;
$$;
