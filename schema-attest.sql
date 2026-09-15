-- App Attest key registry and challenge store. Run once in the Supabase SQL editor.
--
-- One row per attested key. The key id identifies an INSTALLATION of Agni on a
-- device, verified by Apple, and cannot be minted by a caller: that is the whole
-- point of it replacing the client-supplied install id, which could.

create table if not exists agni_attest_keys (
  key_id            text primary key,
  public_key_pem    text        not null,
  environment       text        not null,          -- 'development' | 'production'
  counter           bigint      not null default 0,
  free_ai_used      integer     not null default 0,
  first_seen        timestamptz not null default now(),
  last_seen         timestamptz not null default now(),
  revoked           boolean     not null default false,
  note              text
);

alter table agni_attest_keys enable row level security;

-- Single-use challenges. A nonce that can be replayed is not a nonce.
create table if not exists agni_attest_challenges (
  nonce       text primary key,
  issued_at   timestamptz not null default now(),
  used_at     timestamptz
);

alter table agni_attest_challenges enable row level security;

-- Issues a nonce.
create or replace function agni_attest_issue(p_nonce text)
returns void
language sql
security definer
as $$
  insert into agni_attest_challenges (nonce) values (p_nonce);
$$;

-- Claims a nonce exactly once, within its lifetime. Returns true only on the
-- first claim: a second call for the same nonce updates no rows and returns
-- false, which is what makes replay impossible rather than merely unlikely.
create or replace function agni_attest_claim(p_nonce text, p_max_age_seconds integer)
returns boolean
language plpgsql
security definer
as $$
declare
  claimed integer;
begin
  update agni_attest_challenges
     set used_at = now()
   where nonce = p_nonce
     and used_at is null
     and issued_at > now() - make_interval(secs => p_max_age_seconds);
  get diagnostics claimed = row_count;

  -- Housekeeping, so the table does not grow without bound.
  delete from agni_attest_challenges where issued_at < now() - interval '1 day';

  return claimed = 1;
end;
$$;

-- Registers a verified key. Idempotent: re-attesting the same key updates it
-- rather than failing, which is what happens when an app is reinstalled.
create or replace function agni_attest_register(
  p_key_id text, p_public_key text, p_environment text
) returns void
language sql
security definer
as $$
  insert into agni_attest_keys (key_id, public_key_pem, environment)
  values (p_key_id, p_public_key, p_environment)
  on conflict (key_id) do update
    set public_key_pem = excluded.public_key_pem,
        environment    = excluded.environment,
        counter        = 0,
        last_seen      = now();
$$;

-- Reads a key for verification.
create or replace function agni_attest_lookup(p_key_id text)
returns table (public_key_pem text, counter bigint, environment text,
               free_ai_used integer, revoked boolean)
language sql
security definer
as $$
  select public_key_pem, counter, environment, free_ai_used, revoked
    from agni_attest_keys where key_id = p_key_id;
$$;

-- Advances the replay counter. Rejects a counter that did not move, so the
-- database enforces the same rule the verifier does.
create or replace function agni_attest_advance(p_key_id text, p_counter bigint)
returns boolean
language plpgsql
security definer
as $$
declare
  moved integer;
begin
  update agni_attest_keys
     set counter = p_counter, last_seen = now()
   where key_id = p_key_id and p_counter > counter;
  get diagnostics moved = row_count;
  return moved = 1;
end;
$$;

-- Spends one complimentary AI analysis. SERVER-SIDE, keyed on the attested key,
-- so deleting the app and reinstalling does not hand out another allowance:
-- App Attest issues a new key per install, but the allowance is configured on
-- the server and can be tightened without an app release.
create or replace function agni_attest_spend_free(p_key_id text, p_limit integer)
returns table (allowed boolean, used integer, remaining integer)
language plpgsql
security definer
as $$
declare
  current integer;
begin
  select free_ai_used into current from agni_attest_keys where key_id = p_key_id;
  if current is null then
    return query select false, 0, 0;
    return;
  end if;
  if current >= p_limit then
    return query select false, current, 0;
    return;
  end if;
  update agni_attest_keys
     set free_ai_used = free_ai_used + 1, last_seen = now()
   where key_id = p_key_id;
  return query select true, current + 1, p_limit - current - 1;
end;
$$;
