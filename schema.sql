-- Agni usage tracking. Run this once in the Supabase SQL editor.
--
-- One row per app install. The install id is a UUID the app generates on first
-- launch and keeps in its Keychain. It identifies a phone, not a person: there
-- is no account, no email, and nothing here can be traced back to who someone is.

create table if not exists agni_installs (
  install_id       text primary key,
  estimates_used   integer     not null default 0,
  unlimited        boolean     not null default false,
  first_seen       timestamptz not null default now(),
  last_seen        timestamptz not null default now(),
  note             text
);

-- Locked down. Only the service role key, held by the Vercel function, can read
-- or write. There is no anon access and no browser ever touches this table.
alter table agni_installs enable row level security;

-- Reads the current state and creates the row on first sight, without spending
-- a credit. The estimate is only counted after Anthropic actually answers, so a
-- failed request does not cost the tester one of their free goes.
create or replace function agni_check(p_install_id text)
returns table (used integer, is_unlimited boolean)
language plpgsql
security definer
as $$
begin
  insert into agni_installs (install_id)
  values (p_install_id)
  on conflict (install_id) do update set last_seen = now();

  return query
    select i.estimates_used, i.unlimited
    from agni_installs i
    where i.install_id = p_install_id;
end;
$$;

create or replace function agni_consume(p_install_id text)
returns integer
language plpgsql
security definer
as $$
declare
  v_used integer;
begin
  update agni_installs
     set estimates_used = estimates_used + 1,
         last_seen = now()
   where install_id = p_install_id
  returning estimates_used into v_used;

  return v_used;
end;
$$;

-- To give someone unlimited use (your wife, yourself):
--   update agni_installs set unlimited = true, note = 'name' where install_id = '...';
-- To cut someone off:
--   update agni_installs set unlimited = false, estimates_used = 999999 where install_id = '...';
