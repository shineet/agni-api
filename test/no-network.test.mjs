// The test suite cannot reach a real network host (see helpers/no-network.mjs).

import './helpers/no-network.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { blocked } from './helpers/no-network.mjs';

test('fetch to Anthropic, Supabase, Apple or USDA throws instead of leaving the machine', async () => {
  for (const url of ['https://api.anthropic.com/v1/messages', 'https://nglfxnzxseshrklypxhg.supabase.co/rest/v1/rpc/x',
                     'https://api.storekit.itunes.apple.com/inApps/v1/x', 'https://api.nal.usda.gov/fdc/v1/foods/search',
                     'https://agni-api.vercel.app/api/estimate']) {
    await assert.rejects(fetch(url, { method: 'POST', body: '{}' }), /no-network/, url);
  }
  assert.ok(blocked.length >= 5);
});

test('every test file imports the guard before anything else', () => {
  const dir = new URL('.', import.meta.url);
  for (const name of readdirSync(dir).filter(n => n.endsWith('.test.mjs'))) {
    const src = readFileSync(new URL(name, dir), 'utf8');
    const firstImport = src.match(/^import .*$/m)?.[0] ?? '';
    assert.equal(firstImport, "import './helpers/no-network.mjs';", name);
  }
});

test('the harness restores the guard, never the real fetch', async () => {
  const h = await import('./helpers/harness.mjs');
  h.installFetch();
  h.restoreFetch();
  await assert.rejects(fetch('https://api.anthropic.com/v1/messages'), /no-network/);
});
