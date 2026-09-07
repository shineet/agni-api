-- The shared dish table. Run this once in the Agni Supabase SQL editor,
-- after schema.sql.
--
-- Every dish somebody adds by hand is contributed silently. Nobody is asked,
-- because a prompt is a tax on the person doing the app a favour and most
-- people would decline it out of habit rather than intent.
--
-- Silence puts the burden on this file instead. Two rules do the work.
--
-- ONE ROW PER DISH PER INSTALL, so the same person entering chapati fifty times
-- is one voice, not fifty. Re-entering it updates their figures rather than
-- stacking another vote.
--
-- AND NOTHING IS PUBLISHED UNTIL TWO INDEPENDENT INSTALLS HAVE NAMED IT. That
-- single rule does two jobs at once. It is the privacy gate: "Amma's
-- kozhukatta" or "leftover from Priya's party" is typed by exactly one person
-- and is therefore never shown to anybody. And it is the quality gate: a name
-- two strangers both arrived at is a real dish, and the figures can be taken as
-- the median of what they each said rather than on the word of whoever typed
-- first.

create table if not exists agni_dish_submissions (
  -- The normalised name, matching DishDatabase.normalise on the app side:
  -- lowercased, punctuation stripped, whitespace collapsed. Two people writing
  -- "Kothu Parotta" and "kothu  parotta" are agreeing, and this is what makes
  -- them agree.
  key             text        not null,
  -- As typed, for display. The most common spelling wins when published.
  name            text        not null,
  install_id      text        not null,

  unit            text        not null default 'serving',
  grams_per_unit  numeric     not null default 0,
  kcal            numeric     not null,
  protein_g       numeric     not null default 0,
  carbs_g         numeric     not null default 0,
  fat_g           numeric     not null default 0,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  primary key (key, install_id)
);

create index if not exists agni_dish_submissions_key_idx on agni_dish_submissions (key);

-- Locked down like the installs table. Only the service role key held by the
-- Vercel function touches this; no browser and no app ever reaches it directly.
alter table agni_dish_submissions enable row level security;

-- What has earned its way out. Two independent installs minimum, and the
-- figures are the MEDIAN of what each of them said, not a mean: one person
-- typing 2000 kcal for a chapati should not drag the answer, and with three
-- submissions the median simply ignores them.
create or replace view agni_community_dishes as
  select
    s.key,
    mode() within group (order by s.name)                                  as name,
    mode() within group (order by s.unit)                                  as unit,
    percentile_cont(0.5) within group (order by s.grams_per_unit)          as grams_per_unit,
    percentile_cont(0.5) within group (order by s.kcal)                    as kcal,
    percentile_cont(0.5) within group (order by s.protein_g)               as protein_g,
    percentile_cont(0.5) within group (order by s.carbs_g)                 as carbs_g,
    percentile_cont(0.5) within group (order by s.fat_g)                   as fat_g,
    count(*)::int                                                          as submitters,
    max(s.updated_at)                                                      as last_seen
  from agni_dish_submissions s
  group by s.key
  having count(*) >= 2;

-- Records one person's version of a dish, replacing their own previous answer.
--
-- Figures are checked here rather than only in the app, because the app is not
-- the only thing that can call this. Anything impossible is dropped silently:
-- the person who typed it is not doing anything wrong, they are just not going
-- to be told their chapati was rejected, and there is nothing useful to say.
create or replace function agni_submit_dish(
  p_install_id     text,
  p_key            text,
  p_name           text,
  p_unit           text,
  p_grams_per_unit numeric,
  p_kcal           numeric,
  p_protein_g      numeric,
  p_carbs_g        numeric,
  p_fat_g          numeric
) returns void
language plpgsql
security definer
as $$
begin
  -- A name is a dish, not a sentence. Anything past this is a note somebody
  -- wrote to themselves, and it would be published to strangers.
  if p_key is null or length(p_key) < 3 or length(p_key) > 60 then return; end if;
  if p_install_id is null or length(p_install_id) < 8 then return; end if;

  -- Nothing edible is denser than pure fat, and no single serving of anything
  -- is 5,000 kcal. Both ends are typing errors rather than food.
  if p_kcal is null or p_kcal <= 0 or p_kcal > 5000 then return; end if;
  if p_protein_g < 0 or p_carbs_g < 0 or p_fat_g < 0 then return; end if;
  if p_grams_per_unit < 0 or p_grams_per_unit > 5000 then return; end if;

  -- The macros have to be able to produce the calories. Four, four and nine,
  -- with a wide allowance for fibre, alcohol and rounding: this only catches
  -- somebody who typed the protein into the calorie box.
  if (p_protein_g * 4 + p_carbs_g * 4 + p_fat_g * 9) > p_kcal * 3 then return; end if;

  insert into agni_dish_submissions as d
    (key, name, install_id, unit, grams_per_unit, kcal, protein_g, carbs_g, fat_g)
  values
    (p_key, p_name, p_install_id, coalesce(nullif(p_unit, ''), 'serving'),
     p_grams_per_unit, p_kcal, p_protein_g, p_carbs_g, p_fat_g)
  on conflict (key, install_id) do update set
    name = excluded.name,
    unit = excluded.unit,
    grams_per_unit = excluded.grams_per_unit,
    kcal = excluded.kcal,
    protein_g = excluded.protein_g,
    carbs_g = excluded.carbs_g,
    fat_g = excluded.fat_g,
    updated_at = now();
end;
$$;

-- Search, over published dishes only. The view is what enforces that, so no
-- endpoint can leak an uncorroborated entry by forgetting a condition.
create or replace function agni_search_dishes(p_query text, p_limit int default 15)
returns table (
  key text, name text, unit text, grams_per_unit numeric,
  kcal numeric, protein_g numeric, carbs_g numeric, fat_g numeric, submitters int
)
language sql
stable
security definer
as $$
  select c.key, c.name, c.unit, c.grams_per_unit,
         c.kcal, c.protein_g, c.carbs_g, c.fat_g, c.submitters
  from agni_community_dishes c
  where length(coalesce(p_query, '')) >= 2
    and c.key like '%' || lower(trim(p_query)) || '%'
  -- Names that START with what was typed first, then the best corroborated.
  order by (c.key like lower(trim(p_query)) || '%') desc, c.submitters desc, c.key
  limit least(coalesce(p_limit, 15), 50);
$$;

-- What to add to the bundled table next, best corroborated first. This is the
-- whole point of collecting it: the list is evidence rather than a guess.
--   select * from agni_community_dishes order by submitters desc limit 50;
