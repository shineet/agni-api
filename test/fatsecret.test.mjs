import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readDescription } from '../api/fatsecret.js';

test('the whole panel is read out of the sentence FatSecret writes', () => {
  const panel = readDescription(
    'Per 100g - Calories: 250kcal | Fat: 12.10g | Carbs: 32.60g | Protein: 4.30g');
  assert.equal(panel.kcal, 250);
  assert.equal(panel.fat_g, 12.1);
  assert.equal(panel.carbs_g, 32.6);
  assert.equal(panel.protein_g, 4.3);
  assert.equal(panel.serving_grams, 100);
  assert.equal(panel.serving_description, '100g');
});

test('a serving with no gram weight keeps its words and reports no weight', () => {
  const panel = readDescription(
    'Per 1 bar - Calories: 228kcal | Fat: 8.80g | Carbs: 34.70g | Protein: 2.20g');
  assert.equal(panel.kcal, 228);
  assert.equal(panel.serving_grams, null);
  assert.equal(panel.serving_description, '1 bar');
});

test('a description with no calories yields nothing rather than a partial panel', () => {
  assert.equal(readDescription('Per 1 serving - Fat: 8.80g'), null);
  assert.equal(readDescription(''), null);
  assert.equal(readDescription(undefined), null);
  assert.equal(readDescription({ kcal: 100 }), null);
});

test('macros that are absent read as zero rather than breaking the panel', () => {
  const panel = readDescription('Per 1 cup - Calories: 90kcal');
  assert.equal(panel.kcal, 90);
  assert.equal(panel.protein_g, 0);
});
