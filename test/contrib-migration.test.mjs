// The one-off conversion of stored raw install ids to contributor hashes, run
// as an admin op so the hashing secret never leaves the server process.
// Preview writes nothing, apply converts and backs up, verify proves it,
// rollback restores the exact rows, and only the admin token gets in.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as h from './helpers/harness.mjs';

const skip = !h.enabled && 'AGNI_TEST_PG not set';
const SALT = 'test-salt-for-contributor-migration';
const TOKEN = 'test-admin-token-0123456789';
let quota, dishes, misses, contributorId;

before(async () => {
  h.setTestEnv({ IP_HASH_SALT: SALT, BETA_ADMIN_TOKEN: TOKEN });
  if (!h.enabled) return;
  h.freshDatabase('contribmig');
  h.installFetch();
  ({ contributorId } = await import('../api/_lib.js'));
  quota = (await import('../api/quota.js')).default;
  dishes = (await import('../api/dishes.js')).default;
  misses = (await import('../api/misses.js')).default;
});
after(() => { if (h.enabled) { h.restoreFetch(); h.dropDatabase(); } });

function admin(mode, token = TOKEN) {
  const headers = token ? { 'x-admin-token': token } : {};
  return h.call(quota, { method: 'POST', query: { op: 'contrib-migrate' }, headers, body: JSON.stringify({ mode }) });
}

async function post(handler, dev, pathName, body) {
  const raw = JSON.stringify(body);
  const headers = await dev.canonical('POST', pathName, {}, raw);
  return h.call(handler, { method: 'POST', headers: { ...headers, 'x-agni-install': dev.installId }, body: raw });
}

const tables = async () => ({
  submissions: await h.sqlJSON(`select key, name, install_id, kcal::float as kcal from agni_dish_submissions order by key, install_id`),
  misses: await h.sqlJSON(`select key, kind, install_id, times from agni_dish_misses order by key, kind, install_id`)
});

const OLD = 'INSTALL-legacy-raw-1';
let both;

test('setup: old raw rows, and one phone with raw rows AND newer hashed twins', { skip }, async () => {
  both = await h.device();
  await h.sql(`insert into agni_dish_submissions (key, name, install_id, kcal) values
                 ('test idli', 'Test idli', '${OLD}', 60),
                 ('test dosa', 'Test dosa', '${both.installId}', 150)`);
  await h.sql(`insert into agni_dish_misses (key, name, kind, install_id, times) values
                 ('test appam', 'Test appam', 'searchFoundNothing', '${OLD}', 5),
                 ('test puttu', 'Test puttu', 'namedByYou', '${both.installId}', 7)`);
  // After the deploy the same phone sends again: these land hashed.
  await post(dishes, both, '/api/dishes', { dishes: [{ key: 'test dosa', name: 'Test dosa', kcal: 160, proteinG: 4, carbsG: 30, fatG: 3 }] });
  await post(misses, both, '/api/misses', { misses: [{ key: 'test puttu', name: 'Test puttu', kind: 'namedByYou', times: 2 }] });
  assert.equal(await h.sql(`select count(*) from agni_dish_submissions`), '3');
  assert.equal(await h.sql(`select count(*) from agni_dish_misses`), '3');
});

test('only the admin token gets in, compared without leaking length or content', { skip }, async () => {
  assert.equal((await admin('preview', null)).statusCode, 401);
  assert.equal((await admin('preview', 'wrong-token-0123456789x')).statusCode, 401);
  assert.equal((await admin('preview', 'short')).statusCode, 401);
  const saved = process.env.BETA_ADMIN_TOKEN;
  delete process.env.BETA_ADMIN_TOKEN;
  try { assert.equal((await admin('preview')).statusCode, 503, 'switched off without a token configured'); }
  finally { process.env.BETA_ADMIN_TOKEN = saved; }
  assert.equal((await admin('bogus')).statusCode, 400);
});

test('refuses to run without the real contributor key (it would write hashes nothing matches)', { skip }, async () => {
  const saved = process.env.IP_HASH_SALT;
  delete process.env.IP_HASH_SALT;
  try { assert.equal((await admin('preview')).statusCode, 503); }
  finally { process.env.IP_HASH_SALT = saved; }
});

let before_;
test('preview counts raw rows and merges and writes nothing', { skip }, async () => {
  before_ = await tables();
  const res = await admin('preview');
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual({ rawIds: res.json.rawIds, rawRows: res.json.rawRows, merges: res.json.merges },
                   { rawIds: 2, rawRows: { submissions: 2, misses: 2 }, merges: { submissions: 1, misses: 1 } });
  assert.deepEqual(await tables(), before_, 'preview changed nothing');
  assert.equal(await h.sql(`select count(*) from agni_dish_contrib_backup_20261031`), '0');
});

test('responses carry counts only: never an install id or a hash', { skip }, async () => {
  for (const mode of ['preview', 'verify']) {
    const body = (await admin(mode)).body;
    assert.ok(!body.includes(OLD) && !body.includes(both.installId), `${mode} leaked an id`);
    assert.ok(!/c1:[0-9a-f]{32}/.test(body), `${mode} leaked a hash`);
  }
});

test('apply converts to exactly what the server writes, merges twins, backs up, and verifies clean', { skip }, async () => {
  const res = await admin('apply');
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json.converted, { submissions: 1, misses: 1 });
  assert.deepEqual(res.json.merged, { submissions: 1, misses: 1 });
  // 2 raw rows + 2 hashed twins.
  assert.equal(res.json.backedUp.submissions + res.json.backedUp.misses, 6);
  assert.deepEqual(res.json.checks,
    { raw_submissions_left: 0, raw_misses_left: 0, changed_counts: 0, backup_rows: 6, snapshot_dishes: 4 });

  assert.equal(await h.sql(`select install_id from agni_dish_submissions where key = 'test idli'`), contributorId(OLD));
  assert.equal(await h.sql(`select install_id from agni_dish_misses where key = 'test appam'`), contributorId(OLD));
  assert.deepEqual(await h.sqlJSON(`select install_id, kcal::float as kcal from agni_dish_submissions where key = 'test dosa'`),
                   [{ install_id: contributorId(both.installId), kcal: 160 }], 'the newer hashed row wins');
  assert.deepEqual(await h.sqlJSON(`select install_id, times from agni_dish_misses where key = 'test puttu'`),
                   [{ install_id: contributorId(both.installId), times: 7 }], 'the larger running total is kept');
});

test('apply again is a no-op', { skip }, async () => {
  const after1 = await tables();
  const res = await admin('apply');
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json.rawIds, 0);
  assert.deepEqual(await tables(), after1);
  assert.equal(res.json.checks.backup_rows, 6, 'the backup keeps the oldest state');
});

test('rollback restores the exact rows, and the conversion can be applied again', { skip }, async () => {
  const res = await admin('rollback');
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(await tables(), before_, 'every row is back as it was');
  assert.equal(res.json.checks.raw_submissions_left, 2);

  const again = await admin('apply');
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(again.json.checks.raw_submissions_left, 0);
  assert.equal(again.json.checks.changed_counts, 0);
});

test('the migration tables and functions are locked down like every agni object', { skip }, async () => {
  const anonExec = await h.sql(`select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'agni%contrib%' and has_function_privilege('anon', p.oid, 'execute')`);
  assert.equal(anonExec, '0');
  const anonTable = await h.sql(`select count(*) from information_schema.role_table_grants
    where grantee = 'anon' and table_name like 'agni_dish_contrib%'`);
  assert.equal(anonTable, '0');
});
