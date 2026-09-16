-- Tests agni_beta_claim against the real database. Run in the Supabase SQL
-- editor AFTER schema-beta.sql.
--
-- WHY THIS MATTERS MORE THAN MOST TESTS: the cap in this function is the only
-- thing standing between a public form and an unbounded number of invitation
-- emails sent in Shine's name from his App Store Connect account. Every other
-- guard is advisory. This one is load bearing.
--
-- Same shape as gate-sql-test.sql, and for the same reason: the logic is
-- PL/pgSQL, there is no Postgres where `npm test` runs, and modelling it in
-- JavaScript would prove only that the model agrees with itself.
--
-- The verdict goes in a temp table rather than a `raise notice`, because the
-- Supabase editor does not display notices: a full pass and a block that did
-- nothing would both read as "Success. No rows returned".
--
-- It uses addresses at @beta-test.invalid, which is a reserved TLD that can
-- never belong to a real person, and deletes them all at the end.

drop table if exists agni_beta_test_result;
create temp table agni_beta_test_result (result text, checks_run integer, at timestamptz);

do $$
declare
  checks integer := 0;
  r      record;
  i      integer;
begin
  -- Start from a known state. Only ever touches the reserved test domain, so a
  -- real signup sitting in the table is never at risk.
  delete from agni_beta_signups where email like '%@beta-test.invalid';

  -- 1. A new address is accepted.
  select * into r from agni_beta_claim('First@beta-test.invalid', 'First Person', '10.0.0.1', 3);
  if r.status <> 'accepted' then
    raise exception 'a new address should be accepted, got %', r.status;
  end if;
  checks := checks + 1;

  -- 2. The address is stored lowercased, so case cannot create two rows for
  --    one person, and the name came with it.
  if not exists (select 1 from agni_beta_signups
                  where email = 'first@beta-test.invalid' and name = 'First Person') then
    raise exception 'the address should be stored lowercased, with the name';
  end if;
  checks := checks + 1;

  -- 3. The same address again is 'already', not a second row. Someone who
  --    presses the button twice must not consume two of the twenty places.
  select * into r from agni_beta_claim('FIRST@beta-test.invalid', 'First Person', '10.0.0.2', 3);
  if r.status <> 'already' then
    raise exception 'a repeat address should answer already, got %', r.status;
  end if;
  if (select count(*) from agni_beta_signups where email like '%@beta-test.invalid') <> 1 then
    raise exception 'a repeat address should not have inserted a second row';
  end if;
  checks := checks + 1;

  -- 4. The cap refuses. Two more fill a cap of three, the fourth is turned
  --    away. This is the check that bounds the blast radius.
  select * into r from agni_beta_claim('second@beta-test.invalid', 'Second', '10.0.0.3', 3);
  if r.status <> 'accepted' then raise exception 'second should be accepted, got %', r.status; end if;
  select * into r from agni_beta_claim('third@beta-test.invalid', 'Third', '10.0.0.4', 3);
  if r.status <> 'accepted' then raise exception 'third should be accepted, got %', r.status; end if;
  select * into r from agni_beta_claim('fourth@beta-test.invalid', 'Fourth', '10.0.0.5', 3);
  if r.status <> 'full' then
    raise exception 'the cap should refuse the fourth of three, got %', r.status;
  end if;
  checks := checks + 1;

  -- 5. A refused signup leaves NO row. The cap must not be self-defeating by
  --    recording the people it turned away and counting them next time.
  if exists (select 1 from agni_beta_signups where email = 'fourth@beta-test.invalid') then
    raise exception 'a capped signup should not have been stored';
  end if;
  checks := checks + 1;

  -- 6. 'taken' reports the real number of places used, so the caller can say
  --    how full it is without a second query.
  select * into r from agni_beta_claim('fifth@beta-test.invalid', 'Fifth', '10.0.0.6', 99);
  if r.taken <> 4 then
    raise exception 'taken should count the places used, expected 4 got %', r.taken;
  end if;
  checks := checks + 1;

  -- 7. The per-address rate limit trips on the fourth try from one place
  --    within the hour, and does so BEFORE the cap has anything to say.
  delete from agni_beta_signups where email like '%@beta-test.invalid';
  for i in 1..3 loop
    select * into r from agni_beta_claim('burst' || i || '@beta-test.invalid', 'Burst', '10.9.9.9', 99);
    if r.status <> 'accepted' then
      raise exception 'burst signup % should be accepted, got %', i, r.status;
    end if;
  end loop;
  select * into r from agni_beta_claim('burst4@beta-test.invalid', 'Burst', '10.9.9.9', 99);
  if r.status <> 'slow_down' then
    raise exception 'the fourth signup from one address should slow down, got %', r.status;
  end if;
  checks := checks + 1;

  -- 8. A different address is unaffected. One busy office must not be able to
  --    lock everybody else out.
  select * into r from agni_beta_claim('elsewhere@beta-test.invalid', 'Elsewhere', '10.9.9.10', 99);
  if r.status <> 'accepted' then
    raise exception 'a different address should be unaffected, got %', r.status;
  end if;
  checks := checks + 1;

  -- 9. An old signup from the same address does not count. The window rolls.
  update agni_beta_signups set created_at = now() - interval '2 hours'
   where email like 'burst%@beta-test.invalid';
  select * into r from agni_beta_claim('burst5@beta-test.invalid', 'Burst', '10.9.9.9', 99);
  if r.status <> 'accepted' then
    raise exception 'signups older than an hour should not count, got %', r.status;
  end if;
  checks := checks + 1;

  -- 10. agni_beta_invited records Apple's tester id against the right row, and
  --     flips invited. A row still false afterwards is the signal to chase
  --     somebody by hand, so it has to be accurate.
  perform agni_beta_invited('elsewhere@beta-test.invalid', 'ASC-TESTER-123');
  if not exists (select 1 from agni_beta_signups
                  where email = 'elsewhere@beta-test.invalid'
                    and invited = true and tester_id = 'ASC-TESTER-123') then
    raise exception 'agni_beta_invited should record the tester id and flip invited';
  end if;
  if exists (select 1 from agni_beta_signups
              where email = 'burst5@beta-test.invalid' and invited = true) then
    raise exception 'agni_beta_invited should touch only the address it was given';
  end if;
  checks := checks + 1;

  -- Leave nothing behind.
  delete from agni_beta_signups where email like '%@beta-test.invalid';

  insert into agni_beta_test_result
  values ('ALL BETA SIGNUP TESTS PASSED', checks, now());
end $$;

-- WHAT YOU SHOULD SEE. One row:
--
--   result                        | checks_run | at
--   ALL BETA SIGNUP TESTS PASSED  | 10         | 2026-...
--
-- No row, or a red error naming the check that broke, means it did not pass.
select * from agni_beta_test_result;

-- AND THE REAL LIST, which should be empty until the form goes live:
--
--   select email, name, invited, created_at from agni_beta_signups order by created_at;
