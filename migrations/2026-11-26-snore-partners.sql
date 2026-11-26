-- Two phones, one bed (SHAI 1.3, 2026-11-26). NOT RUN. Shine pastes it in the Supabase SQL editor of the Agni project
-- (nglfxnzxseshrklypxhg; check the project name first), THEN re-runs schema-lockdown.sql, THEN the server is deployed.
-- Additive only: two tables, seven functions, nothing existing is changed.
--
-- WHAT IS KEPT. Pairs of devices (their device subjects), a pairing code for ten minutes, and for each night each phone
-- shares: when it began and ended and its snore marks (time, rise over the room's quiet, how sure). No sound, no speech,
-- no cough or breathing. A night's marks are deleted as soon as the partner's phone has compared with them, and in any
-- case after 7 days; unpairing deletes both phones' nights and the pair; "delete my data" deletes this phone's.

create table if not exists agni_snore_pairs (
  device text primary key,                 -- dev:<install id>
  partner text,                            -- null while waiting with a code
  code text unique,
  code_expires timestamptz,
  paired_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists agni_snore_nights (
  device text not null,
  began timestamptz not null,
  ended timestamptz not null,
  marks jsonb not null,                    -- {"base": seconds since 1970, "m": [[seconds after base, rise, sure], ...]}
  created_at timestamptz not null default now(),
  primary key (device, began)
);
create index if not exists agni_snore_nights_created on agni_snore_nights (created_at);

alter table agni_snore_pairs enable row level security;
alter table agni_snore_nights enable row level security;

-- A code to give the partner. Replaces this phone's earlier code; refused while paired.
create or replace function agni_snore_pair_start(p_device text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c text; r agni_snore_pairs;
begin
  select * into r from agni_snore_pairs where device = p_device;
  if r.partner is not null then return jsonb_build_object('error', 'already_paired'); end if;
  loop
    c := lpad((floor(random() * 1000000))::int::text, 6, '0');
    exit when not exists (select 1 from agni_snore_pairs where code = c and code_expires > now());
  end loop;
  delete from agni_snore_pairs where code = c;   -- an expired one with the same digits
  insert into agni_snore_pairs (device, code, code_expires) values (p_device, c, now() + interval '10 minutes')
    on conflict (device) do update set code = excluded.code, code_expires = excluded.code_expires, partner = null, paired_at = null;
  return jsonb_build_object('code', c, 'expires', now() + interval '10 minutes');
end $$;

-- The partner types the code. Both phones are then paired; the code is spent.
create or replace function agni_snore_pair_join(p_device text, p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare owner text;
begin
  if exists (select 1 from agni_snore_pairs where device = p_device and partner is not null) then
    return jsonb_build_object('error', 'already_paired'); end if;
  select device into owner from agni_snore_pairs where code = p_code and code_expires > now() and partner is null for update;
  if owner is null then return jsonb_build_object('error', 'no_such_code'); end if;
  if owner = p_device then return jsonb_build_object('error', 'own_code'); end if;
  update agni_snore_pairs set partner = p_device, code = null, code_expires = null, paired_at = now() where device = owner;
  insert into agni_snore_pairs (device, partner, paired_at) values (p_device, owner, now())
    on conflict (device) do update set partner = excluded.partner, code = null, code_expires = null, paired_at = excluded.paired_at;
  return jsonb_build_object('paired', true);
end $$;

create or replace function agni_snore_status(p_device text) returns jsonb
language sql security definer set search_path = public as $$
  select coalesce((select jsonb_build_object('paired', partner is not null,
                                             'code', case when partner is null and code_expires > now() then code end,
                                             'since', paired_at)
                   from agni_snore_pairs where device = p_device), jsonb_build_object('paired', false));
$$;

-- Either phone ends it: both rows, and both phones' nights, go.
create or replace function agni_snore_unpair(p_device text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare other text;
begin
  select partner into other from agni_snore_pairs where device = p_device;
  delete from agni_snore_nights where device = p_device or device = other;
  delete from agni_snore_pairs where device = p_device or device = other;
  return jsonb_build_object('unpaired', true);
end $$;

-- A night's marks, from a paired phone only. Old ones go on every put.
create or replace function agni_snore_put(p_device text, p_began timestamptz, p_ended timestamptz, p_marks jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  delete from agni_snore_nights where created_at < now() - interval '7 days';
  if not exists (select 1 from agni_snore_pairs where device = p_device and partner is not null) then
    return jsonb_build_object('error', 'not_paired'); end if;
  insert into agni_snore_nights (device, began, ended, marks) values (p_device, p_began, p_ended, p_marks)
    on conflict (device, began) do update set ended = excluded.ended, marks = excluded.marks, created_at = now();
  return jsonb_build_object('kept', true);
end $$;

-- The partner's nights that overlap this time, or {"nights": []} when they have shared none (yet).
create or replace function agni_snore_get(p_device text, p_from timestamptz, p_to timestamptz) returns jsonb
language sql security definer set search_path = public as $$
  select jsonb_build_object('paired', p.partner is not null, 'nights',
           coalesce((select jsonb_agg(jsonb_build_object('began', n.began, 'ended', n.ended, 'marks', n.marks))
                     from agni_snore_nights n where n.device = p.partner and n.began < p_to and n.ended > p_from), '[]'::jsonb))
  from agni_snore_pairs p where p.device = p_device
  union all select jsonb_build_object('paired', false, 'nights', '[]'::jsonb)
  where not exists (select 1 from agni_snore_pairs where device = p_device)
  limit 1;
$$;

-- This phone has compared with the partner's nights for this time: those marks are not needed any more.
create or replace function agni_snore_compared(p_device text, p_from timestamptz, p_to timestamptz) returns jsonb
language sql security definer set search_path = public as $$
  with gone as (delete from agni_snore_nights n using agni_snore_pairs p
                where p.device = p_device and n.device = p.partner and n.began < p_to and n.ended > p_from returning 1)
  select jsonb_build_object('deleted', (select count(*) from gone));
$$;

-- "Delete my data": this phone's nights and pairing; the partner is left unpaired.
create or replace function agni_snore_forget(p_device text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  delete from agni_snore_nights where device = p_device;
  get diagnostics n = row_count;
  update agni_snore_pairs set partner = null, paired_at = null where partner = p_device;
  delete from agni_snore_pairs where device = p_device;
  return jsonb_build_object('nights', n);
end $$;

-- Then: run schema-lockdown.sql again, so these are callable by the server (service_role) only.
