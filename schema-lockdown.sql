-- Who may touch Agni's database. Run LAST, after every other schema file, and
-- again after any of them is re-run: `create or replace function` keeps grants,
-- but a dropped and re-created function picks Supabase's defaults back up.
--
-- WHY. Supabase grants EXECUTE on every new function in `public`, and ALL on
-- every new table and view, to the anon and authenticated roles, and exposes
-- them over its REST API. Agni's server is the only intended caller and uses
-- the service role. Audited 2026-10-08 against a database that reproduces
-- those defaults, anon could:
--
--   * agni_attest_register: register a public key of its own under any key id,
--     then sign assertions with it. That is App Attest bypassed outright, and
--     it overwrites a real device's key when the id is known.
--   * agni_attest_gate / agni_attest_gate_class: pass a NEGATIVE previous cost
--     and walk a key's daily spend, and the service-wide day spend, back to
--     zero (a $40 day was reset to $0 in the probe), or burn a device's
--     replay counter and call windows.
--   * agni_attest_spend_free, agni_attest_claim, agni_attest_begin,
--     agni_attest_issue, agni_attest_advance: spend other keys' free
--     allowance, burn challenges, fill the challenge table.
--   * agni_check / agni_consume: create and spend legacy install counters.
--   * agni_cache_variants, agni_ingredient_evidence_put, agni_submit_dish,
--     agni_report_miss: write nutrition data every user is later served.
--   * agni_ingredient_evidence: read and write the TABLE directly (it was the
--     one table without row level security).
--   * agni_auth_summary, agni_beta_list: read telemetry and testers' emails.
--
-- None of this needs a stolen secret beyond the anon key, which Supabase calls
-- public and which is not in the app or the server today. "Not distributed" is
-- not a control, so this file removes the access rather than relying on it.
--
-- WHAT IT DOES, for every object named agni*, so a function added later is
-- covered the next time this runs (and the test fails until it does):
--   1. functions: EXECUTE revoked from public, anon and authenticated, granted
--      to service_role; security definer ones pinned to search_path public.
--   2. tables and views: everything revoked from anon and authenticated.
--   3. row level security on, everywhere.
--   4. views run as the caller (security_invoker), so they cannot be used to
--      read past row level security.
--
-- WHAT IT DOES NOT CHANGE: the service role, which the server uses, keeps
-- every privilege it had. Nothing the server calls loses access.

alter table if exists agni_ingredient_evidence enable row level security;

do $$
declare
  f record;
  t record;
begin
  for f in
    select p.oid::regprocedure as sig, p.prosecdef as definer
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname like 'agni%'
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
    if f.definer then
      execute format('alter function %s set search_path = public, pg_temp', f.sig);
    end if;
  end loop;

  for t in
    select c.oid::regclass as rel, c.relkind
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname like 'agni%' and c.relkind in ('r', 'v', 'm', 'p')
  loop
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on %s from anon', t.rel);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on %s from authenticated', t.rel);
    end if;
    if t.relkind in ('r', 'p') then
      execute format('alter table %s enable row level security', t.rel);
    elsif t.relkind = 'v' then
      execute format('alter view %s set (security_invoker = true)', t.rel);
    end if;
  end loop;
end;
$$;
