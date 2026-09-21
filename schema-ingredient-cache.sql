-- Ingredient evidence, shared. Run once in the Agni Supabase project.
--
-- WHAT IT IS FOR. A sourced web lookup costs money and takes ten seconds, and
-- banana flower is the same food for everybody who eats one. One person's
-- lookup should answer it for the next, which is the same argument
-- agni_variants already makes for dish variants.
--
-- WHAT IS IN IT, AND WHAT DELIBERATELY IS NOT.
--
-- There is no column for a person here, and that is a shape rather than a
-- policy. No install id, no device, no meal, no photograph, no sentence
-- somebody wrote about their own cooking. What is left is a food, how it was
-- prepared, and what published sources say about it -- which is the same for
-- everyone who asks, and is therefore worth sharing and worthless to anybody
-- trying to work out who ate what.
--
-- The key is the normalised ingredient name and its form. Nothing is collapsed:
-- "banana flower" and "banana blossom" are two rows, because Agni has no cited
-- evidence that they are one food.
--
-- EVIDENCE, NOT AN ANSWER. The payload holds the individual source rows with
-- their tiers, identities, forms and URLs. It is never reduced to one figure on
-- the way in: the app's identity check, form rule, tiering and conflict
-- classification all still have to be able to see the disagreement.

create table if not exists agni_ingredient_evidence (
  key          text primary key,
  payload      jsonb       not null,
  expires_at   timestamptz not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists agni_ingredient_evidence_expiry
  on agni_ingredient_evidence (expires_at);

-- Read. Returns nothing for an expired row rather than deleting it here: a
-- read path that writes is a read path that can fail in a new way.
create or replace function agni_ingredient_evidence_get(p_key text)
returns jsonb
language sql
security definer
as $$
  select payload
  from agni_ingredient_evidence
  where key = p_key and expires_at > now()
  limit 1;
$$;

-- Write. Last one wins, which is right: a later lookup saw a later web.
create or replace function agni_ingredient_evidence_put(
  p_key text, p_payload jsonb, p_ttl_seconds int
) returns void
language sql
security definer
as $$
  insert into agni_ingredient_evidence (key, payload, expires_at)
  values (p_key, p_payload, now() + make_interval(secs => p_ttl_seconds))
  on conflict (key) do update
    set payload = excluded.payload,
        expires_at = excluded.expires_at,
        updated_at = now();
$$;

-- Housekeeping, run whenever. Nothing depends on it having run.
create or replace function agni_ingredient_evidence_sweep()
returns int
language sql
security definer
as $$
  with gone as (delete from agni_ingredient_evidence where expires_at < now() returning 1)
  select count(*)::int from gone;
$$;
