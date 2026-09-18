import { test } from 'node:test';
import assert from 'node:assert/strict';

// The shaping layer, which is the part that decides what a model is allowed to
// have said. Everything else in the endpoint is auth and a fetch.
const BANNED = /^(kcal|calorie|calories|energy|kj|protein|carb|carbs|carbohydrate|fat|sugar|sodium)/i;

function cleanIngredients(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list.slice(0, 24)) {
    const name = String(item?.name || '').trim().slice(0, 80);
    const grams = Number(item?.grams);
    if (!name || BANNED.test(name)) continue;
    if (!Number.isFinite(grams) || grams <= 0 || grams > 2000) continue;
    out.push({ name, grams: Math.round(grams * 10) / 10 });
  }
  return out;
}

test('a nutrition figure smuggled in as an ingredient is dropped', () => {
  const cleaned = cleanIngredients([
    { name: 'chicken, cooked', grams: 120 },
    { name: 'calories', grams: 430 },
    { name: 'Protein', grams: 31 },
    { name: 'fat', grams: 12 }
  ]);
  assert.deepEqual(cleaned, [{ name: 'chicken, cooked', grams: 120 }]);
});

test('an absurd weight is refused rather than scaled', () => {
  assert.equal(cleanIngredients([{ name: 'rice', grams: 50000 }]).length, 0);
  assert.equal(cleanIngredients([{ name: 'rice', grams: -5 }]).length, 0);
  assert.equal(cleanIngredients([{ name: 'rice', grams: 'lots' }]).length, 0);
});

test('a runaway ingredient list is capped', () => {
  const many = Array.from({ length: 80 }, (_, i) => ({ name: `food ${i}`, grams: 10 }));
  assert.equal(cleanIngredients(many).length, 24);
});

test('nothing at all is an empty list, not a throw', () => {
  assert.deepEqual(cleanIngredients(undefined), []);
  assert.deepEqual(cleanIngredients('chicken'), []);
});

test('there is no field a model could put a URL in', () => {
  // The shaped response is built key by key from a fixed set. A url in the
  // model output has nowhere to land, which is stronger than stripping one.
  const shaped = {
    evidence: 'model_knowledge',
    identity: { kind: 'dish', canonical_name: 'Mohinga' },
    recipe: null,
    certainty: 'low'
  };
  assert.equal(shaped.source_url, undefined);
  assert.equal(shaped.identity.source, undefined);
  assert.equal(shaped.evidence, 'model_knowledge');
});
