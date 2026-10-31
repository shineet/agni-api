// Who may touch the database: the server's service role, and nobody else.
//
// The harness reproduces Supabase's default grants (every new function and
// table granted to anon and authenticated), so these tests fail the moment a
// schema file adds an object that schema-lockdown.sql does not cover. Before
// the lockdown, anon could register its own App Attest key and reset the
// service-wide day spend with a negative cost; the exploit tests below are
// those two calls, made as anon.

import './helpers/no-network.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import * as h from './helpers/harness.mjs';

const skip = !h.enabled && 'AGNI_TEST_PG not set';
const ROOT = path.join(import.meta.dirname, '..');

before(() => { if (h.enabled) h.freshDatabase('lockdown'); });
after(() => { if (h.enabled) h.dropDatabase(); });

/// Runs `text` as `role`, returning 'ok' or the Postgres error line.
async function as(role, text) {
  try {
    await h.sql(`set role ${role}; ${text}`);
    return 'ok';
  } catch (error) {
    return (String(error.stderr || error.message).match(/ERROR:\s+(.*)/) || [])[1] || 'error';
  }
}

test('no agni function is executable by anon, authenticated or PUBLIC', { skip }, async () => {
  const exposed = await h.sql(`select coalesce(string_agg(p.proname || ':' || r, ', ' order by p.proname), '')
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace, unnest(array['anon', 'authenticated']) r
    where n.nspname = 'public' and p.proname like 'agni%' and has_function_privilege(r, p.oid, 'execute')`);
  assert.equal(exposed, '');
  const toPublic = await h.sql(`select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
    aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where n.nspname = 'public' and p.proname like 'agni%' and a.grantee = 0 and a.privilege_type = 'EXECUTE'`);
  assert.equal(toPublic, '0', 'EXECUTE granted to PUBLIC reaches every role');
});

test('no agni table or view is readable or writable by anon or authenticated', { skip }, async () => {
  const exposed = await h.sql(`select coalesce(string_agg(c.relname || ':' || r || ':' || p, ', '), '')
    from pg_class c join pg_namespace n on n.oid = c.relnamespace,
         unnest(array['anon', 'authenticated']) r, unnest(array['select', 'insert', 'update', 'delete']) p
    where n.nspname = 'public' and c.relname like 'agni%' and c.relkind in ('r', 'v', 'm', 'p')
      and has_table_privilege(r, c.oid, p)`);
  assert.equal(exposed, '');
});

test('row level security is on for every agni table, and every view runs as its caller', { skip }, async () => {
  const noRLS = await h.sql(`select coalesce(string_agg(relname, ', '), '') from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and relname like 'agni%' and relkind in ('r', 'p') and not relrowsecurity`);
  assert.equal(noRLS, '', 'agni_ingredient_evidence was the one without it');
  const definerViews = await h.sql(`select coalesce(string_agg(relname, ', '), '') from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and relname like 'agni%' and relkind = 'v'
      and not coalesce('security_invoker=true' = any(reloptions), false)`);
  assert.equal(definerViews, '');
});

test('every security definer function has a pinned search_path', { skip }, async () => {
  const open = await h.sql(`select coalesce(string_agg(proname, ', '), '') from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and proname like 'agni%' and prosecdef
      and not exists (select 1 from unnest(coalesce(proconfig, '{}')) c where c like 'search_path=%')`);
  assert.equal(open, '');
});

// MARK: - The two exploits, as anon

test('EXPLOIT CLOSED: anon cannot register its own App Attest key', { skip }, async () => {
  const outcome = await as('anon',
    `select agni_attest_register('attacker-key', '-----BEGIN PUBLIC KEY-----x', 'production')`);
  assert.match(outcome, /permission denied/);
  assert.equal(await h.sql(`select count(*) from agni_attest_keys where key_id = 'attacker-key'`), '0');
});

test('EXPLOIT CLOSED: anon cannot walk the service-wide spend back with a negative cost', { skip }, async () => {
  await h.sql(`insert into agni_attest_keys (key_id, public_key_pem, environment) values ('k-spend', 'pem', 'production')
               on conflict do nothing; update agni_service set day_spend_usd = 40, day_start = now() where id = 1`);
  for (const call of [
    `select * from agni_attest_gate('k-spend', 100, -40, 10, 100, 1000, 1, 50)`,
    `select * from agni_attest_gate_class('k-spend', 101, 'research', 10, 100, -40, 1, 50)`
  ]) {
    assert.match(await as('anon', call), /permission denied/);
    assert.match(await as('authenticated', call), /permission denied/);
  }
  assert.equal(Number(await h.sql(`select day_spend_usd from agni_service`)), 40);
});

test('anon cannot write the nutrition caches every user is served', { skip }, async () => {
  for (const call of [
    `select agni_cache_variants('chicken biryani', '[{"kcal":1}]')`,
    `select agni_ingredient_evidence_put('rice', '{"kcal":1}', 999999)`,
    `insert into agni_ingredient_evidence (key, payload, expires_at) values ('rice', '{}', now() + interval '1 day')`,
    `select agni_submit_dish('installation-x', 'idli', 'Idli', 'piece', 40, 60, 2, 12, 0.2)`
  ]) assert.match(await as('anon', call), /permission denied/, call);
});

test('anon cannot read testers’ emails or auth telemetry', { skip }, async () => {
  assert.match(await as('anon', `select * from agni_beta_list()`), /permission denied/);
  assert.match(await as('anon', `select * from agni_auth_summary(14)`), /permission denied/);
});

// MARK: - The server keeps working

test('the service role can execute every function the server calls', { skip }, async () => {
  const source = readdirSync(path.join(ROOT, 'api')).filter(f => f.endsWith('.js'))
    .map(f => readFileSync(path.join(ROOT, 'api', f), 'utf8')).join('\n');
  const called = [...new Set([...source.matchAll(/['"`/](agni_[a-z_]+)['"`(]/g)].map(m => m[1]))];
  const existing = new Set((await h.sql(`select proname from pg_proc where proname like 'agni%'`)).split('\n'));
  const functions = called.filter(name => existing.has(name));
  assert.ok(functions.length >= 30, `found only ${functions.length} called functions; the scan is broken`);
  const missing = [];
  for (const name of functions) {
    const ok = await h.sql(`select bool_and(has_function_privilege('service_role', oid, 'execute'))
                              from pg_proc where proname = '${name}'`);
    if (ok !== 't') missing.push(name);
  }
  assert.deepEqual(missing, []);
});

test('as the service role, the community search still reads through its view', { skip }, async () => {
  await h.sql(`insert into agni_dish_submissions (key, name, install_id, unit, grams_per_unit, kcal, protein_g, carbs_g, fat_g)
               values ('masala dosa', 'Masala dosa', 'install-aaaa', 'piece', 180, 350, 7, 50, 12),
                      ('masala dosa', 'Masala dosa', 'install-bbbb', 'piece', 180, 350, 7, 50, 12)`);
  const rows = await h.sql(`set role service_role; select key || ':' || submitters from agni_search_dishes('dosa', 5)`);
  assert.equal(rows.split('\n').pop(), 'masala dosa:2', 'two submitters is the view\'s threshold');
});
