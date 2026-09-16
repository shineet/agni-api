-- Proves the harness itself detects a failure.
--
-- Run this ONCE, on its own, before trusting gate-sql-test.sql. It deliberately
-- asserts something false. If Supabase shows a red error naming it, then a real
-- failure in the gate test would also be shown, and a clean run there means
-- something. If this prints "Success" instead, the harness is not detecting
-- anything and neither test can be believed.
--
-- Expected: ERROR:  the harness works: this failure was deliberate

do $$
begin
  if 1 = 1 then
    raise exception 'the harness works: this failure was deliberate';
  end if;
end $$;
