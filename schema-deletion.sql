-- Server-data deletion, asked for by the person in the app.
-- PREPARED 2026-10-31, NOT YET APPLIED TO PRODUCTION. Run after
-- schema-billing.sql (which adds the device_subject columns) and before
-- schema-lockdown.sql. Spec: Agni repo docs/legal-drafts/deletion-design.md.
--
-- WHO MAY DELETE WHAT is decided in Node (api/_deletion.js), never here and
-- never from anything the client names: the device subject comes from the
-- App Attest key that signed the request, and the subscription subject from
-- that key's link plus a verified Apple transaction. These functions trust
-- their arguments, which is why only the service role can call them.
--
-- WHAT IS ALWAYS KEPT, in both scopes:
--   * this period's allowance counters and today's daily counts: deleting
--     them would reset the allowance and the daily photo limit;
--   * this period's action rows: they make a retried photo free;
--   * open reservations: a call still in flight. Both functions refuse to run
--     while one is open (outcome 'blocked'); the app asks again in a minute;
--   * the Free-sample markers on the device subject: otherwise a deletion
--     would hand out a fresh Free sample;
--   * the App Attest key row and the key's links: deleting the key breaks the
--     phone's next request, and the link is what keeps Pro on;
--   * the subscription subject's Apple transaction fields and the App Store
--     notices for it: needed to restore, to apply refunds and revocations,
--     and to catch one purchase shared across too many devices.
--
-- ROWS WITHOUT A DEVICE (device_subject is null: every subscription usage row
-- written before 2026-10-31) are never assumed to be anybody's. The device
-- scope leaves them alone; only the purchaser's subscription scope removes
-- them, because that scope covers every device on the subscription.
--
-- Both functions return one row per category: outcome 'deleted' or 'kept'
-- (or a single 'blocked' row), the row count, and the reason a kept category
-- was kept, which the app shows as written.

create or replace function agni__deletion_open(p_device_subject text, p_subscription_subject text,
                                               p_whole_subscription boolean)
returns integer
language sql
security definer
as $$
  select count(*)::int from agni_usage_events e
   where e.status = 'reserved'
     and (e.subject_id = p_device_subject
          or (p_subscription_subject is not null and e.subject_id = p_subscription_subject
              and (p_whole_subscription or e.device_subject = p_device_subject)));
$$;

create or replace function agni__deletion_alert(p_scope text, p_counts jsonb)
returns void
language sql
security definer
as $$
  -- Counts only. No subject, key or install id: the log of deletions must not
  -- itself be a record of who asked.
  insert into agni_alerts (kind, detail) values ('deletion', jsonb_build_object('scope', p_scope, 'counts', p_counts));
$$;

-- MARK: - Scope A: this phone

create or replace function agni_delete_device_data(
  p_device_subject       text,
  p_contributors         text[],     -- the raw install id and its c1: hash, computed in Node
  p_subscription_subject text default null
) returns table (category text, outcome text, rows bigint, reason text)
language plpgsql
security definer
as $$
declare
  n bigint;
  open_now integer;
  counts jsonb := '{}'::jsonb;
  today date := (now() at time zone 'utc')::date;
begin
  if p_device_subject is null or p_device_subject not like 'dev:%' then
    raise exception 'agni_delete_device_data: not a device subject';
  end if;

  open_now := agni__deletion_open(p_device_subject, p_subscription_subject, false);
  if open_now > 0 then
    category := 'open_reservations'; outcome := 'blocked'; rows := open_now;
    reason := 'A request from this phone is still being processed.'; return next;
    return;
  end if;

  -- Deleted ------------------------------------------------------------------

  delete from agni_usage_events e where e.subject_id = p_device_subject and e.status <> 'reserved';
  get diagnostics n = row_count;
  category := 'usage_events'; outcome := 'deleted'; rows := n; reason := null; return next;
  counts := counts || jsonb_build_object('usage_events', n);

  delete from agni_actions a
   where a.subject_id = p_device_subject
     and a.period_start not in (select p.period_start from agni_allowance_periods p
                                 where p.subject_id = p_device_subject and p.period_end > now());
  get diagnostics n = row_count;
  category := 'past_actions'; outcome := 'deleted'; rows := n; reason := null; return next;
  counts := counts || jsonb_build_object('past_actions', n);

  delete from agni_allowance_periods p where p.subject_id = p_device_subject and p.period_end <= now();
  get diagnostics n = row_count;
  category := 'past_allowance_periods'; outcome := 'deleted'; rows := n; reason := null; return next;
  counts := counts || jsonb_build_object('past_allowance_periods', n);

  -- Early-stop records (2026-11-02): who the cost safeguard stopped with
  -- credits left, kept only so the operator can restore them.
  delete from agni_cost_cap_stops c where c.subject_id = p_device_subject;
  get diagnostics n = row_count;
  category := 'safeguard_stop_records'; outcome := 'deleted'; rows := n; reason := null; return next;
  counts := counts || jsonb_build_object('safeguard_stop_records', n);

  delete from agni_subject_days d where d.subject_id = p_device_subject and d.day < today;
  get diagnostics n = row_count;
  category := 'past_daily_counts'; outcome := 'deleted'; rows := n; reason := null; return next;
  counts := counts || jsonb_build_object('past_daily_counts', n);

  if p_subscription_subject is not null then
    delete from agni_usage_events e
     where e.subject_id = p_subscription_subject and e.device_subject = p_device_subject
       and e.status <> 'reserved';
    get diagnostics n = row_count;
    category := 'subscription_usage_events_from_this_phone'; outcome := 'deleted'; rows := n; reason := null; return next;
    counts := counts || jsonb_build_object('subscription_usage_events_from_this_phone', n);

    delete from agni_actions a
     where a.subject_id = p_subscription_subject and a.device_subject = p_device_subject
       and a.period_start not in (select p.period_start from agni_allowance_periods p
                                   where p.subject_id = p_subscription_subject and p.period_end > now());
    get diagnostics n = row_count;
    category := 'subscription_past_actions_from_this_phone'; outcome := 'deleted'; rows := n; reason := null; return next;
    counts := counts || jsonb_build_object('subscription_past_actions_from_this_phone', n);
  end if;

  delete from agni_dish_submissions s where s.install_id = any(p_contributors);
  get diagnostics n = row_count;
  category := 'dish_contributions'; outcome := 'deleted'; rows := n; reason := null; return next;
  counts := counts || jsonb_build_object('dish_contributions', n);

  delete from agni_dish_misses m where m.install_id = any(p_contributors);
  get diagnostics n = row_count;
  category := 'missed_dish_reports'; outcome := 'deleted'; rows := n; reason := null; return next;
  counts := counts || jsonb_build_object('missed_dish_reports', n);

  -- Kept ---------------------------------------------------------------------

  select count(*) into n from agni_allowance_periods p
   where p.period_end > now()
     and (p.subject_id = p_device_subject or p.subject_id = p_subscription_subject);
  category := 'current_allowance_counters'; outcome := 'kept'; rows := n;
  reason := 'Counts for this period only. Deleting them would reset your AI allowance.'; return next;

  select count(*) into n from agni_subject_days d
   where d.day = today and (d.subject_id = p_device_subject or d.subject_id = p_subscription_subject);
  category := 'todays_counts'; outcome := 'kept'; rows := n;
  reason := 'Today''s photo count. Deleting it would reset the daily photo limit.'; return next;

  select count(*) into n from agni_actions a
   where (a.subject_id = p_device_subject
          and a.period_start in (select p.period_start from agni_allowance_periods p
                                  where p.subject_id = p_device_subject and p.period_end > now()))
      or (a.subject_id = p_subscription_subject and a.device_subject = p_device_subject
          and a.period_start in (select p.period_start from agni_allowance_periods p
                                  where p.subject_id = p_subscription_subject and p.period_end > now()));
  category := 'current_period_requests'; outcome := 'kept'; rows := n;
  reason := 'This period''s request ids. They stop a retried photo being charged twice.'; return next;

  select count(*) into n from agni_subjects d
   where d.subject_id = p_device_subject and (d.free_photo_exhausted or d.free_search_exhausted);
  category := 'free_sample_used_marker'; outcome := 'kept'; rows := n;
  reason := 'Records that this phone has used its free AI sample, so deleting cannot hand out another.'; return next;

  select count(*) into n from agni_key_links l where l.device_subject = p_device_subject;
  category := 'device_key'; outcome := 'kept'; rows := n;
  reason := 'This phone''s security key (a public key, nothing personal). Agni needs it to accept requests from this phone.'; return next;

  if p_subscription_subject is not null then
    category := 'subscription_purchase_record'; outcome := 'kept'; rows := 1;
    reason := 'Apple''s purchase record for your subscription. Needed to restore it and to apply refunds. Never your name, email or payment details.'; return next;

    select count(*) into n from agni_usage_events e
     where e.subject_id = p_subscription_subject and e.device_subject is null;
    category := 'subscription_history_unattributed'; outcome := 'kept'; rows := n;
    reason := 'Subscription use from before Agni recorded which device made it. It cannot be shown to be this phone''s, so it is kept until it expires. The person who bought the subscription can delete it.'; return next;

    select count(*) into n from agni_usage_events e
     where e.subject_id = p_subscription_subject and e.device_subject is distinct from p_device_subject
       and e.device_subject is not null;
    category := 'subscription_history_other_devices'; outcome := 'kept'; rows := n;
    reason := 'Use of the same subscription from other devices. This phone can only delete its own.'; return next;
  end if;

  perform agni__deletion_alert('device', counts);
end;
$$;

-- MARK: - Scope B: the purchaser's whole subscription history

create or replace function agni_delete_subscription_history(
  p_subscription_subject text,
  p_device_subject       text,
  p_contributors         text[]
) returns table (category text, outcome text, rows bigint, reason text)
language plpgsql
security definer
as $$
declare
  n bigint;
  open_now integer;
  counts jsonb := '{}'::jsonb;
  today date := (now() at time zone 'utc')::date;
  otid text;
begin
  if p_subscription_subject is null or p_subscription_subject !~ '^(sub|sbx):' then
    raise exception 'agni_delete_subscription_history: not a subscription subject';
  end if;
  open_now := agni__deletion_open(p_device_subject, p_subscription_subject, true);
  if open_now > 0 then
    category := 'open_reservations'; outcome := 'blocked'; rows := open_now;
    reason := 'A request on this subscription is still being processed.'; return next;
    return;
  end if;

  -- Everything this phone could delete on its own first, so the counts
  -- include it; that call records its own deletion alert.
  for category, outcome, rows, reason in
    select d.category, d.outcome, d.rows, d.reason
      from agni_delete_device_data(p_device_subject, p_contributors, p_subscription_subject) d
     where d.outcome = 'deleted'
  loop
    return next;
    counts := counts || jsonb_build_object(category, rows);
  end loop;

  delete from agni_usage_events e where e.subject_id = p_subscription_subject and e.status <> 'reserved';
  get diagnostics n = row_count;
  category := 'subscription_usage_events_all_devices'; outcome := 'deleted'; rows := n; reason := null; return next;
  counts := counts || jsonb_build_object('subscription_usage_events_all_devices', n);

  delete from agni_actions a
   where a.subject_id = p_subscription_subject
     and a.period_start not in (select p.period_start from agni_allowance_periods p
                                 where p.subject_id = p_subscription_subject and p.period_end > now());
  get diagnostics n = row_count;
  category := 'subscription_past_actions_all_devices'; outcome := 'deleted'; rows := n; reason := null; return next;
  counts := counts || jsonb_build_object('subscription_past_actions_all_devices', n);

  delete from agni_allowance_periods p where p.subject_id = p_subscription_subject and p.period_end <= now();
  get diagnostics n = row_count;
  category := 'subscription_past_allowance_periods'; outcome := 'deleted'; rows := n; reason := null; return next;
  counts := counts || jsonb_build_object('subscription_past_allowance_periods', n);

  delete from agni_cost_cap_stops c where c.subject_id = p_subscription_subject;
  get diagnostics n = row_count;
  category := 'subscription_safeguard_stop_records'; outcome := 'deleted'; rows := n; reason := null; return next;
  counts := counts || jsonb_build_object('subscription_safeguard_stop_records', n);

  delete from agni_subject_days d where d.subject_id = p_subscription_subject and d.day < today;
  get diagnostics n = row_count;
  category := 'subscription_past_daily_counts'; outcome := 'deleted'; rows := n; reason := null; return next;
  counts := counts || jsonb_build_object('subscription_past_daily_counts', n);

  -- Kept ---------------------------------------------------------------------

  select count(*) into n from agni_allowance_periods p
   where p.period_end > now() and p.subject_id in (p_subscription_subject, p_device_subject);
  category := 'current_allowance_counters'; outcome := 'kept'; rows := n;
  reason := 'Counts for this period only. Deleting them would reset your AI allowance.'; return next;

  select count(*) into n from agni_subject_days d
   where d.day = today and d.subject_id in (p_subscription_subject, p_device_subject);
  category := 'todays_counts'; outcome := 'kept'; rows := n;
  reason := 'Today''s photo count. Deleting it would reset the daily photo limit.'; return next;

  select count(*) into n from agni_actions a
   where a.subject_id in (p_subscription_subject, p_device_subject)
     and a.period_start in (select p.period_start from agni_allowance_periods p
                             where p.subject_id = a.subject_id and p.period_end > now());
  category := 'current_period_requests'; outcome := 'kept'; rows := n;
  reason := 'This period''s request ids. They stop a retried photo being charged twice.'; return next;

  select s.original_transaction_id into otid from agni_subjects s where s.subject_id = p_subscription_subject;
  category := 'subscription_purchase_record'; outcome := 'kept'; rows := 1;
  reason := 'Apple''s purchase record for your subscription. Needed to restore it and to apply refunds. Never your name, email or payment details.'; return next;

  select count(*) into n from agni_store_notifications sn where sn.original_transaction_id = otid;
  category := 'app_store_notices'; outcome := 'kept'; rows := n;
  reason := 'Apple''s notices of renewals, cancellations and refunds for this subscription, kept for the same reason.'; return next;

  select count(*) into n from agni_key_links l
   where l.subscription_subject = p_subscription_subject and l.device_subject <> p_device_subject;
  category := 'other_devices_links'; outcome := 'kept'; rows := n;
  reason := 'Your other devices'' link to the subscription. Removing it would switch Pro off on them.'; return next;

  select count(*) into n from agni_subjects d
   where d.subject_id = p_device_subject and (d.free_photo_exhausted or d.free_search_exhausted);
  category := 'free_sample_used_marker'; outcome := 'kept'; rows := n;
  reason := 'Records that this phone has used its free AI sample, so deleting cannot hand out another.'; return next;

  perform agni__deletion_alert('subscription', counts);
end;
$$;
