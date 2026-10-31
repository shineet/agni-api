// The shared dish table and the missed-dish list store a keyed hash of the
// install id, not the id itself, so neither can be joined to a phone's usage
// records (`dev:<install id>`). Every rule that needed to tell phones apart
// must still hold, and the prepared cleanup of older rows must produce the
// same value the server now writes.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as h from './helpers/harness.mjs';

const skip = !h.enabled && 'AGNI_TEST_PG not set';
const ROOT = path.join(import.meta.dirname, '..');
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

test('contributorId depends on the secret, so it cannot be recomputed from the install id alone', () => {
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

test('the prepared cleanup converts old raw rows to exactly what the server now writes', { skip }, async () => {
  await h.sql(`create schema if not exists extensions; create extension if not exists pgcrypto schema extensions;`);
  const old = 'INSTALL-legacy-raw-1';
  const both = await h.device();
  // A raw row from before the change, and the same phone's raw AND hashed rows
  // for one dish (it submitted again after the deploy, before the cleanup).
  await h.sql(`insert into agni_dish_submissions (key, name, install_id, kcal) values
                 ('test idli', 'Test idli', '${old}', 60),
                 ('test dosa', 'Test dosa', '${both.installId}', 150)`);
  await h.sql(`insert into agni_dish_misses (key, name, kind, install_id, times) values
                 ('test appam', 'Test appam', 'searchFoundNothing', '${old}', 5),
                 ('test puttu', 'Test puttu', 'namedByYou', '${both.installId}', 7)`);
  await post(dishes, both, '/api/dishes', { dishes: [{ ...chapati, key: 'test dosa', name: 'Test dosa', kcal: 160 }] });
  await post(misses, both, '/api/misses', { misses: [{ key: 'test puttu', name: 'Test puttu', kind: 'namedByYou', times: 2 }] });

  const migration = readFileSync(path.join(ROOT, 'migrations/2026-10-31-dish-install-id-cleanup.sql'), 'utf8')
    .replaceAll('PASTE_IP_HASH_SALT_HERE', SALT);
  const left = await h.sql(migration);
  assert.match(left, /^submissions\|2\|1\nmisses\|2\|1\n/, 'the preview counts raw rows and raw rows with a hashed twin');
  assert.match(left, /\n0\nCOMMIT$/, 'the guard query reports no raw rows left');

  assert.equal(await h.sql(`select install_id from agni_dish_submissions where key = 'test idli'`), contributorId(old));
  assert.equal(await h.sql(`select install_id from agni_dish_misses where key = 'test appam'`), contributorId(old));
  const dosa = await h.sqlJSON(`select install_id, kcal from agni_dish_submissions where key = 'test dosa'`);
  assert.deepEqual(dosa, [{ install_id: contributorId(both.installId), kcal: 160 }], 'the newer hashed row wins');
  const puttu = await h.sqlJSON(`select install_id, times from agni_dish_misses where key = 'test puttu'`);
  assert.deepEqual(puttu, [{ install_id: contributorId(both.installId), times: 7 }], 'the larger running total is kept');
  assert.equal(await h.sql(`select count(*) from agni_dish_submissions where install_id not like 'c1:%'`), '0');

  // Running it again changes nothing.
  await h.sql(migration);
  assert.equal(await h.sql(`select count(*) from agni_dish_misses where key = 'test puttu'`), '1');
});
