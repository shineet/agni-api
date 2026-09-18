-- Agni auth verification, second run.
--
-- Two things changed since the first run, both in schema-auth.sql:
--   agni_attest_gate_class now refuses a class it does not meter, instead of
--   silently metering it as research.
--
-- Paste the whole of schema-auth.sql FIRST (it is create-or-replace, safe to
-- re-run), then this.
--
-- Creates one throwaway key, exercises every class, cleans up after itself.

do $$
declare
  r         record;
  ai_before integer; ai_after integer;
  rd_before integer; rd_after integer;
  rs_before integer; rs_after integer;
  summary_rows integer;
begin
  create temp table if not exists agni_verify (check_name text, passed boolean, detail text)
    on commit preserve rows;
  delete from agni_verify;

  insert into agni_attest_keys (key_id, public_key_pem, environment)
  values ('verify-throwaway-key', 'not-a-key', 'development')
  on conflict (key_id) do update set counter = 0,
    minute_count = 0, hour_count = 0, day_count = 0, day_spend_usd = 0,
    read_minute_count = 0, read_day_count = 0,
    research_minute_count = 0, research_day_count = 0, research_day_spend_usd = 0,
    revoked = false;

  select minute_count, read_minute_count, research_minute_count
    into ai_before, rd_before, rs_before
    from agni_attest_keys where key_id = 'verify-throwaway-key';

  -- READ moves the read counters and nothing else. This is the property the
  -- whole design rests on: search must never spend photo estimation's budget.
  select * into r from agni_attest_gate_class('verify-throwaway-key', 1, 'read', 60, 5000);
  insert into agni_verify values ('a read call is allowed', coalesce(r.allowed,false), coalesce(r.reason,''));
  select minute_count, read_minute_count, research_minute_count
    into ai_after, rd_after, rs_after from agni_attest_keys where key_id = 'verify-throwaway-key';
  insert into agni_verify values ('read increments read', rd_after = rd_before + 1,
    format('%s -> %s', rd_before, rd_after));
  insert into agni_verify values ('read leaves AI alone', ai_after = ai_before,
    format('%s -> %s', ai_before, ai_after));
  insert into agni_verify values ('read leaves RESEARCH alone', rs_after = rs_before,
    format('%s -> %s', rs_before, rs_after));

  -- RESEARCH moves the research counters and nothing else.
  select * into r from agni_attest_gate_class('verify-throwaway-key', 2, 'research', 10, 50, 0, 0.5, 5.0);
  insert into agni_verify values ('a research call is allowed', coalesce(r.allowed,false), coalesce(r.reason,''));
  select minute_count, read_minute_count, research_minute_count
    into ai_after, rd_after, rs_after from agni_attest_keys where key_id = 'verify-throwaway-key';
  insert into agni_verify values ('research increments research', rs_after = rs_before + 1,
    format('%s -> %s', rs_before, rs_after));
  insert into agni_verify values ('research leaves AI alone', ai_after = ai_before,
    format('%s -> %s', ai_before, ai_after));
  insert into agni_verify values ('research leaves READ alone', rd_after = rd_before + 1,
    format('still %s', rd_after));

  -- THE BUG THE FIRST RUN FOUND. An unmetered class must be refused, not
  -- quietly charged to research.
  select * into r from agni_attest_gate_class('verify-throwaway-key', 3, 'ai', 10, 100, 0, 1.0, 25.0);
  insert into agni_verify values ('this gate REFUSES an ai class',
    not coalesce(r.allowed, true) and r.reason = 'unknown_class', coalesce(r.reason,''));
  select research_minute_count into rs_after from agni_attest_keys where key_id = 'verify-throwaway-key';
  insert into agni_verify values ('and charges research NOTHING for it',
    rs_after = rs_before + 1, format('still %s', rs_after));

  -- AI IS METERED BY ITS OWN GATE, which was never changed. This is the one
  -- every shipped build actually goes through.
  select minute_count into ai_before from agni_attest_keys where key_id = 'verify-throwaway-key';
  select * into r from agni_attest_gate('verify-throwaway-key', 4, 0, 10, 60, 100, 1.0, 25.0);
  insert into agni_verify values ('an ai call through agni_attest_gate is allowed',
    coalesce(r.allowed,false), coalesce(r.reason,''));
  select minute_count, read_minute_count, research_minute_count
    into ai_after, rd_after, rs_after from agni_attest_keys where key_id = 'verify-throwaway-key';
  insert into agni_verify values ('ai increments the AI counter', ai_after = ai_before + 1,
    format('%s -> %s', ai_before, ai_after));
  insert into agni_verify values ('ai leaves READ alone', rd_after = rd_before + 1, format('still %s', rd_after));
  insert into agni_verify values ('ai leaves RESEARCH alone', rs_after = rs_before + 1, format('still %s', rs_after));

  -- Replay and ceilings.
  select * into r from agni_attest_gate_class('verify-throwaway-key', 4, 'read', 60, 5000);
  insert into agni_verify values ('a replayed counter is refused',
    not coalesce(r.allowed,true), coalesce(r.reason,''));
  select * into r from agni_attest_gate_class('verify-throwaway-key', 5, 'read', 1, 5000);
  insert into agni_verify values ('the per-minute read ceiling refuses',
    not coalesce(r.allowed,true), coalesce(r.reason,''));
  select * into r from agni_attest_gate_class('verify-throwaway-key', 6, 'research', 10, 1, 0, 0.5, 5.0);
  insert into agni_verify values ('the per-day research ceiling refuses',
    not coalesce(r.allowed,true), coalesce(r.reason,''));

  -- Telemetry round trip, on all four auth paths.
  perform agni_auth_record('verify-endpoint', 'attested',    'read',     true,  'verify-build');
  perform agni_auth_record('verify-endpoint', 'legacy',      null,       true,  'verify-build');
  perform agni_auth_record('verify-endpoint', 'development', 'read',     true,  'verify-build');
  perform agni_auth_record('verify-endpoint', 'refused',     null,       false, 'verify-build');
  select count(*) into summary_rows from agni_auth_summary(14) where endpoint = 'verify-endpoint';
  insert into agni_verify values ('telemetry records all four auth paths', summary_rows = 4,
    format('%s row(s)', summary_rows));
  perform agni_auth_record('verify-endpoint', 'attested', 'read', true, 'verify-build');
  select hits into summary_rows from agni_auth_summary(14)
   where endpoint = 'verify-endpoint' and auth_path = 'attested';
  insert into agni_verify values ('and counts a repeat rather than duplicating it',
    summary_rows = 2, format('hits = %s', summary_rows));

  delete from agni_auth_events where endpoint = 'verify-endpoint';
  delete from agni_attest_keys where key_id = 'verify-throwaway-key';
  insert into agni_verify values ('cleaned up after itself',
    not exists (select 1 from agni_attest_keys where key_id = 'verify-throwaway-key'), '');
end $$;

select case when passed then 'PASS' else 'FAIL' end as result, check_name, detail
  from agni_verify order by passed, check_name;
