// The cost safeguard's early-stop path, end to end: the person is told the
// truth, the stop is recorded where the operator can find it, a bounded
// restore lets them continue, and nothing else about their purchase or counts
// moves. Also the one-web-call-in-flight bound the exposure figures rely on.
//
//   AGNI_TEST_PG=postgresql://postgres@127.0.0.1:55432/postgres node --test test/cost-cap-restore.test.mjs

import './helpers/no-network.mjs';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as h from './helpers/harness.mjs';

const skip = !h.enabled && 'AGNI_TEST_PG not set';
let estimateHandler, quotaHandler, supportId, allowances;
const ADMIN = 'admin-test-token';

before(async () => {
  if (skip) return;
  h.setTestEnv({ BETA_ADMIN_TOKEN: ADMIN });
  h.freshDatabase('caprestore');
  h.installFetch();
  estimateHandler = (await import('../api/estimate.js')).default;
  quotaHandler = (await import('../api/quota.js')).default;
  ({ supportId } = await import('../api/_lib.js'));
  ({ allowances } = await import('../api/_billing.js'));
});

after(() => {
  if (skip) return;
  h.restoreFetch();
  h.dropDatabase();
});

beforeEach(() => {
  if (skip) return;
  h.anthropic.reset();
  h.setTestEnv({ BETA_ADMIN_TOKEN: ADMIN });
});

const photo = () => h.modelRequest({ image: h.PHOTO_B64 });
let seq = 0;
const id = p => `${p}-${Date.now()}-${(seq += 1)}`;
const admin = (op, body, token = ADMIN) =>
  h.call(quotaHandler, { method: 'POST', query: { op }, headers: token ? { 'x-admin-token': token } : {}, body });

/// A Pro subscriber pushed to just under the safeguard, so the next photo is
/// refused by the cost cap while 99 photo credits remain.
async function stoppedSubscriber() {
  const dev = await h.device();
  const otid = 'OT' + Date.now() + (seq += 1);
  const subject = await h.subscribe(dev, { otid, purchase: h.daysFromNow(-3), expires: h.daysFromNow(27) });
  const first = await h.estimate(estimateHandler, dev, { feature: 'photo', actionId: id('a'), requestId: id('r'), request: photo() });
  assert.equal(first.statusCode, 200, first.body);
  await h.sql(`update agni_allowance_periods set cost_usd = ${allowances().pro.costCapUSD - 0.01} where subject_id = '${subject}'`);
  const res = await h.estimate(estimateHandler, dev, { feature: 'photo', actionId: id('a'), requestId: id('r'), request: photo() });
  return { dev, subject, otid, res };
}

test('the approved Pro safeguard is $6.50, trial $2, Free $0.75', { skip }, () => {
  assert.equal(allowances().pro.costCapUSD, 6.5);
  assert.equal(allowances().trial.costCapUSD, 2);
  assert.equal(allowances().free.costCapUSD, 0.75);
  assert.deepEqual([allowances().pro.photo, allowances().pro.search, allowances().pro.web, allowances().pro.burst],
                   [100, 60, 5, 25]);
});

test('an early stop tells the truth, is recorded, and alerts without a subject', { skip }, async () => {
  const { subject, res } = await stoppedSubscriber();
  assert.equal(res.statusCode, 402);
  assert.equal(res.json.allowance.bucket, 'cost');
  assert.equal(res.json.allowance.safeguard, true);
  assert.match(res.json.error.message, /cost safeguard before your allowance ran out/);
  assert.match(res.json.error.message, /Support ID/);
  assert.doesNotMatch(res.json.error.message, /used this period/);
  const stops = await h.sqlJSON(`select used, lim, stops from agni_cost_cap_stops where subject_id = '${subject}'`);
  assert.equal(stops.length, 1);
  assert.equal(stops[0].used, 1);
  assert.equal(stops[0].lim, 100);
  const alerts = await h.sqlJSON(`select detail from agni_alerts where kind = 'cost_cap_before_counts'`);
  assert.ok(alerts.length >= 1);
  assert.ok(!JSON.stringify(alerts).includes(subject), 'no subject in any alert');
});

test('a stop with no credits left is the ordinary limit, not an early stop', { skip }, async () => {
  const dev = await h.device();
  const subject = await h.subscribe(dev, { purchase: h.daysFromNow(-3), expires: h.daysFromNow(27) });
  await h.estimate(estimateHandler, dev, { feature: 'photo', actionId: id('a'), requestId: id('r'), request: photo() });
  await h.sql(`update agni_allowance_periods set photo_used = 99, cost_usd = 6.49 where subject_id = '${subject}'`);
  const res = await h.estimate(estimateHandler, dev, { feature: 'photo', actionId: id('a'), requestId: id('r'), request: photo() });
  assert.equal(res.statusCode, 402);
  // 99 of 100 used: still a credit left, so this IS early. Use the last one up.
  await h.sql(`update agni_allowance_periods set photo_used = 100 where subject_id = '${subject}'`);
  const res2 = await h.estimate(estimateHandler, dev, { feature: 'photo', actionId: id('a'), requestId: id('r'), request: photo() });
  assert.equal(res2.json.allowance.bucket, 'photo', 'with no credits left the counts are the answer');
});

test('the operator finds the stopped subscription by the Support ID the person reads out', { skip }, async () => {
  const { dev, otid } = await stoppedSubscriber();
  const list = await admin('cost-cap-stops', {});
  assert.equal(list.statusCode, 200, list.body);
  const sid = supportId(dev.installId);
  const mine = list.json.stops.find(s => s.supportIds.includes(sid));
  assert.ok(mine, 'the stop lists the Support ID of the linked phone');
  assert.equal(mine.tier, 'pro');
  assert.equal(mine.kind, 'subscription');
  assert.equal(mine.periodRunning, true);
  assert.match(mine.ref, /^[0-9a-f]{16}$/);
  assert.ok(!list.body.includes(otid), 'no purchase identifier in the response');
  assert.ok(!list.body.includes(dev.installId), 'no install id in the response');
  assert.ok(!list.body.includes('sub:'), 'no subject in the response');
});

test('restore: preview changes nothing; apply lets them continue; counts and purchase untouched', { skip }, async () => {
  const { dev, subject, otid } = await stoppedSubscriber();
  const sid = supportId(dev.installId);
  const before = await h.sqlJSON(`select product_id, expires_date, original_transaction_id from agni_subjects where subject_id = '${subject}'`);
  const periodBefore = (await h.sqlJSON(`select photo_used, search_used, web_used from agni_allowance_periods where subject_id = '${subject}'`))[0];

  const preview = await admin('cost-cap-restore', { mode: 'preview', supportId: sid });
  assert.equal(preview.statusCode, 200, preview.body);
  assert.equal(preview.json.wouldGrantUSD, 6.5);
  assert.equal(Number(await h.sql(`select cost_cap_grant_usd from agni_allowance_periods where subject_id = '${subject}'`)), 0,
               'preview wrote nothing');

  const applied = await admin('cost-cap-restore', { mode: 'apply', supportId: sid });
  assert.equal(applied.statusCode, 200, applied.body);
  assert.equal(applied.json.grantedUSD, 6.5);
  assert.ok(!applied.body.includes(otid) && !applied.body.includes('sub:'));

  const res = await h.estimate(estimateHandler, dev, { feature: 'photo', actionId: id('a'), requestId: id('r'), request: photo() });
  assert.equal(res.statusCode, 200, 'AI works again after the restore');

  const after = await h.sqlJSON(`select product_id, expires_date, original_transaction_id from agni_subjects where subject_id = '${subject}'`);
  assert.deepEqual(after, before, 'the purchase record is untouched');
  const periodAfter = (await h.sqlJSON(`select photo_used, search_used, web_used from agni_allowance_periods where subject_id = '${subject}'`))[0];
  assert.equal(periodAfter.photo_used, periodBefore.photo_used + 1, 'the new photo used a credit as normal');
  assert.equal(periodAfter.search_used, periodBefore.search_used);

  const status = await h.attestedGet(quotaHandler, dev, '/api/quota', { installId: dev.installId });
  assert.equal(status.statusCode, 200, status.body);
  assert.ok(status.json.allowance.budgetUsedFraction < 0.6, 'the warning reads against the restored headroom');
  assert.equal(status.json.allowance.buckets.photo.limit, 100, 'the count is still the advertised one');

  const restoredAlert = await h.sqlJSON(`select detail from agni_alerts where kind = 'cost_cap_restored'`);
  assert.ok(restoredAlert.length >= 1);
  assert.ok(!JSON.stringify(restoredAlert).includes(subject));
});

test('restore is bounded: never more than the tier cap per period, and never unlimited', { skip }, async () => {
  const { dev, subject } = await stoppedSubscriber();
  const sid = supportId(dev.installId);
  assert.equal((await admin('cost-cap-restore', { mode: 'apply', supportId: sid, amountUSD: 4 })).json.grantedUSD, 4);
  const second = await admin('cost-cap-restore', { mode: 'apply', supportId: sid, amountUSD: 6.5 });
  assert.equal(second.json.grantedUSD, 2.5, 'topped up only to the tier cap');
  const third = await admin('cost-cap-restore', { mode: 'apply', supportId: sid });
  assert.equal(third.statusCode, 409);
  assert.equal(third.json.reason, 'grant_limit');
  assert.equal((await admin('cost-cap-restore', { mode: 'apply', supportId: sid, amountUSD: 100 })).statusCode, 400);
  // Counts still bind after a restore.
  await h.sql(`update agni_allowance_periods set photo_used = 100 where subject_id = '${subject}'`);
  const res = await h.estimate(estimateHandler, dev, { feature: 'photo', actionId: id('a'), requestId: id('r'), request: photo() });
  assert.equal(res.statusCode, 402);
  assert.equal(res.json.allowance.bucket, 'photo');
});

test('restore refuses anyone not recorded as stopped early, and anyone without the token', { skip }, async () => {
  const dev = await h.device();
  await h.subscribe(dev, { purchase: h.daysFromNow(-3), expires: h.daysFromNow(27) });
  const sid = supportId(dev.installId);
  assert.equal((await admin('cost-cap-restore', { mode: 'apply', supportId: sid })).statusCode, 404);
  assert.equal((await admin('cost-cap-restore', { mode: 'apply', supportId: sid }, 'wrong')).statusCode, 401);
  assert.equal((await admin('cost-cap-stops', {}, null)).statusCode, 401);
  delete process.env.BETA_ADMIN_TOKEN;
  assert.equal((await admin('cost-cap-stops', {}, 'anything')).statusCode, 503);
  // The SQL itself refuses without a recorded stop, whoever calls it.
  const subject = (await h.sqlJSON(`select subscription_subject from agni_key_links where device_subject = 'dev:${dev.installId}'`))[0]
    .subscription_subject;
  const start = (await h.sqlJSON(`select period_start from agni_allowance_periods where subject_id = '${subject}'`))[0];
  if (start) {
    const r = (await h.rpc('agni_cost_cap_restore', { p_subject: subject, p_period_start: start.period_start,
                                                       p_grant_usd: 1, p_max_grant_usd: 6.5 }))[0];
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no_early_stop');
  }
});

test('anon and authenticated cannot call the restore or list functions or read the stops', { skip }, async () => {
  const exposed = await h.sql(`select coalesce(string_agg(p.proname || ':' || r, ','), '') from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace, unnest(array['anon', 'authenticated']) r
    where n.nspname = 'public' and p.proname in ('agni_cost_cap_restore', 'agni_cost_cap_stops_list')
      and has_function_privilege(r, p.oid, 'execute')`);
  assert.equal(exposed, '');
  assert.equal(await h.sql(`select has_table_privilege('anon', 'agni_cost_cap_stops', 'select')`), 'f');
});

test('deleting a subscription\'s history deletes its stop records', { skip }, async () => {
  const { subject } = await stoppedSubscriber();
  assert.equal(Number(await h.sql(`select count(*) from agni_cost_cap_stops where subject_id = '${subject}'`)), 1);
  const dev = (await h.sqlJSON(`select device_subject from agni_key_links where subscription_subject = '${subject}' limit 1`))[0].device_subject;
  const rows = await h.rpc('agni_delete_subscription_history', { p_subscription_subject: subject, p_device_subject: dev,
                                                                  p_contributors: [] });
  assert.ok(Array.isArray(rows));
  assert.equal(Number(await h.sql(`select count(*) from agni_cost_cap_stops where subject_id = '${subject}'`)), 0);
});

// MARK: - The web bound

const reserveArgs = (subject, n, extra = {}) => ({
  p_subject: subject, p_subject_kind: 'subscription', p_request_id: 'r' + n, p_action_id: 'a' + n,
  p_feature: 'ingredient', p_bucket: 'web', p_counts: true, p_tier: 'pro', p_auth_path: 'attest',
  p_model: 'claude-haiku-4-5', p_period_start: '2026-11-01T00:00:00Z', p_period_end: '2026-12-01T00:00:00Z',
  p_limit: 5, p_cost_cap: 1.0, p_day_cost_cap: null, p_burst: null, p_uncredited_day_cap: 60,
  p_reserve_usd: 0.17, p_max_calls_per_action: 8, p_stale_seconds: 120, p_budget_tier: 'pro', p_max_open: 6, ...extra });

test('only one web call is in flight per subject; other buckets are unaffected', { skip }, async () => {
  const subject = 'sub:web-' + Date.now();
  assert.equal((await h.rpc('agni_reserve', reserveArgs(subject, 1)))[0].allowed, true);
  const second = (await h.rpc('agni_reserve', reserveArgs(subject, 2)))[0];
  assert.equal(second.allowed, false);
  assert.equal(second.reason, 'busy');
  const search = (await h.rpc('agni_reserve', reserveArgs(subject, 3, { p_bucket: 'search', p_feature: 'variant_search' })))[0];
  assert.equal(search.allowed, true, 'a search may run beside the web call');
  await h.rpc('agni_settle', { p_subject: subject, p_request_id: 'r1', p_actual_usd: 0.03, p_success: true, p_outcome: 'ok' });
  assert.equal((await h.rpc('agni_reserve', reserveArgs(subject, 4)))[0].allowed, true, 'the next web call may start');
});

test('a web call at its hard ceiling carries a period past its cap by at most one call\'s excess', { skip }, async () => {
  const subject = 'sub:webcap-' + Date.now();
  const HARD = 2.16;
  let n = 0;
  // Spend up to just under the $1.00 cap with ordinary calls, then the web
  // call that the cap still admits settles at the hard ceiling.
  await h.sql(`select 1`);
  assert.equal((await h.rpc('agni_reserve', reserveArgs(subject, (n += 1), { p_bucket: 'search', p_reserve_usd: 0.8 })))[0].allowed, true);
  await h.rpc('agni_settle', { p_subject: subject, p_request_id: 'r' + n, p_actual_usd: 0.8, p_success: true, p_outcome: 'ok' });
  assert.equal((await h.rpc('agni_reserve', reserveArgs(subject, (n += 1))))[0].allowed, true);
  // While it is open, no second web call can join it.
  assert.equal((await h.rpc('agni_reserve', reserveArgs(subject, 99)))[0].reason, 'busy');
  await h.rpc('agni_settle', { p_subject: subject, p_request_id: 'r' + n, p_actual_usd: HARD, p_success: true, p_outcome: 'ok' });
  for (let i = 0; i < 5; i += 1) {
    const r = (await h.rpc('agni_reserve', reserveArgs(subject, (n += 1), i % 2 ? {} : { p_bucket: 'photo', p_reserve_usd: 0.12 })))[0];
    assert.equal(r.allowed, false, 'everything after is refused');
  }
  const cost = Number(await h.sql(`select cost_usd from agni_allowance_periods where subject_id = '${subject}'`));
  assert.ok(cost <= 1.0 + (HARD - 0.17) + 1e-9, `period cost ${cost} stays within cap + one web excess`);
});

// MARK: - One search, one credit, across typing pauses (app: SearchSession)

test('three refinements of one search under one action cost one AI-search credit; a fourth is a new one', { skip }, async () => {
  const researchHandler = (await import('../api/research.js')).default;
  const dev = await h.device();
  const searchReq = () => h.modelRequest({ model: 'claude-haiku-4-5-20251001', text: 'a dish' });
  const answer = '{"identity":{"kind":"dish","canonical_name":"Lentil stew"},"recipe":{"serving_grams":300,"ingredients":[{"name":"lentils, cooked","grams":200}]},"certainty":"low"}';
  const session = id('session');
  for (const q of ["grandma's", "grandma's lentil", "grandma's lentil thing"]) {
    h.anthropic.next(h.okText(answer, { input_tokens: 900, output_tokens: 250 }));
    const r = await h.attestedPost(researchHandler, dev, '/api/research',
      { query: q + ' ' + Date.now(), installId: dev.installId, actionId: session, requestId: id('r') });
    assert.equal(r.statusCode, 200, r.body);
    const v = await h.estimate(estimateHandler, dev, { feature: 'variant_search', actionId: session, requestId: id('r'), request: searchReq() });
    assert.equal(v.statusCode, 200, v.body);
  }
  const used = Number(await h.sql(`select search_used from agni_allowance_periods where subject_id = 'dev:${dev.installId}'`));
  assert.equal(used, 1, 'six calls, three refinements, one credit');
  const calls = Number(await h.sql(`select calls from agni_actions where subject_id = 'dev:${dev.installId}' and action_id = '${session}'`));
  assert.ok(calls <= 8 - 2, `the session stays clear of the per-action limit (${calls} calls)`);
  // The app starts a new session for the fourth: a new credit, as the offer defines.
  h.anthropic.next(h.okText(answer, { input_tokens: 900, output_tokens: 250 }));
  await h.attestedPost(researchHandler, dev, '/api/research',
    { query: 'masala dosa ' + Date.now(), installId: dev.installId, actionId: id('session'), requestId: id('r') });
  assert.equal(Number(await h.sql(`select search_used from agni_allowance_periods where subject_id = 'dev:${dev.installId}'`)), 2);
});

test('a describe is one credit; a correction of it is a new one', { skip }, async () => {
  const dev = await h.device();
  const req = () => h.modelRequest({ model: 'claude-haiku-4-5-20251001', text: 'rice dumplings with coconut' });
  const r1 = await h.estimate(estimateHandler, dev, { feature: 'describe', actionId: id('d'), requestId: id('r'), request: req() });
  assert.equal(r1.statusCode, 200, r1.body);
  const used1 = Number(await h.sql(`select search_used from agni_allowance_periods where subject_id = 'dev:${dev.installId}'`));
  assert.equal(used1, 1);
  const r2 = await h.estimate(estimateHandler, dev, { feature: 'refine', actionId: id('d'), requestId: id('r'), request: req() });
  assert.ok([200, 402].includes(r2.statusCode), r2.body);
  if (r2.statusCode === 200) {
    assert.equal(Number(await h.sql(`select search_used from agni_allowance_periods where subject_id = 'dev:${dev.installId}'`)), 2);
  }
});
