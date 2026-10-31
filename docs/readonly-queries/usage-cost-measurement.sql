-- READ ONLY. What each AI operation actually costs, from production usage records.
-- Prepared 2026-10-31. NOT RUN. Every statement is a SELECT inside
-- `begin read only; ... rollback;`.
--
-- SOURCES. agni_usage_events: one row per provider call (feature, bucket,
-- model, tier, status, credited, outcome, reserved_usd, actual_usd, tokens,
-- web_searches, action_id). agni_actions: one row per user action and bucket
-- (calls, credited, succeeded).
--
-- LIMITATIONS to state with any result:
--  * Until launch nearly all traffic is tier 'beta' or 'legacy' (testers), with
--    a few 'sandbox' rows; Free/trial/Pro behaviour is not yet observed.
--  * actual_usd is computed by the server from provider usage at the list
--    prices in api/_billing.js; it is not Anthropic's invoice.
--  * Ambiguous outcomes (timeouts) carry their reservation as actual_usd.
--  * Events written before the billing migration (2026-10-31) do not exist.
--  * Small samples: report n beside every percentile.

-- 1. Feature to user operation (from api/_billing.js FEATURES and the app):
--    photo          meal photo (main call and split-plate parts, one action)
--    label          nutrition-label photo (shares the photo bucket)
--    drink_check    small drink check before a photo (counts: false)
--    drink_id       drink identification (photo bucket with an image, search without)
--    variant_search AI dish search             (search)
--    describe       typed dish description     (search)
--    refine         refine an estimate         (search, Pro)
--    breakdown      ingredient breakdown       (search, Pro)
--    research       server-built food research (search; bucket 'web' when retrieve)
--    ingredient     ingredient web lookup      (web; nested web searches inside)
--    companion      Debug-only prototype       (never in Release)

begin read only;

-- 2. Per feature, bucket, model, tier and outcome: last 30 days and all time.
with e as (
  select *, created_at > now() - interval '30 days' as recent from agni_usage_events
)
select case when grouping(recent) = 1 then 'all time' when recent then 'last 30 days' else 'older than 30 days' end as time_window,
       feature, bucket, model, tier, status, outcome, credited,
       count(*)                                                    as n,
       round(sum(actual_usd)::numeric, 4)                          as sum_actual,
       round(avg(actual_usd)::numeric, 5)                          as mean_actual,
       round(percentile_cont(0.5)  within group (order by actual_usd)::numeric, 5) as p50_actual,
       round(percentile_cont(0.9)  within group (order by actual_usd)::numeric, 5) as p90_actual,
       round(percentile_cont(0.99) within group (order by actual_usd)::numeric, 5) as p99_actual,
       round(max(actual_usd)::numeric, 5)                          as max_actual,
       round(avg(reserved_usd)::numeric, 5)                        as mean_reserved,
       round(percentile_cont(0.99) within group (order by reserved_usd)::numeric, 5) as p99_reserved,
       round(max(reserved_usd)::numeric, 5)                        as max_reserved,
       round(avg(input_tokens))                                    as mean_in,
       round(avg(output_tokens))                                   as mean_out,
       round(avg(web_searches), 2)                                 as mean_web_searches
  from e
 group by grouping sets ((recent, feature, bucket, model, tier, status, outcome, credited),
                         (feature, bucket, model, tier, status, outcome, credited))
 order by time_window, feature, tier, model, outcome;

-- 3. Successful credited calls only, per feature (the cost of a unit that
--    worked), last 30 days.
select feature, bucket, count(*) as n,
       round(percentile_cont(0.5)  within group (order by actual_usd)::numeric, 5) as p50,
       round(percentile_cont(0.9)  within group (order by actual_usd)::numeric, 5) as p90,
       round(percentile_cont(0.99) within group (order by actual_usd)::numeric, 5) as p99,
       round(max(actual_usd)::numeric, 5) as max
  from agni_usage_events
 where created_at > now() - interval '30 days' and outcome = 'ok'
 group by feature, bucket order by feature;

-- 4. Failures: how often, and what they cost although no unit was consumed.
select feature, outcome, http_status, count(*) as n,
       round(sum(actual_usd)::numeric, 4) as cost_without_a_unit,
       round(avg(actual_usd)::numeric, 5) as mean_cost
  from agni_usage_events
 where outcome is distinct from 'ok'
 group by feature, outcome, http_status order by n desc;

-- 5. Calls and cost per USER ACTION (retries and split-plate parts), per bucket.
--    Cost per action is what one unit of allowance really costs.
with per_action as (
  select subject_id, action_id, bucket,
         count(*)                                        as calls,
         count(*) filter (where outcome = 'ok')          as ok_calls,
         string_agg(distinct feature, ',')               as features,
         sum(actual_usd)                                 as action_cost,
         bool_or(credited)                               as credited
    from agni_usage_events
   where action_id is not null and created_at > now() - interval '30 days'
   group by subject_id, action_id, bucket
)
select bucket, features, calls, count(*) as actions,
       round(percentile_cont(0.5)  within group (order by action_cost)::numeric, 5) as p50_cost_per_action,
       round(percentile_cont(0.9)  within group (order by action_cost)::numeric, 5) as p90_cost_per_action,
       round(percentile_cont(0.99) within group (order by action_cost)::numeric, 5) as p99_cost_per_action,
       round(max(action_cost)::numeric, 5) as max_cost_per_action,
       count(*) filter (where credited) as credited_actions
  from per_action
 group by bucket, features, calls
 order by bucket, features, calls;

-- 6. The same from agni_actions, as a cross-check of credits against calls.
select bucket, calls, credited, succeeded, count(*) as actions
  from agni_actions
 where created_at > now() - interval '30 days'
 group by bucket, calls, credited, succeeded
 order by bucket, calls;

-- 7. The drink double credit in the wild: photo actions followed within two
--    minutes by a drink_id under a DIFFERENT action id on the same subject.
select count(*) as drink_after_photo_separate_action
  from agni_usage_events p
  join agni_usage_events d
    on d.subject_id = p.subject_id and d.feature = 'drink_id'
   and d.action_id is distinct from p.action_id
   and d.created_at between p.created_at and p.created_at + interval '2 minutes'
 where p.feature = 'photo' and p.outcome = 'ok';

-- 8. Subjects: how many, and the spread of 30-day spend per subject (no ids).
with s as (
  select subject_id, tier, sum(actual_usd) as spend, count(*) as calls
    from agni_usage_events where created_at > now() - interval '30 days'
   group by subject_id, tier
)
select tier, count(*) as subjects,
       round(percentile_cont(0.5) within group (order by spend)::numeric, 4) as p50_spend,
       round(percentile_cont(0.9) within group (order by spend)::numeric, 4) as p90_spend,
       round(max(spend)::numeric, 4) as max_spend,
       max(calls) as max_calls
  from s group by tier order by tier;

rollback;
