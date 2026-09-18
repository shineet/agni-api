import { test } from 'node:test';
import assert from 'node:assert/strict';

// The two functions worth testing offline: reading nutrients by id, and
// trimming a food to what the app actually uses. Everything else in the
// endpoint is auth and a fetch.
const NUTRIENT = { energy: 1008, protein: 1003, fat: 1004, carbs: 1005 };

function nutrients(food) {
  const found = { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
  for (const entry of food.foodNutrients || []) {
    const id = entry.nutrientId ?? entry.nutrient?.id;
    const value = Number(entry.value ?? entry.amount ?? 0);
    if (!Number.isFinite(value)) continue;
    if (id === NUTRIENT.energy) {
      const unit = String(entry.unitName ?? entry.nutrient?.unitName ?? '').toLowerCase();
      if (unit === 'kj' && found.kcal) continue;
      found.kcal = unit === 'kj' ? value / 4.184 : value;
    }
    if (id === NUTRIENT.protein) found.protein_g = value;
    if (id === NUTRIENT.fat) found.fat_g = value;
    if (id === NUTRIENT.carbs) found.carbs_g = value;
  }
  return found;
}

test('nutrients are read by id, not by name', () => {
  const food = { foodNutrients: [
    { nutrientId: 1008, value: 250, unitName: 'KCAL' },
    { nutrientId: 1003, value: 4.3 },
    { nutrientId: 1005, value: 32.6 },
    { nutrientId: 1004, value: 12.1 }
  ] };
  assert.deepEqual(nutrients(food), { kcal: 250, protein_g: 4.3, carbs_g: 32.6, fat_g: 12.1 });
});

test('the other shape FDC uses, nested under nutrient, also reads', () => {
  const food = { foodNutrients: [
    { nutrient: { id: 1008, unitName: 'kcal' }, amount: 90 },
    { nutrient: { id: 1003 }, amount: 2 }
  ] };
  const found = nutrients(food);
  assert.equal(found.kcal, 90);
  assert.equal(found.protein_g, 2);
});

test('kilojoules do not overwrite a kcal figure already found', () => {
  const food = { foodNutrients: [
    { nutrientId: 1008, value: 250, unitName: 'KCAL' },
    { nutrientId: 1008, value: 1046, unitName: 'kJ' }
  ] };
  assert.equal(nutrients(food).kcal, 250);
});

test('kilojoules alone are converted rather than reported as calories', () => {
  const food = { foodNutrients: [{ nutrientId: 1008, value: 418.4, unitName: 'kJ' }] };
  assert.equal(Math.round(nutrients(food).kcal), 100);
});

test('a food with no nutrients reads as zero rather than throwing', () => {
  assert.deepEqual(nutrients({}), { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 });
});

test('a serving size in anything but grams is not reported as grams', () => {
  const trim = (food) => Number(food.servingSize) > 0
    && String(food.servingSizeUnit || '').toLowerCase() === 'g'
    ? Number(food.servingSize) : null;
  assert.equal(trim({ servingSize: 48, servingSizeUnit: 'g' }), 48);
  assert.equal(trim({ servingSize: 1, servingSizeUnit: 'cup' }), null);
  assert.equal(trim({ servingSize: 240, servingSizeUnit: 'ml' }), null);
});
