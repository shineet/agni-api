// The shared dish table and the missed-dish list store a keyed hash of the
// install id, not the id itself, so the raw id no longer sits beside dish data
// (where a plain equality reached `dev:<install id>` usage records). The hash
// is pseudonymous: the server can recompute it. Every rule that needed to tell
// phones apart must still hold. The conversion of older rows is tested in
// contrib-migration.test.mjs.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as h from './helpers/harness.mjs';

const skip = !h.enabled && 'AGNI_TEST_PG not set';
const SALT = 'test-salt-for-contributors';
let dishes, misses, contributorId;

before(async () => {
  h.setTestEnv({ IP_HASH_SALT: SALT });
  ({ contributorId } = await import('../api/_lib.js'));
  if (!h.enabled) return;
  h.freshDatabase('contributor');
  h.installFetch();
  dishes = (await import('../api/dishes.js')).default;
  misses = (await import('../api/misses.js')).default;
});
after(() => { if (h.enabled) { h.restoreFetch(); h.dropDatabase(); } });
beforeEach(() => { h.setTestEnv({ IP_HASH_SALT: SALT }); });

async function post(handler, dev, pathName, body) {
  const raw = JSON.stringify(body);
  const headers = await dev.canonical('POST', pathName, {}, raw);
  return h.call(handler, { method: 'POST', headers: { ...headers, 'x-agni-install': dev.installId }, body: raw });
}

const chapati = { key: 'test chapati', name: 'Test chapati', kcal: 120, proteinG: 3, carbsG: 18, fatG: 4 };

test('contributorId: stable per install, different between installs, never the raw id', () => {
  const a = contributorId('INSTALL-aaaaaaaa');
  assert.match(a, /^c1:[0-9a-f]{32}$/);
  assert.equal(contributorId('INSTALL-aaaaaaaa'), a);
  assert.notEqual(contributorId('INSTALL-bbbbbbbb'), a);
  assert.ok(!a.includes('aaaaaaaa'));
  assert.equal(contributorId('short'), '', 'an id the SQL would refuse stays refused');
});

test('contributorId depends on the server key: the install id alone does not give it, the key and the id do', () => {
  const withSalt = contributorId('INSTALL-aaaaaaaa');
  process.env.IP_HASH_SALT = 'a-different-secret';
  assert.notEqual(contributorId('INSTALL-aaaaaaaa'), withSalt);
});

test('a dish is stored under the contributor hash, and the raw install id appears nowhere', { skip }, async () => {
  const dev = await h.device();
  const res = await post(dishes, dev, '/api/dishes', { dishes: [chapati] });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json.accepted, 1);
  const rows = await h.sqlJSON(`select install_id from agni_dish_submissions where key = 'test chapati'`);
  assert.deepEqual(rows, [{ install_id: contributorId(dev.installId) }]);
  const raw = await h.sql(`select count(*) from agni_dish_submissions where install_id = '${dev.installId}'`);
  assert.equal(raw, '0');
});

test('one phone re-entering a dish is still one voice; two phones publish it', { skip }, async () => {
  const one = await h.device();
  const two = await h.device();
  const dish = { ...chapati, key: 'test kothu', name: 'Test kothu' };
  await post(dishes, one, '/api/dishes', { dishes: [dish] });
  await post(dishes, one, '/api/dishes', { dishes: [{ ...dish, kcal: 130 }] });
  assert.equal(await h.sql(`select count(*) from agni_dish_submissions where key = 'test kothu'`), '1');
  assert.equal(await h.sql(`select count(*) from agni_community_dishes where key = 'test kothu'`), '0',
               'one voice is never published');
  await post(dishes, two, '/api/dishes', { dishes: [dish] });
  assert.equal(await h.sql(`select submitters from agni_community_dishes where key = 'test kothu'`), '2');
});

test('misses count people by contributor, and a re-sent running total does not double', { skip }, async () => {
  const one = await h.device();
  const two = await h.device();
  const miss = { key: 'test kozhukatta', name: 'Test kozhukatta', kind: 'namedByYou', times: 3 };
  await post(misses, one, '/api/misses', { misses: [miss] });
  await post(misses, one, '/api/misses', { misses: [miss] });
  await post(misses, two, '/api/misses', { misses: [{ ...miss, times: 1 }] });
  const [row] = await h.sqlJSON(`select people, times from agni_missing_dishes where key = 'test kozhukatta'`);
  assert.deepEqual(row, { people: 2, times: 4 });
  const ids = await h.sqlJSON(`select install_id from agni_dish_misses where key = 'test kozhukatta' order by install_id`);
  assert.deepEqual(ids.map(r => r.install_id).sort(),
                   [contributorId(one.installId), contributorId(two.installId)].sort());
});
