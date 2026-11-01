// The test-dish cleanup op: exact rows only, backed up, verifiable, reversible.
// Seeded to mirror production on 2026-10-31 (read-only inventory): five
// simulator installs that ran self-tests, eight fixture keys, two real
// contributors on two of those keys, and a real dish that must stay published.

import './helpers/no-network.mjs';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as h from './helpers/harness.mjs';
import { contributorId } from '../api/_lib.js';

const skip = !h.enabled && 'AGNI_TEST_PG not set';
let quotaHandler;
const TOKEN = 'admin-token-for-tests-0123456789';

const SIMS = ['05F7BACD-A5F2-404F-B087-11564CBB2659', '13923BC8-6341-47C7-9C86-C87506BC5250',
              '42A5F948-3CF6-4898-86FB-1A2B0879F7A0', 'E01AEE34-0681-4687-97B5-DEDF5358FACB'];
const SIM_PINT_ONLY = '1DF058F8-F6A1-40A4-A8E6-F49C9E707F49';
const KEYS = ['amma s dal', 'coffee', 'lager pint', 'pint of beer', 'rice', 'test food', 'toast', 'vanishing curry'];
const PAIRS = [...SIMS.flatMap(id => KEYS.map(key => ({ key, install_id: id }))), { key: 'pint of beer', install_id: SIM_PINT_ONLY }];

before(async () => {
  if (skip) return;
  h.setTestEnv({ BETA_ADMIN_TOKEN: TOKEN, IP_HASH_SALT: 'test-salt-for-contributors' });
  h.freshDatabase('dishcleanup');
  h.installFetch();
  quotaHandler = (await import('../api/quota.js')).default;
  const q = s => `'${String(s).replace(/'/g, "''")}'`;
  const rows = [];
  for (const id of SIMS) for (const key of KEYS) rows.push(`(${q(key)}, ${q(key)}, ${q(id)}, 'serving', 100)`);
  rows.push(`('pint of beer', 'Pint of beer', ${q(SIM_PINT_ONLY)}, 'serving', 224)`);
  // Real people: one on each of two fixture keys, and two on a real dish.
  rows.push(`('pint of beer', 'Pint of beer', ${q(contributorId('REAL-PHONE-0001'))}, 'serving', 224)`);
  rows.push(`('rice', 'Rice', 'AF89B83E-REAL-RAW-ID-0002', 'serving', 150)`);
  rows.push(`('chapati', 'Chapati', ${q(contributorId('REAL-PHONE-0003'))}, 'piece', 120)`);
  rows.push(`('chapati', 'Chapati', ${q(contributorId('REAL-PHONE-0004'))}, 'piece', 118)`);
  await h.sql(`insert into agni_dish_submissions (key, name, install_id, unit, kcal) values ${rows.join(', ')}`);
});
after(() => { if (skip) return; h.restoreFetch(); h.dropDatabase(); });
beforeEach(() => { if (skip) return; h.setTestEnv({ BETA_ADMIN_TOKEN: TOKEN, IP_HASH_SALT: 'test-salt-for-contributors' }); });

function op(body, token = TOKEN) {
  const headers = token ? { 'x-admin-token': token } : {};
  return h.call(quotaHandler, { method: 'POST', query: { op: 'test-dish-cleanup' }, headers, body: JSON.stringify(body) });
}
const published = () => h.sql(`select coalesce(string_agg(key, ',' order by key), '') from agni_community_dishes`);
const total = () => h.sql(`select count(*) from agni_dish_submissions`);

test('refused without the admin token, with a wrong one, and when admin ops are off', { skip }, async () => {
  assert.equal((await op({ mode: 'preview', pairs: PAIRS }, null)).statusCode, 401);
  assert.equal((await op({ mode: 'preview', pairs: PAIRS }, 'wrong-token')).statusCode, 401);
  delete process.env.BETA_ADMIN_TOKEN;
  assert.equal((await op({ mode: 'preview', pairs: PAIRS })).statusCode, 503);
});

test('no wildcards, no empty list, no name-only rows', { skip }, async () => {
  for (const pairs of [[], undefined, [{ key: 'coffee' }], [{ key: '%', install_id: SIMS[0] }], [{ install_id: SIMS[0] }]]) {
    const res = await op({ mode: 'preview', pairs });
    assert.equal(res.statusCode, 400, JSON.stringify(pairs));
  }
});

test('preview writes nothing and shows exactly which keys leave publication', { skip }, async () => {
  assert.equal(await published(), [...KEYS, 'chapati'].sort().join(','));
  const before = await total();
  const res = await op({ mode: 'preview', pairs: PAIRS });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(await total(), before, 'nothing written');
  const byKey = Object.fromEntries(res.json.keys.map(k => [k.key, k]));
  assert.deepEqual(Object.keys(byKey).sort(), [...KEYS].sort(), 'chapati is not touched at all');
  assert.equal(byKey['pint of beer'].matched, 5);
  assert.equal(byKey['pint of beer'].contributors_after, 1);
  assert.equal(byKey['rice'].contributors_after, 1);
  assert.ok(res.json.keys.every(k => k.published_now === true && k.published_after === false));
  assert.ok(!res.body.includes(SIMS[0]) && !res.body.includes('c1:'), 'no install id or hash in a response');
});

test('apply backs up and deletes exactly the 33 named rows; real rows and the real dish stay', { skip }, async () => {
  const res = await op({ mode: 'apply', pairs: PAIRS });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json.deleted, 33);
  assert.equal(res.json.backedUp, 33);
  assert.equal(res.json.keysUnpublished, 8);
  assert.equal(await total(), '4', 'two real fixture-key rows and the two chapati rows');
  assert.equal(await published(), 'chapati');
  const verify = await op({ mode: 'verify', pairs: PAIRS });
  assert.equal(verify.json.remaining, 0);
  assert.equal(verify.json.inBackup, 33);
  assert.deepEqual(verify.json.unpublishedKeys, [...KEYS].sort());
});

test('applying again changes nothing', { skip }, async () => {
  const res = await op({ mode: 'apply', pairs: PAIRS });
  assert.equal(res.json.deleted, 0);
  assert.equal(res.json.backedUp, 0);
});

test('rollback restores every backed-up row', { skip }, async () => {
  const res = await op({ mode: 'rollback' });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json.restored, 33);
  assert.equal(await total(), '37');
  assert.equal(await published(), [...KEYS, 'chapati'].sort().join(','));
});

test('a row already converted to the contributor hash is matched from its raw install id', { skip }, async () => {
  await h.sql(`update agni_dish_submissions set install_id = '${contributorId(SIMS[0])}'
                where install_id = '${SIMS[0]}' and key = 'toast'`);
  const res = await op({ mode: 'preview', pairs: [{ key: 'toast', install_id: SIMS[0] }] });
  assert.equal(res.json.keys[0].matched, 1);
});

test('the cleanup functions and backup table are service-role only', { skip }, async () => {
  const exposed = await h.sql(`select has_function_privilege('anon', 'agni_dish_cleanup_apply(jsonb)', 'execute')
                                   or has_table_privilege('anon', 'agni_dish_cleanup_backup_20261031', 'select')`);
  assert.equal(exposed, 'f');
});
