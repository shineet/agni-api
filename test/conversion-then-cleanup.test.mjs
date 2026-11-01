// THE RUNBOOK ORDER: contributor conversion first, test-dish cleanup second,
// then both rollbacks, on records that mirror production on 2026-10-31.
//
// The approved cleanup list names rows by RAW install id (that is what the
// read-only inventory saw). After conversion those rows hold `c1:...` hashes.
// This proves the cleanup still removes exactly the same 33 rows, keeps every
// legitimate contribution, never touches misses, and that both rollbacks put
// the tables back exactly. It also proves the reverse order ends in the same
// place.

import './helpers/no-network.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as h from './helpers/harness.mjs';

const skip = !h.enabled && 'AGNI_TEST_PG not set';
const TOKEN = 'admin-token-for-tests-0123456789';
const SALT = 'test-salt-for-contributors';
let quota, contributorId;

const SIMS = ['05F7BACD-A5F2-404F-B087-11564CBB2659', '13923BC8-6341-47C7-9C86-C87506BC5250',
              '42A5F948-3CF6-4898-86FB-1A2B0879F7A0', 'E01AEE34-0681-4687-97B5-DEDF5358FACB'];
const SIM_PINT_ONLY = '1DF058F8-F6A1-40A4-A8E6-F49C9E707F49';
const KEYS = ['amma s dal', 'coffee', 'lager pint', 'pint of beer', 'rice', 'test food', 'toast', 'vanishing curry'];
export const PAIRS = [...SIMS.flatMap(id => KEYS.map(key => ({ key, install_id: id }))),
                      { key: 'pint of beer', install_id: SIM_PINT_ONLY }];
const REAL_PINT = 'C8D973B3-1111-4222-8333-444455556666';
const REAL_RICE = 'AF89B83E-1111-4222-8333-444455556666';
const REAL_A = 'REALAAAA-0000-4000-8000-000000000001';
const REAL_B = 'REALBBBB-0000-4000-8000-000000000002';
const TWIN = 'TWINTWIN-0000-4000-8000-000000000003';

const q = s => `'${String(s).replace(/'/g, "''")}'`;

async function seed() {
  const rows = [];
  for (const id of SIMS) for (const key of KEYS) rows.push(`(${q(key)}, ${q(key)}, ${q(id)}, 'serving', 100, now() - interval '20 days')`);
  rows.push(`('pint of beer', 'Pint of beer', ${q(SIM_PINT_ONLY)}, 'serving', 224, now() - interval '40 days')`);
  // A TEST install that ALSO already has a hashed row on one of its keys (a
  // twin written after the server change): conversion merges it to one row.
  rows.push(`('toast', 'Toast', ${q(contributorId(SIMS[0]))}, 'serving', 160, now() - interval '1 day')`);
  // Legitimate contributions, raw (written before the server change).
  rows.push(`('pint of beer', 'Pint of beer', ${q(REAL_PINT)}, 'serving', 224, now() - interval '39 days')`);
  rows.push(`('rice', 'Rice', ${q(REAL_RICE)}, 'serving', 150, now() - interval '55 days')`);
  rows.push(`('chapati', 'Chapati', ${q(REAL_A)}, 'piece', 120, now() - interval '30 days')`);
  rows.push(`('chapati', 'Chapati', ${q(REAL_B)}, 'piece', 118, now() - interval '29 days')`);
  rows.push(`('dosa', 'Dosa', ${q(REAL_A)}, 'piece', 168, now() - interval '28 days')`);
  // A real phone with both a raw and a hashed row for the same dish.
  rows.push(`('upma', 'Upma', ${q(TWIN)}, 'bowl', 250, now() - interval '10 days')`);
  rows.push(`('upma', 'Upma', ${q(contributorId(TWIN))}, 'bowl', 255, now() - interval '2 days')`);
  rows.push(`('upma', 'Upma', ${q(REAL_B)}, 'bowl', 240, now() - interval '9 days')`);
  await h.sql(`insert into agni_dish_submissions (key, name, install_id, unit, kcal, created_at) values ${rows.join(', ')}`);
  // Misses, including one from a test install: the cleanup must not touch it.
  await h.sql(`insert into agni_dish_misses (key, name, kind, install_id, times) values
    ('kokum', 'Kokum', 'dish', ${q(REAL_A)}, 2), ('test appam', 'Test appam', 'dish', ${q(SIMS[1])}, 1)`);
}

const admin = (op, body) => h.call(quota, { method: 'POST', query: { op }, headers: { 'x-admin-token': TOKEN },
                                            body: JSON.stringify(body) });
const subs = () => h.sqlJSON(`select key, install_id, kcal::float as kcal from agni_dish_submissions order by key, install_id`);
const misses = () => h.sqlJSON(`select key, install_id, times from agni_dish_misses order by key, install_id`);
const published = () => h.sql(`select coalesce(string_agg(key, ',' order by key), '') from agni_community_dishes`);
const count = () => h.sql(`select count(*) from agni_dish_submissions`).then(Number);

before(async () => {
  if (skip) return;
  h.setTestEnv({ BETA_ADMIN_TOKEN: TOKEN, IP_HASH_SALT: SALT });
  h.installFetch();
  quota = (await import('../api/quota.js')).default;
  ({ contributorId } = await import('../api/_lib.js'));
});
after(() => { if (skip) return; h.restoreFetch(); h.dropDatabase(); });

test('conversion -> cleanup -> verify -> cleanup rollback -> conversion rollback hits exactly the 33', { skip }, async () => {
  h.freshDatabase('cvc_a');
  await seed();
  const initial = { subs: await subs(), misses: await misses() };
  const log = [];
  log.push(`seed: ${await count()} submissions, published: ${await published()}`);
  assert.equal(await count(), 42, '33 test rows, 1 hashed test twin, 8 legitimate rows');
  assert.equal(await published(), [...KEYS, 'chapati', 'upma'].sort().join(','));

  // 1. Conversion.
  const preview = await admin('contrib-migrate', { mode: 'preview' });
  assert.equal(preview.statusCode, 200, preview.body);
  const conv = await admin('contrib-migrate', { mode: 'apply' });
  assert.equal(conv.statusCode, 200, conv.body);
  const cverify = await admin('contrib-migrate', { mode: 'verify' });
  assert.equal(cverify.json.checks?.raw_submissions_left ?? cverify.json.raw_submissions_left, 0);
  assert.equal(cverify.json.checks?.changed_counts ?? cverify.json.changed_counts, 0);
  log.push(`after conversion: ${await count()} submissions (the two twins merged), raw left 0, changed counts 0`);
  assert.equal(await count(), 40, 'two twins merged: the test install on toast, the real phone on upma');
  assert.equal(await h.sql(`select count(*) from agni_dish_submissions where install_id not like 'c1:%'`), '0');

  // 2. Cleanup with the RAW pairs the inventory found.
  const cprev = await admin('test-dish-cleanup', { mode: 'preview', pairs: PAIRS });
  assert.equal(cprev.statusCode, 200, cprev.body);
  const matched = cprev.json.keys.reduce((n, k) => n + k.matched, 0);
  log.push(`cleanup preview: ${matched} rows matched across ${cprev.json.keys.length} keys`);
  assert.equal(matched, 33, 'the raw pairs find all 33 rows in their converted form');
  const apply = await admin('test-dish-cleanup', { mode: 'apply', pairs: PAIRS });
  assert.equal(apply.statusCode, 200, apply.body);
  assert.equal(apply.json.deleted, 33);
  assert.equal(apply.json.backedUp, 33);
  assert.equal(apply.json.keysUnpublished, 8);
  const v = await admin('test-dish-cleanup', { mode: 'verify', pairs: PAIRS });
  assert.equal(v.json.remaining, 0);
  log.push(`after cleanup: ${await count()} submissions, published: ${await published()}`);
  assert.equal(await count(), 7);
  assert.equal(await published(), 'chapati,upma', 'only dishes with two real contributors stay published');
  const left = await subs();
  for (const id of [REAL_PINT, REAL_RICE, REAL_A, REAL_B, TWIN]) {
    assert.ok(left.some(r => r.install_id === contributorId(id)), `legitimate contributor kept: ${id.slice(0, 8)}`);
  }
  assert.ok(!left.some(r => SIMS.concat(SIM_PINT_ONLY).map(contributorId).includes(r.install_id)), 'no test install row left');
  assert.equal((await misses()).length, 2, 'misses untouched by the cleanup');

  // 3. Cleanup rollback: the 33 come back in their CONVERTED form.
  const crb = await admin('test-dish-cleanup', { mode: 'rollback' });
  assert.equal(crb.json.restored, 33);
  assert.equal(await count(), 40);
  assert.equal(await h.sql(`select count(*) from agni_dish_submissions where install_id not like 'c1:%'`), '0',
               'restored rows are the converted rows, not raw ids');
  assert.equal(await published(), [...KEYS, 'chapati', 'upma'].sort().join(','));
  log.push(`after cleanup rollback: ${await count()} submissions, all converted, publication restored`);

  // 4. Conversion rollback: raw ids, twins and all, exactly as seeded.
  const rb = await admin('contrib-migrate', { mode: 'rollback' });
  assert.equal(rb.statusCode, 200, rb.body);
  assert.deepEqual(await subs(), initial.subs, 'every submission is back exactly as it was');
  assert.deepEqual(await misses(), initial.misses, 'every miss is back exactly as it was');
  log.push(`after conversion rollback: ${await count()} submissions, identical to the seed`);
  console.log(log.join('\n'));
});

test('the reverse order (cleanup, then conversion) ends with the same rows', { skip }, async () => {
  h.freshDatabase('cvc_b');
  await seed();
  const c = await admin('test-dish-cleanup', { mode: 'apply', pairs: PAIRS });
  assert.equal(c.statusCode, 200, c.body);
  // Before conversion, the twin on toast is a separate hashed row the raw pair
  // also names (the server matches raw and hash), so 34 rows go in this order.
  const deletedFirst = c.json.deleted;
  const conv = await admin('contrib-migrate', { mode: 'apply' });
  assert.equal(conv.statusCode, 200, conv.body);
  const reverse = await subs();

  h.freshDatabase('cvc_c');
  await seed();
  await admin('contrib-migrate', { mode: 'apply' });
  await admin('test-dish-cleanup', { mode: 'apply', pairs: PAIRS });
  const forward = await subs();

  assert.deepEqual(reverse, forward, 'both orders leave the same final rows');
  assert.equal(await published(), 'chapati,upma');
  console.log(`reverse order: cleanup removed ${deletedFirst} rows before conversion (the toast twin counted separately), final ${reverse.length} rows, same as forward`);
});
