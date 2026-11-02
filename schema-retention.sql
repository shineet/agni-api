-- Retention: how long each server record is kept, and the one function that
-- enforces it. PREPARED 2026-10-31, NOT YET APPLIED TO PRODUCTION AND NOT
-- SCHEDULED. Run after schema-billing.sql and before schema-lockdown.sql.
--
-- Until this runs on a schedule, nothing below is a promise: the privacy
-- policy must not quote these periods before it does. docs/retention.md has
-- the reasoning per table and the scheduling and backup notes.
--
-- TWO KINDS OF RECORD, kept for different reasons:
--
--   OPERATIONAL: usage events, actions, per-day counters, allowance periods,
--   caches, aggregate telemetry, alerts. Kept only as long as the code reads
--   them, plus a margin for support questions and Apple's refund window.
--
--   PURCHASE, RESTORATION, REFUND AND FRAUD: subscription subjects, key links,
--   attest keys, store notifications, device subjects. A subscription subject
--   is kept 400 days after it last ended so a late refund or chargeback still
--   finds it; a restore after that simply recreates it from Apple's signed
--   transaction. Device subjects, key links and attest keys are NOT deleted
--   here: deleting an attest key makes that phone's next request fail with
--   "key is not registered", and the app's recovery from that has not been
--   verified on a device. They wait for that check (docs/retention.md).
--
-- DRY RUN BY DEFAULT. agni_retention_cleanup() only counts; pass false to
-- delete. Every count is returned either way, so a scheduled run leaves a
-- record of what it removed.

create or replace function agni_retention_cleanup(p_dry_run boolean default true)
returns table (record text, rows bigint)
language plpgsql
security definer
as $$
declare
  n bigint;
  -- One place to read every period from.
  usage_days      constant interval := interval '180 days';
  subject_day_keep constant interval := interval '35 days';
  period_keep     constant interval := interval '180 days';
  telemetry_keep  constant interval := interval '400 days';
  budget_keep     constant interval := interval '730 days';
  variant_keep    constant interval := interval '180 days';
  ended_sub_keep  constant interval := interval '400 days';
begin
  -- Usage events: settled or expired only. A row still 'reserved' belongs to
  -- a call in flight or one the stale-reservation sweep has not closed yet.
  select count(*) into n from agni_usage_events
   where status <> 'reserved' and created_at < now() - usage_days;
  if not p_dry_run then
    delete from agni_usage_events where status <> 'reserved' and created_at < now() - usage_days;
  end if;
  record := 'agni_usage_events'; rows := n; return next;

  select count(*) into n from agni_actions where created_at < now() - usage_days;
  if not p_dry_run then delete from agni_actions where created_at < now() - usage_days; end if;
  record := 'agni_actions'; rows := n; return next;

  -- Per-day counters: only today is ever read (the daily photo limit).
  select count(*) into n from agni_subject_days where day < (now() - subject_day_keep)::date;
  if not p_dry_run then delete from agni_subject_days where day < (now() - subject_day_keep)::date; end if;
  record := 'agni_subject_days'; rows := n; return next;

  -- Allowance periods: the current one, and the previous one as a carry
  -- source (agni__carry_source looks back less than a month).
  select count(*) into n from agni_allowance_periods
   where period_end <> 'infinity' and period_end < now() - period_keep;
  if not p_dry_run then
    delete from agni_allowance_periods where period_end <> 'infinity' and period_end < now() - period_keep;
  end if;
  record := 'agni_allowance_periods'; rows := n; return next;

  -- Early-stop records go with the periods they describe.
  select count(*) into n from agni_cost_cap_stops where period_start < now() - period_keep - interval '31 days';
  if not p_dry_run then
    delete from agni_cost_cap_stops where period_start < now() - period_keep - interval '31 days';
  end if;
  record := 'agni_cost_cap_stops'; rows := n; return next;

  -- Aggregates with no identifier of anybody.
  select count(*) into n from agni_auth_events where day < (now() - telemetry_keep)::date;
  if not p_dry_run then delete from agni_auth_events where day < (now() - telemetry_keep)::date; end if;
  record := 'agni_auth_events'; rows := n; return next;

  select count(*) into n from agni_alerts where at < now() - telemetry_keep;
  if not p_dry_run then delete from agni_alerts where at < now() - telemetry_keep; end if;
  record := 'agni_alerts'; rows := n; return next;

  -- The day's ceiling grows from the latest earlier row, so the newest row is
  -- always kept whatever its age.
  select count(*) into n from agni_budget_days
   where day < (now() - budget_keep)::date
     and day < (select max(day) from agni_budget_days);
  if not p_dry_run then
    delete from agni_budget_days
     where day < (now() - budget_keep)::date
       and day < (select max(day) from agni_budget_days);
  end if;
  record := 'agni_budget_days'; rows := n; return next;

  -- Redelivery dedupe needs days; a year covers an annual renewal cycle for
  -- anyone reconciling a refund.
  select count(*) into n from agni_store_notifications where received_at < now() - telemetry_keep;
  if not p_dry_run then delete from agni_store_notifications where received_at < now() - telemetry_keep; end if;
  record := 'agni_store_notifications'; rows := n; return next;

  -- Caches. Research and ingredient rows carry their own expiry and are never
  -- read past it; variant rows have no expiry column at all.
  select count(*) into n from agni_research_cache where expires_at < now();
  if not p_dry_run then delete from agni_research_cache where expires_at < now(); end if;
  record := 'agni_research_cache'; rows := n; return next;

  select count(*) into n from agni_ingredient_evidence where expires_at < now();
  if not p_dry_run then delete from agni_ingredient_evidence where expires_at < now(); end if;
  record := 'agni_ingredient_evidence'; rows := n; return next;

  select count(*) into n from agni_variant_cache where created_at < now() - variant_keep;
  if not p_dry_run then delete from agni_variant_cache where created_at < now() - variant_keep; end if;
  record := 'agni_variant_cache'; rows := n; return next;

  -- Already swept on use; here too so a quiet week still clears them.
  select count(*) into n from agni_attest_challenges where issued_at < now() - interval '1 day';
  if not p_dry_run then delete from agni_attest_challenges where issued_at < now() - interval '1 day'; end if;
  record := 'agni_attest_challenges'; rows := n; return next;

  select count(*) into n from agni_ip_windows where window_start < now() - interval '1 day';
  if not p_dry_run then delete from agni_ip_windows where window_start < now() - interval '1 day'; end if;
  record := 'agni_ip_windows'; rows := n; return next;

  -- Subscriptions that ended (expired past any grace, or revoked) more than
  -- 400 days ago. Their links are cleared first (the device keeps its link
  -- row), then their periods, then the subject. A restore recreates it.
  create temporary table if not exists retention_ended_subs (subject_id text primary key) on commit drop;
  truncate retention_ended_subs;
  insert into retention_ended_subs
    select subject_id from agni_subjects
     where kind = 'subscription'
       and coalesce(revocation_date,
                    greatest(expires_date, coalesce(grace_expires_date, expires_date))) < now() - ended_sub_keep;
  select count(*) into n from retention_ended_subs;
  if not p_dry_run then
    update agni_key_links set subscription_subject = null, subscription_linked_at = null
     where subscription_subject in (select subject_id from retention_ended_subs);
    delete from agni_allowance_periods where subject_id in (select subject_id from retention_ended_subs);
    delete from agni_cost_cap_stops where subject_id in (select subject_id from retention_ended_subs);
    delete from agni_subjects where subject_id in (select subject_id from retention_ended_subs);
  end if;
  record := 'agni_subjects (ended subscriptions)'; rows := n; return next;
end;
$$;

-- MARK: - Beta invitation emails

-- The TestFlight sign-up form kept an email address and name (agni_beta_signups).
-- Proposed: delete them 90 days after launch, or earlier on a verified request.
-- A verified request is handled by hand: the person writes from that address,
-- which is the proof they own it, and the row is deleted. This function only
-- covers the time rule. DRY RUN BY DEFAULT; nothing happens before
-- launch + 90 days whatever the dry-run flag says.
create or replace function agni_beta_signup_cleanup(p_launch_date date, p_dry_run boolean default true)
returns bigint
language plpgsql
security definer
as $$
declare
  n bigint;
begin
  if p_launch_date is null or current_date < p_launch_date + 90 then
    return 0;
  end if;
  select count(*) into n from agni_beta_signups where created_at < now() - interval '90 days';
  if not p_dry_run then
    delete from agni_beta_signups where created_at < now() - interval '90 days';
  end if;
  return n;
end;
$$;

