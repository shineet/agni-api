import './helpers/no-network.mjs';
// MIGRATION REVIEW: the branch's SQL applied on top of the schema production
// runs today (commit 3ef4e97), with representative data, then applied AGAIN.
//
// Proves, on a real Postgres with Supabase's default grants simulated:
//   1. the new files apply cleanly in the runbook order on the 3ef4e97 schema;
//   2. no existing data row changes on the first apply (only new columns, NULL);
//   3. a second apply changes nothing: functions (signature + body md5),
//      grants, RLS, view options, columns, constraints and every data row;
//   4. the transient window: after re-running schema-billing.sql BEFORE
//      lockdown, which functions are callable by anon (the recreated ones);
//   5. no overload of agni_reserve is left behind.
// Writes the snapshot diffs to the console for docs/migration-review.md.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PSQL = process.env.PSQL || 'psql';
const PG_URL = process.env.AGNI_TEST_PG;
const skip = !PG_URL && 'AGNI_TEST_PG not set';
const base = PG_URL ? PG_URL.replace(/\/[^/]*$/, '') : '';
const DB = `agni_migration_review_${process.pid}`;
const url = () => `${base}/${DB}`;

const OLD_FILES = ['schema.sql', 'schema-attest.sql', 'schema-limits.sql', 'schema-auth.sql',
  'schema-variants.sql', 'schema-community.sql', 'schema-misses.sql', 'schema-ingredient-cache.sql',
  'schema-beta.sql', 'schema-billing.sql', 'schema-lockdown.sql'];
export const NEW_ORDER = ['migrations/2026-10-31-device-attribution.sql', 'schema-billing.sql',
  'schema-community.sql', 'schema-misses.sql', 'schema-deletion.sql', 'schema-retention.sql',
  'schema-contributor-migration.sql', 'schema-dish-cleanup.sql', 'schema-lockdown.sql'];

const psql = (args, input) => execFileSync(PSQL, args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
const run = (text) => psql([url(), '-At', '-v', 'ON_ERROR_STOP=1', '-c', text]).trim();
const applyText = (text) => psql([url(), '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'], text);
const applyFile = (file) => psql([url(), '-q', '-v', 'ON_ERROR_STOP=1', '-f', path.join(ROOT, file)]);
const oldText = (file) => execFileSync('git', ['-C', ROOT, 'show', `3ef4e97:${file}`], { encoding: 'utf8' });

const FIXTURE = `
insert into agni_subjects (subject_id, kind) values ('dev:AAAA0000-0000-0000-0000-000000000001', 'device'),
  ('dev:BBBB0000-0000-0000-0000-000000000002', 'device');
insert into agni_subjects (subject_id, kind, environment, product_id, original_transaction_id, expires_date)
  values ('sbx:2000000000000001', 'subscription', 'Sandbox', 'com.shinethankappan.agni.pro.annual', '2000000000000001', now() + interval '1 day');
insert into agni_key_links (key_id, device_subject, subscription_subject)
  values ('key-a', 'dev:AAAA0000-0000-0000-0000-000000000001', 'sbx:2000000000000001'),
         ('key-b', 'dev:BBBB0000-0000-0000-0000-000000000002', null);
insert into agni_usage_events (subject_id, request_id, action_id, feature, bucket, tier, auth_path, model, period_start, day, reserved_usd, status, actual_usd)
  values ('sbx:2000000000000001', 'r1', 'a1', 'photo', 'photo', 'sandbox', 'attest', 'claude-sonnet-5', date_trunc('month', now()), current_date, 0.11, 'settled', 0.015),
         ('dev:BBBB0000-0000-0000-0000-000000000002', 'r2', 'a2', 'variant_search', 'search', 'beta', 'attest', 'claude-haiku-4-5', date_trunc('month', now()), current_date, 0.02, 'reserved', null);
insert into agni_actions (subject_id, action_id, bucket, period_start, calls, credited)
  values ('sbx:2000000000000001', 'a1', 'photo', date_trunc('month', now()), 1, true);
insert into agni_allowance_periods (subject_id, period_start, period_end, tier, photo_used)
  values ('sbx:2000000000000001', date_trunc('month', now()), date_trunc('month', now()) + interval '1 month', 'trial', 1);
insert into agni_subject_days (subject_id, day, photo_count) values ('sbx:2000000000000001', current_date, 1);
insert into agni_dish_submissions (key, name, install_id, kcal) values
  ('coffee', 'Coffee', '05F7BACD-A5F2-404F-B087-11564CBB2659', 120),
  ('coffee', 'Coffee', 'E01AEE34-0681-4687-97B5-DEDF5358FACB', 120),
  ('rice', 'Rice', 'AF89B83E-1111-4222-8333-444455556666', 150);
insert into agni_dish_misses (key, name, kind, install_id, times) values ('kokum', 'Kokum', 'dish', 'CCCC0000-0000-0000-0000-000000000003', 2);
insert into agni_store_notifications (notification_uuid, notification_type, original_transaction_id)
  values ('n-1', 'SUBSCRIBED', '2000000000000001');
insert into agni_beta_signups (email, name) values ('tester@example.com', 'Tester');
`;

const SNAPSHOT = `
select json_build_object(
 'functions', (select json_agg(json_build_object('sig', p.oid::regprocedure::text, 'md5', md5(p.prosrc),
     'secdef', p.prosecdef, 'config', p.proconfig,
     'anon', has_function_privilege('anon', p.oid, 'execute'),
     'auth', has_function_privilege('authenticated', p.oid, 'execute'),
     'svc', has_function_privilege('service_role', p.oid, 'execute')) order by p.oid::regprocedure::text)
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'agni%'),
 'relations', (select json_agg(json_build_object('rel', c.relname, 'kind', c.relkind, 'rls', c.relrowsecurity,
     'options', c.reloptions, 'anon_select', has_table_privilege('anon', c.oid, 'select'),
     'auth_select', has_table_privilege('authenticated', c.oid, 'select')) order by c.relname)
   from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname like 'agni%' and c.relkind in ('r','v','m','p')),
 'columns', (select json_agg(table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '') order by table_name, ordinal_position)
   from information_schema.columns where table_schema = 'public' and table_name like 'agni%'),
 'constraints', (select json_agg(conrelid::regclass::text || '.' || conname || ':' || pg_get_constraintdef(oid) order by 1)
   from pg_constraint where connamespace = 'public'::regnamespace and conrelid::regclass::text like 'agni%')
)`;

function dataFingerprint() {
  const tables = run(`select string_agg(relname, ' ' order by relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and relname like 'agni%' and relkind = 'r'`).split(' ');
  const out = {};
  for (const t of tables) {
    // Only the columns that existed at 3ef4e97 for tables that gain columns,
    // so "unchanged data" means the old values, not the new NULL column.
    out[t] = run(`select count(*) || ':' || coalesce(md5(string_agg(x, '|' order by x)), '-') from
      (select (to_jsonb(t) - 'device_subject')::text as x from ${t} t) s`);
  }
  return out;
}

function diff(a, b) {
  const changes = [];
  for (const k of Object.keys(a)) {
    const left = new Map((a[k] || []).map(x => [typeof x === 'string' ? x : (x.sig || x.rel), JSON.stringify(x)]));
    const right = new Map((b[k] || []).map(x => [typeof x === 'string' ? x : (x.sig || x.rel), JSON.stringify(x)]));
    for (const [id, v] of right) if (left.get(id) !== v) changes.push(`${k}: ${left.has(id) ? 'changed' : 'added'} ${id}`);
    for (const id of left.keys()) if (!right.has(id)) changes.push(`${k}: removed ${id}`);
  }
  return changes;
}

const snapshot = () => JSON.parse(run(SNAPSHOT));

test.before(() => {
  if (skip) return;
  psql([PG_URL, '-q', '-c', `drop database if exists ${DB} with (force)`]);
  psql([PG_URL, '-q', '-c', `create database ${DB}`]);
  for (const role of ['anon', 'authenticated', 'service_role']) {
    psql([PG_URL, '-q', '-c', `do $$ begin create role ${role}; exception when duplicate_object then null; end $$`]);
  }
  run(`alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
       alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;`);
});
test.after(() => { if (!skip) psql([PG_URL, '-q', '-c', `drop database if exists ${DB} with (force)`]); });

test('the branch SQL on the 3ef4e97 schema: clean first apply, no data change, second apply changes nothing', { skip }, () => {
  for (const f of OLD_FILES) applyText(oldText(f));
  applyText(FIXTURE);
  const before = snapshot();
  const dataBefore = dataFingerprint();

  // FIRST-APPLY WINDOW: everything except lockdown, then measure exposure.
  for (const f of NEW_ORDER.slice(0, -1)) applyFile(f);
  const preLock = snapshot();
  const preLockExposed = preLock.functions.filter(f => f.anon || f.auth).map(f => f.sig);
  console.log('FIRST APPLY, ANON/AUTHENTICATED-CALLABLE BEFORE lockdown (' + preLockExposed.length + '):\n  ' + preLockExposed.join('\n  '));
  const preLockTables = preLock.relations.filter(r => r.anon_select || r.auth_select).map(r => r.rel);
  console.log('FIRST APPLY, ANON-READABLE RELATIONS BEFORE lockdown (' + preLockTables.length + '):\n  ' + preLockTables.join('\n  '));
  applyFile(NEW_ORDER[NEW_ORDER.length - 1]);
  const first = snapshot();
  const dataFirst = dataFingerprint();
  const firstChanges = diff(before, first);
  console.log('FIRST APPLY CHANGES (' + firstChanges.length + '):\n  ' + firstChanges.join('\n  '));
  for (const t of Object.keys(dataBefore)) assert.equal(dataFirst[t], dataBefore[t], `no existing data row changes on the first apply (${t})`);
  const added = Object.keys(dataFirst).filter(t => !(t in dataBefore));
  assert.ok(added.every(t => dataFirst[t] === '0:-'), 'new tables start empty: ' + added.join(', '));

  // Nothing callable by anon or authenticated once lockdown has run.
  const exposed = first.functions.filter(f => f.anon || f.auth).map(f => f.sig);
  assert.deepEqual(exposed, [], 'no agni function callable by anon/authenticated after lockdown');
  const reserve = first.functions.filter(f => f.sig.startsWith('agni_reserve('));
  assert.equal(reserve.length, 1, 'exactly one agni_reserve overload: ' + reserve.map(r => r.sig).join(' ; '));

  // THE TRANSIENT WINDOW: re-run schema-billing alone, before lockdown.
  applyFile('schema-billing.sql');
  const window = snapshot();
  const windowExposed = window.functions.filter(f => f.anon || f.auth).map(f => f.sig);
  console.log('ANON/AUTHENTICATED-CALLABLE AFTER RE-RUNNING schema-billing.sql, BEFORE lockdown (' + windowExposed.length + '):\n  ' + windowExposed.join('\n  '));

  // Second full apply.
  for (const f of NEW_ORDER) applyFile(f);
  const second = snapshot();
  const secondChanges = diff(first, second);
  console.log('SECOND APPLY CHANGES (' + secondChanges.length + '):\n  ' + secondChanges.join('\n  '));
  assert.deepEqual(secondChanges, [], 'a second apply changes no function, grant, RLS flag, option, column or constraint');
  assert.deepEqual(dataFingerprint(), dataFirst, 'a second apply changes no data');
});

// THE ATOMIC RELEASE SCRIPT: same end state as file by file, idempotent, and
// all-or-nothing.
test('migrations/2026-10-31-release.sql: current, same end state, idempotent, atomic', { skip }, async () => {
  const { buildRelease } = await import('../scripts/build-release-sql.mjs');
  const { readFileSync } = await import('node:fs');
  assert.equal(readFileSync(path.join(ROOT, 'migrations/2026-10-31-release.sql'), 'utf8'), buildRelease(),
    'the release file is regenerated after every schema change (node scripts/build-release-sql.mjs)');

  const fresh = (name) => {
    psql([PG_URL, '-q', '-c', `drop database if exists ${name} with (force)`]);
    psql([PG_URL, '-q', '-c', `create database ${name}`]);
    const u = `${base}/${name}`;
    psql([u, '-q', '-c', `alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
      alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;`]);
    for (const f of OLD_FILES) psql([u, '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'], oldText(f));
    psql([u, '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'], FIXTURE);
    return u;
  };
  const snap = (u) => JSON.parse(psql([u, '-At', '-c', SNAPSHOT]).trim());
  const applyRelease = (u) => psql([u, '-q', '-v', 'ON_ERROR_STOP=1', '-f', path.join(ROOT, 'migrations/2026-10-31-release.sql')]);

  const a = `${DB}_rel`, b = `${DB}_files`, c = `${DB}_fail`;
  try {
    const ua = fresh(a); applyRelease(ua);
    const ub = fresh(b); for (const f of NEW_ORDER) psql([ub, '-q', '-v', 'ON_ERROR_STOP=1', '-f', path.join(ROOT, f)]);
    const sa = snap(ua), sb = snap(ub);
    assert.deepEqual(diff(sb, sa), [], 'release script and file-by-file reach the same schema and grants');
    applyRelease(ua);
    assert.deepEqual(diff(sa, snap(ua)), [], 'running the release script twice changes nothing');

    // All or nothing: a failure part-way leaves the 3ef4e97 schema untouched.
    const uc = fresh(c);
    const before = snap(uc);
    const broken = readFileSync(path.join(ROOT, 'migrations/2026-10-31-release.sql'), 'utf8')
      .replace('-- ===== schema-lockdown.sql =====', '-- ===== schema-lockdown.sql =====\nselect 1/0;');
    assert.throws(() => psql([uc, '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'], broken));
    assert.deepEqual(diff(before, snap(uc)), [], 'a failure before lockdown leaves nothing applied, so nothing is exposed');
  } finally {
    for (const n of [a, b, c]) psql([PG_URL, '-q', '-c', `drop database if exists ${n} with (force)`]);
  }
});

// HAZARD, recorded as a test so the runbook's warning stays true: re-applying
// the 3ef4e97 schema-billing.sql AFTER the release recreates the 22-argument
// agni_reserve beside the 23-argument one, and every reservation from either
// server then fails "function agni_reserve(...) is not unique". Rolling back
// means redeploying the 3ef4e97 SERVER only; never its SQL.
test('re-applying the 3ef4e97 schema-billing after the release breaks reservations (never do it)', { skip }, () => {
  const name = `${DB}_hazard`;
  const u = `${base}/${name}`;
  try {
    psql([PG_URL, '-q', '-c', `drop database if exists ${name} with (force)`]);
    psql([PG_URL, '-q', '-c', `create database ${name}`]);
    for (const f of OLD_FILES) psql([u, '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'], oldText(f));
    psql([u, '-q', '-v', 'ON_ERROR_STOP=1', '-f', path.join(ROOT, 'migrations/2026-10-31-release.sql')]);
    const call = `select allowed from agni_reserve(p_subject=>'dev:X', p_subject_kind=>'device', p_request_id=>'r',
      p_action_id=>'a', p_feature=>'photo', p_bucket=>'photo', p_counts=>true, p_tier=>'free', p_auth_path=>'attested',
      p_model=>'claude-sonnet-5', p_period_start=>now(), p_period_end=>'infinity', p_limit=>3, p_cost_cap=>0.5,
      p_day_cost_cap=>null, p_burst=>3, p_uncredited_day_cap=>60, p_reserve_usd=>0.05, p_max_calls_per_action=>8,
      p_stale_seconds=>180, p_budget_tier=>'free', p_max_open=>6)`;
    assert.equal(psql([u, '-At', '-c', call]).trim(), 't', 'the old server\'s call works against the release');
    psql([u, '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'], oldText('schema-billing.sql'));
    assert.equal(psql([u, '-At', '-c', `select count(*) from pg_proc where proname = 'agni_reserve'`]).trim(), '2');
    assert.throws(() => psql([u, '-At', '-c', call]), /is not unique/);
  } finally {
    psql([PG_URL, '-q', '-c', `drop database if exists ${name} with (force)`]);
  }
});
