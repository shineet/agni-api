-- Tests agni_attest_gate against the real database. Run in the Supabase SQL
-- editor AFTER schema-limits.sql.
--
-- WHY THIS IS A SCRIPT AND NOT PART OF `npm test`: the gate is PL/pgSQL, and
-- there is no Postgres available where the suite runs. Modelling its logic in
-- JavaScript and testing that would prove only that the model agrees with
-- itself. This exercises the function that actually runs.
--
-- Every check raises an exception on failure, so the script either prints
-- "ALL GATE TESTS PASSED" or stops at the first thing that is wrong.
--
-- It creates and deletes its own key. It touches nothing else, and it restores
-- the global counter it borrows.

-- A TABLE, NOT A NOTICE.
--
-- The first version of this signalled success with `raise notice`, which the
-- Supabase SQL editor does not display: a complete pass and a block that did
-- nothing at all both read as "Success. No rows returned". A test whose pass
-- looks identical to its absence is not a test.
--
-- Now the block records its verdict in a temp table as its last act, and the
-- select at the bottom shows it. If any check raises, the insert never happens
-- and you get NO ROW, which is unmistakably different from one row saying it
-- passed.
drop table if exists agni_gate_test_result;
create temp table agni_gate_test_result (result text, checks_run integer, at timestamptz);

do $$
declare
  checks     integer := 0;
  k          text := 'TEST-GATE-KEY-DO-NOT-USE';
  r          record;
  n          bigint := 0;
  saved_spend numeric;
  saved_start timestamptz;
begin
  -- Borrow and restore the global row, so a test cannot leave the service
  -- looking like it has spent money it has not.
  select day_spend_usd, day_start into saved_spend, saved_start from agni_service where id = 1;
  update agni_service set day_spend_usd = 0, day_start = now() where id = 1;

  delete from agni_attest_keys where key_id = k;
  insert into agni_attest_keys (key_id, public_key_pem, environment)
  values (k, 'test', 'development');

  -- 1. REPLAY. A counter that does not advance is refused, and refused as a
  --    verification problem rather than as a limit.
  n := 1;
  select * into r from agni_attest_gate(k, n, 0, 10, 60, 100, 1.0, 25.0);
  if not r.allowed then raise exception 'first request should pass, got %', r.reason; end if;
  select * into r from agni_attest_gate(k, n, 0, 10, 60, 100, 1.0, 25.0);
  if r.allowed or r.reason <> 'replay' then
    raise exception 'a repeated counter must be refused as replay, got % %', r.allowed, r.reason;
  end if;

  checks := checks + 1;

  -- 2. THE COUNTER ADVANCES EVEN WHEN A REQUEST IS REFUSED. A refused request
  --    still presented a fresh assertion; letting its counter be reused would
  --    reopen the replay window the refusal just closed.
  update agni_attest_keys set minute_count = 10, minute_start = now() where key_id = k;
  n := 2;
  select * into r from agni_attest_gate(k, n, 0, 10, 60, 100, 1.0, 25.0);
  if r.allowed or r.reason <> 'minute' then
    raise exception 'the eleventh call in a minute must be refused, got %', r.reason;
  end if;
  if (select counter from agni_attest_keys where key_id = k) <> 2 then
    raise exception 'the counter must advance even on a refusal';
  end if;
  if r.retry_after <= 0 or r.retry_after > 60 then
    raise exception 'a minute refusal must carry a sane retry_after, got %', r.retry_after;
  end if;

  checks := checks + 1;

  -- 3. WINDOW ROLLOVER. A minute that has passed starts again.
  update agni_attest_keys
     set minute_count = 10, minute_start = now() - interval '61 seconds' where key_id = k;
  n := 3;
  select * into r from agni_attest_gate(k, n, 0, 10, 60, 100, 1.0, 25.0);
  if not r.allowed then raise exception 'a rolled minute must allow again, got %', r.reason; end if;
  if (select minute_count from agni_attest_keys where key_id = k) <> 1 then
    raise exception 'a rolled minute must restart the count';
  end if;

  checks := checks + 1;

  -- 4. HOUR and DAY are enforced independently of the minute.
  update agni_attest_keys set hour_count = 60, hour_start = now() where key_id = k;
  n := 4;
  select * into r from agni_attest_gate(k, n, 0, 10, 60, 100, 1.0, 25.0);
  if r.allowed or r.reason <> 'hour' then raise exception 'hour limit, got %', r.reason; end if;

  update agni_attest_keys set hour_count = 0, day_count = 100, day_start = now() where key_id = k;
  n := 5;
  select * into r from agni_attest_gate(k, n, 0, 10, 60, 100, 1.0, 25.0);
  if r.allowed or r.reason <> 'day' then raise exception 'day limit, got %', r.reason; end if;

  checks := checks + 1;

  -- 5. SPEND. The previous call's real cost is added, and the cap bites after
  --    it crosses.
  update agni_attest_keys
     set day_count = 0, minute_count = 0, hour_count = 0, day_spend_usd = 0.99 where key_id = k;
  n := 6;
  select * into r from agni_attest_gate(k, n, 0.02, 10, 60, 100, 1.0, 25.0);
  if r.allowed then raise exception 'spend cap must bite once crossed'; end if;
  if r.reason <> 'spend' then raise exception 'expected spend, got %', r.reason; end if;
  if (select day_spend_usd from agni_attest_keys where key_id = k) < 1.0 then
    raise exception 'the previous cost must be recorded even when refused';
  end if;

  checks := checks + 1;

  -- 6. A DAY THAT HAS ROLLED clears the spend as well as the counts.
  update agni_attest_keys
     set day_start = now() - interval '25 hours', day_spend_usd = 5.0 where key_id = k;
  n := 7;
  select * into r from agni_attest_gate(k, n, 0, 10, 60, 100, 1.0, 25.0);
  if not r.allowed then raise exception 'a new day must start clean, got %', r.reason; end if;
  if (select day_spend_usd from agni_attest_keys where key_id = k) > 0.001 then
    raise exception 'a new day must reset spend';
  end if;

  checks := checks + 1;

  -- 7. THE GLOBAL CEILING stops everyone, and reads differently from a personal
  --    limit because it is not the person's fault.
  update agni_service set day_spend_usd = 25.0, day_start = now() where id = 1;
  update agni_attest_keys set minute_count = 0, hour_count = 0, day_count = 0 where key_id = k;
  n := 8;
  select * into r from agni_attest_gate(k, n, 0, 10, 60, 100, 1.0, 25.0);
  if r.allowed or r.reason <> 'global_spend' then
    raise exception 'global ceiling, got %', r.reason;
  end if;

  checks := checks + 1;

  -- 8. UNLIMITED bypasses every limit, but spend is still recorded so the
  --    global ceiling still sees it.
  update agni_service set day_spend_usd = 0 where id = 1;
  update agni_attest_keys
     set unlimited = true, minute_count = 9999, day_count = 9999, day_spend_usd = 99
   where key_id = k;
  n := 9;
  select * into r from agni_attest_gate(k, n, 0.01, 10, 60, 100, 1.0, 25.0);
  if not r.allowed or r.reason <> 'unlimited' then
    raise exception 'an unlimited key must pass every limit, got % %', r.allowed, r.reason;
  end if;
  if (select day_spend_usd from agni_service where id = 1) < 0.01 then
    raise exception 'an unlimited key must still contribute to the global ceiling';
  end if;

  checks := checks + 1;

  -- 9. AN UNKNOWN KEY is refused, not created.
  select * into r from agni_attest_gate('NO-SUCH-KEY-AT-ALL', 1, 0, 10, 60, 100, 1.0, 25.0);
  if r.allowed or r.reason <> 'unknown_key' then
    raise exception 'an unknown key must be refused, got %', r.reason;
  end if;

  delete from agni_attest_keys where key_id = k;
  update agni_service set day_spend_usd = saved_spend, day_start = saved_start where id = 1;

  checks := checks + 1;

  insert into agni_gate_test_result
  values ('ALL GATE TESTS PASSED', checks, now());
end $$;

-- WHAT YOU SHOULD SEE. One row:
--
--   result                  | checks_run | at
--   ALL GATE TESTS PASSED   | 9          | 2026-...
--
-- No row, or a red error naming the check that broke, means it did not pass.
select * from agni_gate_test_result;

-- CONCURRENCY, which the script above cannot show on its own.
--
-- `agni_attest_gate` takes `for update` on the key row before reading any
-- counter, so two requests arriving together serialise: the second sees the
-- first's increment and cannot pass a limit they jointly exceed. To see it,
-- open two SQL editor tabs, run this in the first WITHOUT committing, and watch
-- the second block until it finishes:
--
--   begin;
--   select * from agni_attest_gate('SOME-REAL-KEY', 999999, 0, 10, 60, 100, 1.0, 25.0);
--   -- (leave open, run the same in another tab, then:)
--   rollback;
