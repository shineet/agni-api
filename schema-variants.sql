-- The variant cache. Run this once in the Agni Supabase SQL editor,
-- after schema.sql.
--
-- The dish search asks a model to name the specific dishes a general name
-- could mean and to say what goes into each. That call is the only slow thing
-- in adding a dish, and it is the same call for everybody: the three biriyanis
-- the first person is shown are the three the next person should be shown, and
-- nothing about them depends on who asked.
--
-- So the answer is kept and handed to the next person instead. The second
-- search for a dish costs nothing and waits for nothing, and the table gets
-- better the more the app is used, which was the point of the community table
-- and applies twice over here.
--
-- WHAT IS STORED IS THE MODEL'S ANSWER, NOT ANYBODY'S FOOD. No install id, no
-- meal, no time of day. The key is the words that were typed, which have
-- already been sent to the model to be answered; keeping them adds no
-- disclosure that the asking did not already make. Short keys only, so a
-- sentence somebody typed about their own life is not what gets cached.

create table if not exists agni_variant_cache (
  -- The normalised query, matching DishDatabase.normalise on the app side.
  -- "Milk Tea" and "milk  tea" are the same question and get the same answer.
  query_key   text        primary key,
  -- The variants exactly as the model returned them: name, distinction,
  -- total grams, ingredients with weights, method note. Stored whole so the
  -- app can price them against USDA itself, the same way it prices a fresh
  -- answer. Nothing here is a calorie figure -- those are never the model's.
  payload     jsonb       not null,
  -- How many people this has been handed to. Only ever interesting for
  -- deciding what deserves to go in the bundled table one day.
  hits        integer     not null default 0,
  created_at  timestamptz not null default now()
);

-- Reads and writes go through these, never through the table directly, so the
-- anon key can never see or change a row except in the two ways below.
alter table agni_variant_cache enable row level security;

-- Handing back a cached answer, and counting that it was useful.
create or replace function agni_cached_variants(p_key text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  found jsonb;
begin
  update agni_variant_cache
     set hits = hits + 1
   where query_key = p_key
  returning payload into found;
  return found;
end;
$$;

-- Storing one. First answer wins rather than last: a second answer to the same
-- question is not better information, it is the same question asked again, and
-- letting it overwrite would make the cached figure drift every time somebody
-- searched. Anything already there is left alone.
create or replace function agni_cache_variants(p_key text, p_payload jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if length(p_key) < 4 or length(p_key) > 60 then
    return;
  end if;
  if jsonb_typeof(p_payload) <> 'array' or jsonb_array_length(p_payload) = 0 then
    return;
  end if;
  insert into agni_variant_cache (query_key, payload)
  values (p_key, p_payload)
  on conflict (query_key) do nothing;
end;
$$;

grant execute on function agni_cached_variants(text) to anon, authenticated;
grant execute on function agni_cache_variants(text, jsonb) to anon, authenticated;
