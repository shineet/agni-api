-- Beta signups, for recruiting testers from a public post.
--
-- The point of this table is that a TestFlight PUBLIC LINK tells you nothing:
-- everyone who joins one shows up in App Store Connect as "Anonymous" with no
-- name and no email, so there is no way to ask them a follow-up question. A
-- form that collects the address first and then invites them by email means
-- every tester is a person you can actually talk to.

create table if not exists agni_beta_signups (
  email       text primary key,          -- stored lowercased, so one person is one row
  name        text,
  created_at  timestamptz not null default now(),
  invited     boolean not null default false,
  tester_id   text,                      -- App Store Connect betaTesters id
  ip          text                       -- only ever read to rate limit; never shown
);

create index if not exists agni_beta_signups_ip_time on agni_beta_signups (ip, created_at);

-- One statement decides everything, under an advisory lock, because the cap is
-- the only thing standing between a public form and an unbounded number of
-- invitation emails sent in Shine's name. Two requests arriving together must
-- not both read "19 signed up" and both be allowed.
--
-- Returns one of: accepted, already, full, slow_down.
create or replace function agni_beta_claim(
  p_email text,
  p_name  text,
  p_ip    text,
  p_cap   int
) returns table (status text, taken int) language plpgsql security definer as $$
declare
  v_email text := lower(btrim(p_email));
  v_taken int;
begin
  perform pg_advisory_xact_lock(hashtext('agni_beta_claim'));

  if exists (select 1 from agni_beta_signups s where s.email = v_email) then
    select count(*) into v_taken from agni_beta_signups;
    return query select 'already'::text, v_taken;
    return;
  end if;

  -- Per address, not global: one person retyping their email must not be able
  -- to consume the whole beta, and one shared office IP must not lock out a
  -- colleague either. Three an hour is generous for a real person.
  if (select count(*) from agni_beta_signups s
       where s.ip = p_ip and s.created_at > now() - interval '1 hour') >= 3 then
    select count(*) into v_taken from agni_beta_signups;
    return query select 'slow_down'::text, v_taken;
    return;
  end if;

  select count(*) into v_taken from agni_beta_signups;
  if v_taken >= p_cap then
    return query select 'full'::text, v_taken;
    return;
  end if;

  insert into agni_beta_signups (email, name, ip) values (v_email, nullif(btrim(p_name), ''), p_ip);
  return query select 'accepted'::text, v_taken + 1;
end;
$$;

-- Recorded separately, after Apple has actually accepted the tester, so a row
-- with invited = false is a real signal: that person gave their address and
-- never got an invitation. Those are the ones to chase by hand.
create or replace function agni_beta_invited(p_email text, p_tester_id text)
returns void language sql security definer as $$
  update agni_beta_signups
     set invited = true, tester_id = p_tester_id
   where email = lower(btrim(p_email));
$$;

-- Nobody but the service role touches this table, and the functions above are
-- security definer so they run as the owner rather than as the caller.
--
-- THE ONE THAT BIT: without security definer these ran as service_role, which
-- has no privileges on a newly created table, and every signup came back as
-- "permission denied for table agni_beta_signups". The SQL editor did not catch
-- it because the editor runs as the owner, so the test passed while the real
-- path was broken. Every other function in this project is security definer
-- for the same reason.
alter table agni_beta_signups enable row level security;
