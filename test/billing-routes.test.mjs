// End to end: the real handlers, the real SQL, a scripted provider.
//
//   AGNI_TEST_PG=postgresql://postgres@127.0.0.1:55432/postgres node --test test/billing-routes.test.mjs
//
// Skipped without AGNI_TEST_PG, so `npm test` still runs anywhere.

import './helpers/no-network.mjs';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as h from './helpers/harness.mjs';

const skip = !h.enabled && 'AGNI_TEST_PG not set';
let estimateHandler, researchHandler, ingredientHandler, quotaHandler;

before(async () => {
  if (skip) return;
  h.setTestEnv();
  h.freshDatabase('routes');
  h.installFetch();
  estimateHandler = (await import('../api/estimate.js')).default;
  researchHandler = (await import('../api/research.js')).default;
  ingredientHandler = (await import('../api/ingredient.js')).default;
  quotaHandler = (await import('../api/quota.js')).default;
});

after(() => {
  if (skip) return;
  h.restoreFetch();
  h.dropDatabase();
});

beforeEach(() => {
  if (skip) return;
  h.anthropic.reset();
  h.setTestEnv();
});

const photo = () => h.modelRequest({ image: h.PHOTO_B64 });
const drinkCheck = () => h.modelRequest({ model: 'claude-haiku-4-5-20251001', image: h.SMALL_B64 });
const search = (text = 'chicken biryani') => h.modelRequest({ model: 'claude-haiku-4-5-20251001', text });
let seq = 0;
const id = prefix => `${prefix}-${Date.now()}-${(seq += 1)}`;

async function events(subject) {
  return h.sqlJSON(`select feature, bucket, status, credited, outcome, reserved_usd::float, actual_usd::float
                      from agni_usage_events where subject_id = '${subject}' order by created_at`);
}
async function period(subject) {
  const rows = await h.sqlJSON(`select photo_used, search_used, web_used, cost_usd::float, open_reservations
                                  from agni_allowance_periods where subject_id = '${subject}'
                                 order by period_start desc limit 1`);
  return rows[0];
}

// MARK: - Free

test('Free: three photo analyses, then a clear refusal that is not an outage', { skip }, async () => {
  const dev = await h.device();
  for (let i = 0; i < 3; i += 1) {
    const res = await h.estimate(estimateHandler, dev, { feature: 'photo', actionId: id('a'), requestId: id('r'), request: photo() });
    assert.equal(res.statusCode, 200, res.body);
  }
  const res = await h.estimate(estimateHandler, dev, { feature: 'photo', actionId: id('a'), requestId: id('r'), request: photo() });
  assert.equal(res.statusCode, 402);
  assert.equal(res.json.error.type, 'allowanceExhausted');
  assert.equal(res.json.allowance.bucket, 'photo');
  assert.equal(res.json.allowance.resetsAt, null, 'the Free sample never resets');
  assert.match(res.json.error.message, /Search, barcode and quick add still work/);
  assert.equal(h.anthropic.calls.length, 3, 'the refused call never reached the provider');
  const p = await period('dev:' + dev.installId);
  assert.equal(p.photo_used, 3);
  assert.equal(p.open_reservations, 0);
});

test('Free: reinstall (new key, same Keychain install id) does not reset the sample', { skip }, async () => {
  const installId = 'INSTALL-reinstall-' + Date.now();
  const first = await h.device({ installId });
  for (let i = 0; i < 3; i += 1) {
    await h.estimate(estimateHandler, first, { feature: 'photo', actionId: id('a'), requestId: id('r'), request: photo() });
  }
  const second = await h.device({ installId });
  const res = await h.estimate(estimateHandler, second, { feature: 'photo', actionId: id('a'), requestId: id('r'), request: photo() });
  assert.equal(res.statusCode, 402);
});

test('Free: a key cannot move to a fresh install id to get a fresh sample', { skip }, async () => {
  const dev = await h.device();
  for (let i = 0; i < 3; i += 1) {
    await h.estimate(estimateHandler, dev, { feature: 'photo', actionId: id('a'), requestId: id('r'), request: photo() });
  }
  dev.installId = 'INSTALL-forged-' + Date.now();
  const res = await h.estimate(estimateHandler, dev, { feature: 'photo', actionId: id('a'), requestId: id('r'), request: photo() });
  assert.equal(res.statusCode, 402, 'the key stays bound to the device subject it first used');
});

test('Free: ten AI searches, which do not touch the photo sample', { skip }, async () => {
  const dev = await h.device();
  for (let i = 0; i < 10; i += 1) {
    const res = await h.estimate(estimateHandler, dev, { feature: 'variant_search', actionId: id('a'), requestId: id('r'), request: search() });
    assert.equal(res.statusCode, 200, res.body);
  }
  const refused = await h.estimate(estimateHandler, dev, { feature: 'describe', actionId: id('a'), requestId: id('r'), request: search() });
  assert.equal(refused.statusCode, 402);
  assert.equal(refused.json.allowance.bucket, 'search');
  const stillPhoto = await h.estimate(estimateHandler, dev, { feature: 'photo', actionId: id('a'), requestId: id('r'), request: photo() });
  assert.equal(stillPhoto.statusCode, 200);
});

test('Free: refine, breakdown and web lookups are Pro', { skip }, async () => {
  const dev = await h.device();
  for (const feature of ['refine', 'breakdown']) {
    const res = await h.estimate(estimateHandler, dev, { feature, actionId: id('a'), requestId: id('r'),
      request: h.modelRequest({ model: feature === 'breakdown' ? 'claude-sonnet-5' : 'claude-haiku-4-5-20251001' }) });
    assert.equal(res.statusCode, 402, feature);
    assert.equal(res.json.error.type, 'subscriptionRequired');
  }
  const web = await h.attestedPost(ingredientHandler, dev, '/api/ingredient',
    { query: 'moringa leaves', installId: dev.installId, actionId: id('a'), requestId: id('r') });
  assert.equal(web.statusCode, 402);
  assert.equal(h.anthropic.calls.length, 0);
});

// MARK: - One action, one credit

test('a photo is one credit: drink check plus estimate share the action', { skip }, async () => {
  const dev = await h.device();
  const action = id('photo');
  const check = await h.estimate(estimateHandler, dev, { feature: 'drink_check', actionId: action, requestId: id('r'), request: drinkCheck() });
  assert.equal(check.statusCode, 200, check.body);
  const est = await h.estimate(estimateHandler, dev, { feature: 'photo', actionId: action, requestId: id('r'), request: photo() });
  assert.equal(est.statusCode, 200);
  assert.equal((await period('dev:' + dev.installId)).photo_used, 1);
});

test('an automatic retry of the same action costs no second credit; the call cap bounds it', { skip }, async () => {
  const dev = await h.device();
  const action = id('retry');
  const { MAX_CALLS_PER_ACTION } = await import('../api/_billing.js');
  for (let i = 0; i < MAX_CALLS_PER_ACTION; i += 1) {
    const res = await h.estimate(estimateHandler, dev, { feature: 'photo', actionId: action, requestId: id('r'), request: photo() });
    assert.equal(res.statusCode, 200);
  }
  const over = await h.estimate(estimateHandler, dev, { feature: 'photo', actionId: action, requestId: id('r'), request: photo() });
  assert.equal(over.statusCode, 429, 'MAX_CALLS_PER_ACTION stops an unbounded stream on one credit');
  assert.equal((await period('dev:' + dev.installId)).photo_used, 1);
});

test('a deliberate correction is a new action and a new credit', { skip }, async () => {
  const dev = await h.device();
  await h.estimate(estimateHandler, dev, { feature: 'photo', actionId: id('first'), requestId: id('r'), request: photo() });
  await h.estimate(estimateHandler, dev, { feature: 'photo', actionId: id('correct'), requestId: id('r'), request: photo() });
  assert.equal((await period('dev:' + dev.installId)).photo_used, 2);
});

test('the same request id twice reaches the provider once', { skip }, async () => {
  const dev = await h.device();
  const requestId = id('dup');
  const first = await h.estimate(estimateHandler, dev, { feature: 'photo', actionId: id('a'), requestId, request: photo() });
  const second = await h.estimate(estimateHandler, dev, { feature: 'photo', actionId: id('a'), requestId, request: photo() });
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 409);
  assert.equal(second.json.error.type, 'duplicateRequest');
  assert.equal(h.anthropic.calls.length, 1);
});

// MARK: - Failures

test('a provider error costs no credit and no money', { skip }, async () => {
  const dev = await h.device();
  h.anthropic.next({ status: 529, body: { type: 'error', error: { type: 'overloaded_error' } } });
  const res = await h.estimate(estimateHandler, dev, { feature: 'photo', actionId: id('a'), requestId: id('r'), request: photo() });
  assert.equal(res.statusCode, 529);
  const subject = 'dev:' + dev.installId;
  const p = await period(subject);
  assert.equal(p.photo_used, 0, 'credit given back');
  assert.equal(p.cost_usd, 0, 'an error response is not billed');
  const [event] = await events(subject);
  assert.equal(event.status, 'settled');
  assert.equal(event.outcome, 'provider_529');
});

test('a timeout gives the credit back but keeps the reservation as spend', { skip }, async () => {
  const dev = await h.device();
  h.anthropic.next({ throw: 'TimeoutError' });
  const res = await h.estimate(estimateHandler, dev, { feature: 'photo', actionId: id('a'), requestId: id('r'), request: photo() });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json.error.type, 'serviceUnavailable');
  const subject = 'dev:' + dev.installId;
  const p = await period(subject);
  assert.equal(p.photo_used, 0);
  const [event] = await events(subject);
  assert.equal(event.outcome, 'ambiguous');
  assert.equal(event.actual_usd, event.reserved_usd, 'nobody knows if it was billed, so it counts');
  assert.ok(p.cost_usd > 0);
});

test('a 200 whose usage cannot be read keeps the reservation as its cost', { skip }, async () => {
  const dev = await h.device();
  h.anthropic.next({ status: 200, body: 'not json at all' });
  await h.estimate(estimateHandler, dev, { feature: 'photo', actionId: id('a'), requestId: id('r'), request: photo() });
  const [event] = await events('dev:' + dev.installId);
  assert.equal(event.actual_usd, event.reserved_usd);
});

test('an abandoned reservation expires at its reserved cost and returns the credit', { skip }, async () => {
  const dev = await h.device();
  const subject = 'dev:' + dev.installId;
  await h.estimate(estimateHandler, dev, { feature: 'photo', actionId: id('a'), requestId: id('r'), request: photo() });
  // A function killed mid-call: reserved, never settled.
  await h.rpc('agni_reserve', {
    p_subject: subject, p_subject_kind: 'device', p_request_id: 'killed-1', p_action_id: 'killed-a',
    p_feature: 'photo', p_bucket: 'photo', p_counts: true, p_tier: 'free', p_auth_path: 'attested',
    p_model: 'claude-sonnet-5', p_period_start: new Date(0).toISOString(), p_period_end: 'infinity',
    p_limit: 3, p_cost_cap: 0.5, p_day_cost_cap: null, p_burst: 3, p_uncredited_day_cap: 60,
    p_reserve_usd: 0.07, p_max_calls_per_action: 4, p_stale_seconds: 120
  });
  assert.equal((await period(subject)).photo_used, 2);
  await h.sql(`update agni_usage_events set created_at = now() - interval '10 minutes' where request_id = 'killed-1'`);
  assert.equal(Number(await h.sql('select agni_sweep_reservations(120)')), 1);
  const p = await period(subject);
  assert.equal(p.photo_used, 1, 'credit returned');
  assert.equal(p.open_reservations, 0);
  const killed = await h.sqlJSON(`select status, outcome, actual_usd::float from agni_usage_events where request_id = 'killed-1'`);
  assert.deepEqual(killed[0], { status: 'expired', outcome: 'ambiguous_expired', actual_usd: 0.07 });
});

// MARK: - Cost

test('cost is computed from provider usage, never from the client header', { skip }, async () => {
  const dev = await h.device();
  h.anthropic.next(h.okText('{}', { input_tokens: 4000, output_tokens: 1000, cache_read_input_tokens: 2000 }));
  const raw = h.envelope(dev, { feature: 'photo', actionId: id('a'), requestId: id('r'), request: photo() });
  const headers = await dev.bodyBound(Buffer.from(raw));
  const res = await h.call(estimateHandler, { method: 'POST', body: raw,
    headers: { ...headers, 'x-agni-last-cost': '0.000000' } });
  assert.equal(res.statusCode, 200);
  const [event] = await events('dev:' + dev.installId);
  // 4000 * $2/M + 1000 * $10/M + 2000 * $2/M * 0.1
  assert.equal(Number(event.actual_usd.toFixed(6)), 0.0184);
});

// MARK: - Trial and Pro

test('Trial: 25 photos, 3 uncached web lookups, then refused', { skip }, async () => {
  const dev = await h.device();
  await h.subscribe(dev, { purchase: h.daysFromNow(-2), expires: h.daysFromNow(5), trial: true });
  h.anthropic.fallback = { status: 200, usage: { input_tokens: 500, output_tokens: 100 } };
  try {
    for (let i = 0; i < 25; i += 1) {
      const res = await h.estimate(estimateHandler, dev, { feature: 'photo', actionId: id('a'), requestId: id('r'), request: photo() });
      assert.equal(res.statusCode, 200, `photo ${i + 1}: ${res.body}`);
    }
    const over = await h.estimate(estimateHandler, dev, { feature: 'photo', actionId: id('a'), requestId: id('r'), request: photo() });
    assert.equal(over.statusCode, 402);
    assert.equal(over.json.allowance.tier, 'trial');
    for (let i = 0; i < 3; i += 1) {
      h.anthropic.next(h.okText('{"identity":{},"results":[],"notes":"none"}',
        { input_tokens: 2000, output_tokens: 300, server_tool_use: { web_search_requests: 1 } }));
      const res = await h.attestedPost(ingredientHandler, dev, '/api/ingredient',
        { query: `herb number ${i} ${Date.now()}`, installId: dev.installId, actionId: id('a'), requestId: id('r') });
      assert.equal(res.statusCode, 200, res.body);
    }
    const fourth = await h.attestedPost(ingredientHandler, dev, '/api/ingredient',
      { query: `another herb ${Date.now()}`, installId: dev.installId, actionId: id('a'), requestId: id('r') });
    assert.equal(fourth.statusCode, 402);
    assert.equal(fourth.json.allowance.bucket, 'web');
  } finally {
    h.anthropic.fallback = { status: 200, usage: { input_tokens: 3000, output_tokens: 600 } };
  }
});

test('Trial to paid: the first paid period starts fresh', { skip }, async () => {
  const dev = await h.device();
  const otid = 'OT-convert-' + Date.now();
  await h.subscribe(dev, { otid, purchase: h.daysFromNow(-6), expires: h.daysFromNow(1), trial: true });
  for (let i = 0; i < 3; i += 1) {
    await h.estimate(estimateHandler, dev, { feature: 'photo', actionId: id('a'), requestId: id('r'), request: photo() });
  }
  // Apple charges at trial end: a new transaction, same original id.
  await h.subscribe(dev, { otid, purchase: h.daysFromNow(-0.001), expires: h.daysFromNow(30), trial: false });
  const status = await h.attestedGet(quotaHandler, dev, '/api/quota', { installId: dev.installId });
  assert.equal(status.json.allowance.tier, 'pro');
  assert.equal(status.json.allowance.buckets.photo.used, 0);
  assert.equal(status.json.allowance.buckets.photo.limit, 100);
});

test('Pro: 25 photos a day burst guard, with tomorrow as the reset', { skip }, async () => {
  const dev = await h.device();
  await h.subscribe(dev, { purchase: h.daysFromNow(-3), expires: h.daysFromNow(27) });
  h.anthropic.fallback = { status: 200, usage: { input_tokens: 500, output_tokens: 100 } };
  try {
    for (let i = 0; i < 25; i += 1) {
      await h.estimate(estimateHandler, dev, { feature: 'label', actionId: id('a'), requestId: id('r'), request: photo() });
    }
    const res = await h.estimate(estimateHandler, dev, { feature: 'photo', actionId: id('a'), requestId: id('r'), request: photo() });
    assert.equal(res.statusCode, 429);
    assert.equal(res.json.error.type, 'usageLimitReached');
    assert.ok(new Date(res.json.allowance.resetsAt) > new Date());
  } finally {
    h.anthropic.fallback = { status: 200, usage: { input_tokens: 3000, output_tokens: 600 } };
  }
});

test('Pro: the aggregate cost ceiling stops spend before the counts do, and says so', { skip }, async () => {
  const dev = await h.device();
  const subject = await h.subscribe(dev, { purchase: h.daysFromNow(-3), expires: h.daysFromNow(27) });
  // Most of the period's $3.00 already spent.
  const start = (await h.sqlJSON(`select period_start from agni_allowance_periods where subject_id = '${subject}'`))[0];
  await h.estimate(estimateHandler, dev, { feature: 'variant_search', actionId: id('a'), requestId: id('r'), request: search() });
  const { DEFAULT_ALLOWANCES } = await import('../api/_billing.js');
  await h.sql(`update agni_allowance_periods set cost_usd = ${DEFAULT_ALLOWANCES.pro.costCapUSD - 0.03} where subject_id = '${subject}'`);
  const alert = () => h.sqlJSON(`select detail from agni_alerts where kind = 'cost_cap_before_counts'`);
  void start;
  const res = await h.estimate(estimateHandler, dev, { feature: 'photo', actionId: id('a'), requestId: id('r'), request: photo() });
  assert.equal(res.statusCode, 402);
  assert.equal(res.json.allowance.bucket, 'cost');
  const alerts = await alert();
  assert.equal(alerts.length, 1, 'the operator is told the cap stopped someone with credits left');
  assert.equal(alerts[0].detail.subject_id, undefined, 'no subject in the alert');
});

test('expired, refunded and revoked subscriptions fall back to Free', { skip }, async () => {
  for (const variant of ['expired', 'refunded', 'sandbox-disallowed']) {
    const dev = await h.device();
    if (variant === 'expired') await h.subscribe(dev, { purchase: h.daysFromNow(-40), expires: h.daysFromNow(-10) });
    if (variant === 'refunded') await h.subscribe(dev, { purchase: h.daysFromNow(-3), expires: h.daysFromNow(27), revoked: h.daysFromNow(-1) });
    if (variant === 'sandbox-disallowed') {
      process.env.ALLOW_SANDBOX_TRANSACTIONS = 'false';
      await h.subscribe(dev, { purchase: h.daysFromNow(-3), expires: h.daysFromNow(27), environment: 'Sandbox' });
    }
    const status = await h.attestedGet(quotaHandler, dev, '/api/quota', { installId: dev.installId });
    assert.equal(status.json.allowance.tier, 'free', variant);
    process.env.ALLOW_SANDBOX_TRANSACTIONS = 'true';
  }
});

// MARK: - Every paid route is metered

test('research is metered, shares the search action, and a cache hit is free', { skip }, async () => {
  const dev = await h.device();
  const action = id('search');
  const answer = '{"identity":{"kind":"dish","canonical_name":"Kothu parotta"},"recipe":{"serving_grams":300,"ingredients":[{"name":"wheat flour, white","grams":120}]},"certainty":"high"}';
  h.anthropic.next(h.okText(answer, { input_tokens: 900, output_tokens: 250 }));
  const query = 'kothu parotta ' + Date.now();
  const first = await h.attestedPost(researchHandler, dev, '/api/research',
    { query, installId: dev.installId, actionId: action, requestId: id('r') });
  assert.equal(first.statusCode, 200, first.body);
  assert.ok(first.json.cost_usd > 0);
  // The same keystroke goes on to the variant call: same action, no new credit.
  await h.estimate(estimateHandler, dev, { feature: 'variant_search', actionId: action, requestId: id('r'), request: search() });
  assert.equal((await period('dev:' + dev.installId)).search_used, 1);
  // Somebody else asks the same thing: answered from the shared cache.
  const other = await h.device();
  const cached = await h.attestedPost(researchHandler, other, '/api/research',
    { query, installId: other.installId, actionId: id('a'), requestId: id('r') });
  assert.equal(cached.json.cached, true);
  assert.equal(cached.json.cost_usd, 0);
  assert.equal(await h.sql(`select count(*) from agni_usage_events where subject_id = 'dev:${other.installId}'`), '0');
});

test('ingredient web lookups record the web-search cost; cache hits are free and uncounted', { skip }, async () => {
  const dev = await h.device();
  await h.subscribe(dev, { purchase: h.daysFromNow(-3), expires: h.daysFromNow(27) });
  h.anthropic.next(h.okText('{"identity":{"canonical_name":"moringa"},"results":[],"notes":"none"}',
    { input_tokens: 20000, output_tokens: 800, server_tool_use: { web_search_requests: 3 } }));
  const query = 'moringa ' + Date.now();
  const live = await h.attestedPost(ingredientHandler, dev, '/api/ingredient',
    { query, installId: dev.installId, actionId: id('a'), requestId: id('r') });
  assert.equal(live.statusCode, 200, live.body);
  // 20000 * $1/M + 800 * $5/M + 3 * $0.01
  assert.equal(Number(live.json.cost_usd.toFixed(4)), 0.054);
  const again = await h.attestedPost(ingredientHandler, dev, '/api/ingredient',
    { query, installId: dev.installId, actionId: id('a'), requestId: id('r') });
  assert.equal(again.json.cached, true);
  const subject = (await h.sqlJSON(`select subscription_subject from agni_key_links where key_id = '${dev.keyId.replace(/'/g, "''")}'`))[0].subscription_subject;
  assert.equal((await period(subject)).web_used, 1);
});

// MARK: - The shared token

test('legacy token: metered as legacy with its own daily bound', { skip }, async () => {
  const body = JSON.stringify({ installId: 'LEGACY-INSTALL-1', request: photo() });
  const ok = await h.call(estimateHandler, { method: 'POST', headers: { authorization: 'Bearer legacy-token' }, body });
  assert.equal(ok.statusCode, 200, ok.body);
  const events = await h.sqlJSON(`select tier, auth_path from agni_usage_events where subject_id = 'legacy:LEGACY-INSTALL-1'`);
  assert.deepEqual(events[0], { tier: 'legacy', auth_path: 'legacy' });
  // Bound: $0.50 a day of committed cost (about $0.012 a settled call here).
  let last;
  for (let i = 0; i < 80; i += 1) {
    last = await h.call(estimateHandler, { method: 'POST', headers: { authorization: 'Bearer legacy-token' },
      body: JSON.stringify({ installId: 'LEGACY-INSTALL-1', request: photo() }) });
    if (last.statusCode !== 200) break;
  }
  assert.equal(last.statusCode, 429);
  assert.equal(last.json.error.type, 'usageLimitReached');
  const spent = Number(await h.sql(`select cost_usd from agni_subject_days where subject_id = 'legacy:LEGACY-INSTALL-1'`));
  assert.ok(spent <= 0.50, `never past the bound: ${spent}`);
});

test('legacy token: research and ingredient are metered too (they were not)', { skip }, async () => {
  const research = await h.call(researchHandler, { method: 'POST', headers: { authorization: 'Bearer legacy-token' },
    body: JSON.stringify({ query: 'idli ' + Date.now() }) });
  assert.equal(research.statusCode, 200);
  const ingredient = await h.call(ingredientHandler, { method: 'POST', headers: { authorization: 'Bearer legacy-token' },
    body: JSON.stringify({ query: 'curry leaves ' + Date.now() }) });
  assert.ok([200, 503].includes(ingredient.statusCode));
  const rows = await h.sqlJSON(`select feature, tier from agni_usage_events where tier = 'legacy' and feature in ('research','ingredient') order by feature`);
  assert.deepEqual(rows.map(r => r.feature), ['ingredient', 'research']);
});

test('legacy token cannot sync a subscription', { skip }, async () => {
  const res = await h.call(quotaHandler, { method: 'POST', query: { op: 'sync' },
    headers: { authorization: 'Bearer legacy-token' }, body: JSON.stringify({ transactions: ['a.b.c'] }) });
  assert.equal(res.statusCode, 401);
});

test('LEGACY_TOKEN_ENABLED=false refuses the token everywhere', { skip }, async () => {
  process.env.LEGACY_TOKEN_ENABLED = 'false';
  for (const [handler, body] of [[estimateHandler, { installId: 'X-12345678', request: photo() }],
                                 [researchHandler, { query: 'dosa' }],
                                 [ingredientHandler, { query: 'ghee' }]]) {
    const res = await h.call(handler, { method: 'POST', headers: { authorization: 'Bearer legacy-token' },
                                        body: JSON.stringify(body) });
    assert.equal(res.statusCode, 401);
  }
});

test('a wrong token is refused before anything is spent', { skip }, async () => {
  const res = await h.call(estimateHandler, { method: 'POST', headers: { authorization: 'Bearer guess' },
    body: JSON.stringify({ installId: 'X-12345678', request: photo() }) });
  assert.equal(res.statusCode, 401);
  assert.equal(h.anthropic.calls.length, 0);
});

// MARK: - Attestation

test('a revoked key is refused on the shared auth path (it was not)', { skip }, async () => {
  const dev = await h.device();
  await h.sql(`update agni_attest_keys set revoked = true where key_id = '${dev.keyId.replace(/'/g, "''")}'`);
  const res = await h.attestedPost(researchHandler, dev, '/api/research', { query: 'upma', installId: dev.installId });
  assert.equal(res.statusCode, 401);
});

test('an attested GET and POST verify now that bodies are read raw', { skip }, async () => {
  const dev = await h.device();
  const get = await h.attestedGet(quotaHandler, dev, '/api/quota', { installId: dev.installId });
  assert.equal(get.statusCode, 200, get.body);
  assert.equal(get.json.allowance.tier, 'free');
});

test('build 174/175 binding (body only) still verifies on estimate, and is metered as beta before launch', { skip }, async () => {
  process.env.BILLING_ENFORCED = 'false';
  const dev = await h.device();
  const raw = JSON.stringify({ installId: dev.installId, request: photo() });
  const headers = await dev.bodyBound(Buffer.from(raw));
  const res = await h.call(estimateHandler, { method: 'POST', headers, body: raw });
  assert.equal(res.statusCode, 200, res.body);
  const [event] = await h.sqlJSON(`select tier, feature from agni_usage_events where subject_id = 'dev:${dev.installId}'`);
  assert.deepEqual(event, { tier: 'beta', feature: 'photo' });
});

test('a device in BILLING_ENFORCED_DEVICES sees launch behaviour while the switch is off; others stay beta', { skip }, async () => {
  const before = { on: process.env.BILLING_ENFORCED, list: process.env.BILLING_ENFORCED_DEVICES };
  process.env.BILLING_ENFORCED = 'false';
  try {
    const listed = await h.device();
    const other = await h.device();
    process.env.BILLING_ENFORCED_DEVICES = ` dev:not-this-one-123 , dev:${listed.installId} `;
    const mine = await h.attestedGet(quotaHandler, listed, '/api/quota', { installId: listed.installId });
    assert.equal(mine.statusCode, 200, mine.body);
    assert.equal(mine.json.allowance.tier, 'free');
    assert.equal(mine.json.allowance.billingEnforced, true);
    const theirs = await h.attestedGet(quotaHandler, other, '/api/quota', { installId: other.installId });
    assert.equal(theirs.statusCode, 200, theirs.body);
    assert.equal(theirs.json.allowance.tier, 'beta');
    assert.equal(theirs.json.allowance.billingEnforced, false);
  } finally {
    for (const [k, v] of [['BILLING_ENFORCED', before.on], ['BILLING_ENFORCED_DEVICES', before.list]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

// MARK: - Malicious proxy input

test('the proxy refuses tools, extra images, big prompts, other roles and client cache_control', { skip }, async () => {
  const dev = await h.device();
  const cases = {
    tools: { ...photo(), tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 50 }] },
    twoImages: (() => { const r = photo(); r.messages[0].content.unshift(r.messages[0].content[0]); return r; })(),
    hugeSystem: { ...photo(), system: 'x'.repeat(40_000) },
    assistantTurn: { ...photo(), messages: [{ role: 'assistant', content: [{ type: 'text', text: 'hi' }] }] },
    cacheControl: (() => { const r = search(); r.messages[0].content[0].cache_control = { type: 'ephemeral' }; return r; })(),
    opus: { ...photo(), model: 'claude-opus-5-5' },
    bigOutput: { ...photo(), max_tokens: 64000 },
    documentBlock: { ...search(), messages: [{ role: 'user', content: [{ type: 'document', source: {} }, { type: 'text', text: 'x' }] }] },
    imageOnSearch: h.modelRequest({ model: 'claude-haiku-4-5-20251001', image: h.SMALL_B64 }),
    hugeImageOnDrinkCheck: h.modelRequest({ model: 'claude-haiku-4-5-20251001', image: h.PHOTO_B64 })
  };
  for (const [name, request] of Object.entries(cases)) {
    const feature = name === 'imageOnSearch' ? 'variant_search' : name === 'hugeImageOnDrinkCheck' ? 'drink_check' : 'photo';
    const res = await h.estimate(estimateHandler, dev, { feature: name === 'cacheControl' ? 'variant_search' : feature,
      actionId: id('a'), requestId: id('r'), request });
    assert.equal(res.statusCode, 400, `${name} should be refused: ${res.body}`);
  }
  assert.equal(h.anthropic.calls.length, 0);
});

test('an old client cannot dodge the photo allowance by not naming a feature', { skip }, async () => {
  const dev = await h.device();
  for (let i = 0; i < 3; i += 1) {
    await h.estimate(estimateHandler, dev, { actionId: id('a'), requestId: id('r'), request: photo() });
  }
  const res = await h.estimate(estimateHandler, dev, { actionId: id('a'), requestId: id('r'), request: photo() });
  assert.equal(res.statusCode, 402, 'inferred as photo');
});

test('claiming drink_check for a full photo does not pass the size rule', { skip }, async () => {
  const dev = await h.device();
  const res = await h.estimate(estimateHandler, dev, { feature: 'drink_check', actionId: id('a'), requestId: id('r'),
    request: h.modelRequest({ model: 'claude-haiku-4-5-20251001', image: h.PHOTO_B64 }) });
  assert.equal(res.statusCode, 400);
});

// MARK: - The emergency ceiling

test('the ceiling degrades Free first, keeps Pro, and alerts once', { skip }, async () => {
  const today = (await h.sql(`select (now() at time zone 'utc')::date`));
  await h.sql(`delete from agni_budget_days where day = '${today}'`);
  await h.sql(`insert into agni_budget_days (day, ceiling_usd, paid_usd) values ('${today}', 10, 5.2)`);
  const free = await h.device();
  const res = await h.estimate(estimateHandler, free, { feature: 'photo', actionId: id('a'), requestId: id('r'), request: photo() });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json.error.type, 'aiPaused', 'an outage answer, not an exhausted allowance');
  const pro = await h.device();
  await h.subscribe(pro, { purchase: h.daysFromNow(-3), expires: h.daysFromNow(27) });
  const paid = await h.estimate(estimateHandler, pro, { feature: 'photo', actionId: id('a'), requestId: id('r'), request: photo() });
  assert.equal(paid.statusCode, 200);
  const alerts = await h.sqlJSON(`select kind, detail->>'tier' as tier from agni_alerts where kind = 'degraded'`);
  assert.deepEqual(alerts.map(a => a.tier), ['free']);
  await h.estimate(estimateHandler, await h.device(), { feature: 'photo', actionId: id('a'), requestId: id('r'), request: photo() });
  assert.equal((await h.sqlJSON(`select 1 from agni_alerts where kind = 'degraded'`)).length, 1, 'alerted once a day, not per refusal');
  await h.sql(`delete from agni_budget_days where day = '${today}'`);
});

test('a full day ceiling pauses trials but not subscribers; subscribers stop only at the hard maximum', { skip }, async () => {
  const today = (await h.sql(`select (now() at time zone 'utc')::date`));
  await h.sql(`delete from agni_budget_days where day = '${today}'`);
  // The day's total is already past the whole ceiling.
  await h.sql(`insert into agni_budget_days (day, ceiling_usd, trial_usd, paid_usd) values ('${today}', 10, 6, 6)`);
  const trial = await h.device();
  await h.subscribe(trial, { purchase: h.daysFromNow(-1), expires: h.daysFromNow(6), trial: true });
  const t = await h.estimate(estimateHandler, trial, { feature: 'photo', actionId: id('a'), requestId: id('r'), request: photo() });
  assert.equal(t.statusCode, 503, 'trial pauses at its share');
  const pro = await h.device();
  await h.subscribe(pro, { purchase: h.daysFromNow(-3), expires: h.daysFromNow(27) });
  const p = await h.estimate(estimateHandler, pro, { feature: 'photo', actionId: id('a'), requestId: id('r'), request: photo() });
  assert.equal(p.statusCode, 200, 'a subscriber is not stopped by the dynamic ceiling');
  // At the hard maximum everyone stops, subscribers included.
  const max = Number((await h.sqlJSON(`select hard_max_ceiling_usd from agni_budget_config where id = 1`))[0].hard_max_ceiling_usd);
  await h.sql(`update agni_budget_days set paid_usd = ${max} where day = '${today}'`);
  const stopped = await h.estimate(estimateHandler, pro, { feature: 'photo', actionId: id('a'), requestId: id('r'), request: photo() });
  assert.equal(stopped.statusCode, 503, 'the hard maximum still stops a subscriber');
  await h.sql(`delete from agni_budget_days where day = '${today}'`);
});

test('the ceiling is bounded: free installs never raise it, paid subscribers raise it within the growth bound', { skip }, async () => {
  const tomorrow = await h.sql(`select ((now() at time zone 'utc')::date + 30)`);
  // Yesterday's ceiling 25; 10,000 verified paid subscribers would ask for $1,025.
  await h.sql(`insert into agni_budget_days (day, ceiling_usd) values ('${tomorrow}'::date - 1, 25)`);
  await h.sql(`insert into agni_subjects (subject_id, kind, environment, product_id, expires_date, is_trial)
               select 'sub:bulk' || g, 'subscription', 'Production', 'com.shinethankappan.agni.pro.monthly',
                      now() + interval '20 days', false from generate_series(1, 10000) g`);
  const row = await h.rpc('agni__budget_day', { p_day: tomorrow });
  assert.equal(Number(row.ceiling_usd), 37.5, '25 * 1.5 growth bound, not 1,025');
  await h.sql(`delete from agni_subjects where subject_id like 'sub:bulk%'`);
});

// MARK: - Subscription sync, end to end

import { readFileSync } from 'node:fs';
import { sign as signWith, X509Certificate } from 'node:crypto';
import pathModule from 'node:path';

const fixtures = pathModule.join(import.meta.dirname, 'fixtures/storekit');
const fixture = name => readFileSync(pathModule.join(fixtures, name), 'utf8');
const chainDER = ['leaf.pem', 'intermediate.pem', 'root.pem'].map(f => new X509Certificate(fixture(f)).raw.toString('base64'));
const b64u = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function signedTransaction(over) {
  const header = b64u(JSON.stringify({ alg: 'ES256', x5c: chainDER }));
  const body = b64u(JSON.stringify({
    bundleId: 'com.shinethankappan.agni', type: 'Auto-Renewable Subscription', environment: 'Sandbox',
    productId: 'com.shinethankappan.agni.pro.monthly', signedDate: Date.now(), ...over }));
  const sig = signWith('sha256', Buffer.from(`${header}.${body}`), { key: fixture('leaf.key'), dsaEncoding: 'ieee-p1363' });
  return `${header}.${body}.${b64u(sig)}`;
}

test('sync: a verified purchase makes the install Pro; an older transaction re-sent cannot roll it back', { skip }, async () => {
  const dev = await h.device();
  const otid = 'OT-sync-' + Date.now();
  const current = signedTransaction({ originalTransactionId: otid, transactionId: otid + '-2',
    purchaseDate: Date.now() - 86400_000, expiresDate: Date.now() + 29 * 86400_000 });
  const res = await h.attestedPost(quotaHandler, dev, '/api/quota', { installId: dev.installId, transactions: [current] }, { op: 'sync' });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json.allowance.tier, 'pro');
  assert.equal(res.json.allowance.buckets.photo.limit, 100);
  assert.ok(res.json.allowance.resetsAt);
  const old = signedTransaction({ originalTransactionId: otid, transactionId: otid + '-1',
    purchaseDate: Date.now() - 40 * 86400_000, expiresDate: Date.now() - 10 * 86400_000 });
  const replay = await h.attestedPost(quotaHandler, dev, '/api/quota', { installId: dev.installId, transactions: [old] }, { op: 'sync' });
  assert.equal(replay.json.allowance.tier, 'pro', 'never goes backwards');
  // A Sandbox purchase (this one) lives on its own subject, never on sub:.
  assert.equal(res.json.allowance.environment, 'Sandbox');
  assert.equal(await h.sql(`select count(*) from agni_subjects where subject_id = 'sub:${otid}'`), '0');
  assert.equal(await h.sql(`select environment from agni_subjects where subject_id = 'sbx:${otid}'`), 'Sandbox');
});

test('sync: a forged transaction is refused and changes nothing', { skip }, async () => {
  const dev = await h.device();
  const forged = signedTransaction({ originalTransactionId: 'OT-forged', purchaseDate: Date.now(), expiresDate: Date.now() + 1e9 })
    .replace(/\.[^.]+\.([^.]+)$/, (m, sig) => '.' + b64u(JSON.stringify({ bundleId: 'com.shinethankappan.agni',
      productId: 'com.shinethankappan.agni.pro.annual', originalTransactionId: 'OT-forged',
      purchaseDate: Date.now(), expiresDate: Date.now() + 1e10, environment: 'Production' })) + '.' + sig);
  const res = await h.attestedPost(quotaHandler, dev, '/api/quota', { installId: dev.installId, transactions: [forged] }, { op: 'sync' });
  assert.equal(res.statusCode, 422);
  assert.equal(await h.sql(`select count(*) from agni_subjects where subject_id = 'sub:OT-forged'`), '0');
});

test('sync: one subscription on too many installs is refused and flagged', { skip }, async () => {
  const otid = 'OT-shared-' + Date.now();
  const jwsShared = signedTransaction({ originalTransactionId: otid, transactionId: otid,
    purchaseDate: Date.now() - 3600_000, expiresDate: Date.now() + 29 * 86400_000 });
  let last;
  for (let i = 0; i < 11; i += 1) {
    const dev = await h.device();
    last = await h.attestedPost(quotaHandler, dev, '/api/quota', { installId: dev.installId, transactions: [jwsShared] }, { op: 'sync' });
  }
  assert.equal(last.statusCode, 409);
  assert.equal(await h.sql(`select flagged from agni_subjects where subject_id = 'sbx:${otid}'`), 'too_many_installs');
});

test('a subscription shared across installs shares ONE allowance', { skip }, async () => {
  const otid = 'OT-family-' + Date.now();
  const a = await h.device();
  const b = await h.device();
  await h.subscribe(a, { otid, purchase: h.daysFromNow(-1), expires: h.daysFromNow(29) });
  await h.subscribe(b, { otid, purchase: h.daysFromNow(-1), expires: h.daysFromNow(29) });
  await h.estimate(estimateHandler, a, { feature: 'photo', actionId: id('a'), requestId: id('r'), request: photo() });
  await h.estimate(estimateHandler, b, { feature: 'photo', actionId: id('a'), requestId: id('r'), request: photo() });
  assert.equal((await period('sub:' + otid)).photo_used, 2);
});

test('App Store notification: a refund makes the install Free', { skip }, async () => {
  const dev = await h.device();
  const otid = 'OT-refund-' + Date.now();
  await h.subscribe(dev, { otid, purchase: h.daysFromNow(-2), expires: h.daysFromNow(28) });
  const purchase = Number(new Date(await h.sql(`select purchase_date from agni_subjects where subject_id = 'sub:${otid}'`)));
  const refunded = signedTransaction({ originalTransactionId: otid, transactionId: otid, environment: 'Production',
    purchaseDate: purchase, expiresDate: Date.now() + 28 * 86400_000, revocationDate: Date.now(), revocationReason: 0 });
  const header = b64u(JSON.stringify({ alg: 'ES256', x5c: chainDER }));
  const body = b64u(JSON.stringify({ notificationType: 'REFUND', notificationUUID: 'uuid-' + otid, signedDate: Date.now(),
    data: { bundleId: 'com.shinethankappan.agni', appAppleId: 6700000000, environment: 'Production',
            signedTransactionInfo: refunded } }));
  const sig = signWith('sha256', Buffer.from(`${header}.${body}`), { key: fixture('leaf.key'), dsaEncoding: 'ieee-p1363' });
  const res = await h.call(quotaHandler, { method: 'POST', query: { op: 'notify' },
    body: JSON.stringify({ signedPayload: `${header}.${body}.${b64u(sig)}` }) });
  assert.equal(res.statusCode, 200, res.body);
  const status = await h.attestedGet(quotaHandler, dev, '/api/quota', { installId: dev.installId });
  assert.equal(status.json.allowance.tier, 'free');
});

test('App Store notification with no valid signature is refused', { skip }, async () => {
  const res = await h.call(quotaHandler, { method: 'POST', query: { op: 'notify' },
    body: JSON.stringify({ signedPayload: 'eyJhbGciOiJub25lIn0.e30.' }) });
  assert.equal(res.statusCode, 400);
});

// MARK: - Replay protection with out-of-order arrival

test('an assertion signed earlier but arriving later is accepted; the same counter twice is not', { skip }, async () => {
  const { authenticate, MeterClass } = await import('../api/_auth.js');
  const dev = await h.device();
  const q = { installId: dev.installId };
  const first = await dev.canonical('GET', '/api/quota', q, '');
  const second = await dev.canonical('GET', '/api/quota', q, '');
  const asReq = headers => h.request({ method: 'GET', query: q, headers });
  const late = await authenticate(asReq(second), { meterClass: MeterClass.read, path: '/api/quota', query: q, rawBody: '' });
  assert.equal(late.ok, true);
  const early = await authenticate(asReq(first), { meterClass: MeterClass.read, path: '/api/quota', query: q, rawBody: '' });
  assert.equal(early.ok, true, 'out of order, not a replay');
  // A fresh challenge but the same counter as `second`: the stored set refuses it.
  await h.sql(`update agni_attest_keys set recent_counters = recent_counters where true`);
  const { rows } = { rows: await h.rpc('agni_attest_gate_class', { p_key_id: dev.keyId, p_counter: 2, p_class: 'read',
    p_per_minute: 1000, p_per_day: 1000 }) };
  assert.equal(rows[0].reason, 'replay');
});

test('a challenge already used cannot be used again, even with a fresh signature', { skip }, async () => {
  const dev = await h.device();
  const q = { installId: dev.installId };
  const first = await dev.canonical('GET', '/api/quota', q, '');
  assert.equal((await h.call(quotaHandler, { method: 'GET', query: q, headers: first })).statusCode, 200);
  const again = await dev.canonical('GET', '/api/quota', q, '', { reuseChallenge: first['x-agni-challenge'] });
  assert.equal((await h.call(quotaHandler, { method: 'GET', query: q, headers: again })).statusCode, 401);
});

// MARK: - Plan switches never buy a fresh allowance

async function photos(dev, n) {
  for (let i = 0; i < n; i += 1) {
    const res = await h.estimate(estimateHandler, dev, { feature: 'photo', actionId: id('a'), requestId: id('r'), request: photo() });
    assert.equal(res.statusCode, 200, res.body);
  }
}

test('refund and repurchase mid-month CARRIES the month\'s usage; the status shows it before the first call', { skip }, async () => {
  const dev = await h.device();
  const otid = 'OT-cycle-' + Date.now();
  const subject = await h.subscribe(dev, { otid, purchase: h.daysFromNow(-10), expires: h.daysFromNow(20) });
  await photos(dev, 5);
  // A newer purchase on the same subscription, starting now.
  await h.subscribe(dev, { otid, purchase: h.daysFromNow(0), expires: h.daysFromNow(30) });
  const status = await h.attestedGet(quotaHandler, dev, '/api/quota', { installId: dev.installId });
  assert.equal(status.json.allowance.buckets.photo.used, 5, 'shown carried before any call');
  await photos(dev, 1);
  const rows = await h.sqlJSON(`select photo_used, carried_from is not null as carried from agni_allowance_periods
                                  where subject_id = '${subject}' order by period_start`);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1], { photo_used: 6, carried: true });
});

test('a renewal a month on (or a crossgrade at renewal) starts FRESH', { skip }, async () => {
  const dev = await h.device();
  const otid = 'OT-renew-' + Date.now();
  const subject = await h.subscribe(dev, { otid, purchase: h.daysFromNow(-1), expires: h.daysFromNow(29) });
  // Last month's period, already used up.
  await h.sql(`insert into agni_allowance_periods (subject_id, period_start, period_end, tier, photo_used, cost_usd)
               values ('${subject}', now() - interval '35 days', now() - interval '1 day', 'pro', 100, 2.4)`);
  await photos(dev, 1);
  assert.deepEqual(await period(subject).then(p => ({ photo_used: p.photo_used })), { photo_used: 1 });
  // And the annual plan, crossgraded to at that renewal, also starts fresh.
  const dev2 = await h.device();
  const otid2 = 'OT-cross-' + Date.now();
  const subject2 = await h.subscribe(dev2, { otid: otid2, product: 'com.shinethankappan.agni.pro.annual',
    purchase: h.daysFromNow(-1), expires: new Date(Date.now() + (365 - 1) * 86400_000).toISOString() });
  await h.sql(`insert into agni_allowance_periods (subject_id, period_start, period_end, tier, photo_used)
               values ('${subject2}', now() - interval '35 days', now() - interval '1 day', 'pro', 100)`);
  const res = await h.estimate(estimateHandler, dev2, { feature: 'photo', actionId: id('a'), requestId: id('r'), request: photo() });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal((await period(subject2)).photo_used, 1);
});

// MARK: - Sandbox is isolated

test('Sandbox Pro unlocks Pro but is metered as sandbox, never as paid', { skip }, async () => {
  const dev = await h.device();
  const subject = await h.subscribe(dev, { environment: 'Sandbox', purchase: h.daysFromNow(-1), expires: h.daysFromNow(29) });
  assert.match(subject, /^sbx:/);
  const status = await h.attestedGet(quotaHandler, dev, '/api/quota', { installId: dev.installId });
  assert.equal(status.json.allowance.tier, 'pro');
  assert.equal(status.json.allowance.environment, 'Sandbox');
  const before = await h.sqlJSON(`select paid_usd::float, sandbox_usd::float from agni_budget_days where day = (now() at time zone 'utc')::date`);
  await photos(dev, 1);
  const tiers = await h.sqlJSON(`select distinct tier from agni_usage_events where subject_id = '${subject}'`);
  assert.deepEqual(tiers, [{ tier: 'sandbox' }]);
  const after = await h.sqlJSON(`select paid_usd::float, sandbox_usd::float from agni_budget_days where day = (now() at time zone 'utc')::date`);
  assert.equal(after[0].paid_usd, before[0]?.paid_usd ?? 0, 'paid spend untouched');
  assert.ok(after[0].sandbox_usd > (before[0]?.sandbox_usd ?? 0));
});

test('Sandbox has its own daily cap: it degrades Sandbox and leaves Production Pro alone', { skip }, async () => {
  const sbx = await h.device();
  await h.subscribe(sbx, { environment: 'Sandbox', purchase: h.daysFromNow(-1), expires: h.daysFromNow(29) });
  const prod = await h.device();
  await h.subscribe(prod, { purchase: h.daysFromNow(-1), expires: h.daysFromNow(29) });
  await h.sql(`update agni_budget_config set sandbox_day_cap_usd = 0`);
  try {
    const refused = await h.estimate(estimateHandler, sbx, { feature: 'photo', actionId: id('a'), requestId: id('r'), request: photo() });
    assert.equal(refused.statusCode, 503);
    assert.equal(refused.json.error.type, 'aiPaused');
    await photos(prod, 1);
  } finally {
    await h.sql(`update agni_budget_config set sandbox_day_cap_usd = 5`);
  }
});

test('Sandbox subscribers never raise the emergency ceiling', { skip }, async () => {
  await h.sql(`insert into agni_subjects (subject_id, kind, environment, product_id, purchase_date, expires_date, is_trial)
               select 'sbx:bulk' || g, 'subscription', 'Sandbox', 'com.shinethankappan.agni.pro.monthly', now(), now() + interval '20 days', false
                 from generate_series(1, 500) g`);
  await h.sql(`delete from agni_budget_days where day = '2031-01-01'`);
  const row = await h.rpc('agni__budget_day', { p_day: '2031-01-01' });
  assert.equal(Number(row.paid_subscribers), Number(await h.sql(`select count(*) from agni_subjects
    where kind = 'subscription' and environment = 'Production' and not is_trial and revocation_date is null
      and expires_date > now()`)), 'only Production paid subscriptions are counted');
  await h.sql(`delete from agni_subjects where subject_id like 'sbx:bulk%'`);
});

// MARK: - Under-reservation cannot carry spend past a ceiling

test('a provider billing the worst case for every call never carries a period past its cost cap', { skip }, async () => {
  process.env.ALLOWANCES_JSON = JSON.stringify({ pro: { costCapUSD: 0.6, photo: 1000, burst: 1000 } });
  const dev = await h.device();
  const subject = await h.subscribe(dev, { purchase: h.daysFromNow(-1), expires: h.daysFromNow(29) });
  const request = photo();
  const bytes = t => Buffer.byteLength(String(t), 'utf8');
  // Every byte a token, the image at the Sonnet ceiling, every output token.
  const worst = { input_tokens: bytes(request.system) + bytes(request.messages[0].content[1].text)
    + bytes(JSON.stringify(request.output_config)) + 4_784 + 400, output_tokens: 4096 };
  h.anthropic.fallback = { status: 200, usage: worst };
  try {
    let refused = null;
    for (let i = 0; i < 20 && !refused; i += 1) {
      const res = await h.estimate(estimateHandler, dev, { feature: 'photo', actionId: id('a'), requestId: id('r'), request: photo() });
      if (res.statusCode !== 200) refused = res;
    }
    assert.equal(refused?.json?.allowance?.bucket, 'cost');
    assert.ok((await period(subject)).cost_usd <= 0.6, 'committed cost never passed the cap');
    // And in parallel, against a fresh period.
    const dev2 = await h.device();
    const subject2 = await h.subscribe(dev2, { purchase: h.daysFromNow(-1), expires: h.daysFromNow(29) });
    await Promise.all(Array.from({ length: 16 }, () =>
      h.estimate(estimateHandler, dev2, { feature: 'photo', actionId: id('a'), requestId: id('r'), request: photo() })));
    assert.ok((await period(subject2)).cost_usd <= 0.6, 'still under the cap under a burst');
  } finally {
    delete process.env.ALLOWANCES_JSON;
    h.anthropic.fallback = { status: 200, usage: { input_tokens: 3000, output_tokens: 600 } };
  }
});

test('no more than four calls per subject are in flight at once', { skip }, async () => {
  const subject = 'dev:busy-' + Date.now();
  const args = n => ({ p_subject: subject, p_subject_kind: 'device', p_request_id: 'r' + n, p_action_id: 'a' + n,
    p_feature: 'variant_search', p_bucket: 'search', p_counts: true, p_tier: 'pro', p_auth_path: 'attest',
    p_model: 'claude-haiku-4-5', p_period_start: '2026-10-01T00:00:00Z', p_period_end: '2026-11-01T00:00:00Z',
    p_limit: 100, p_cost_cap: 2.5, p_day_cost_cap: null, p_burst: null, p_uncredited_day_cap: 60,
    p_reserve_usd: 0.01, p_max_calls_per_action: 4, p_stale_seconds: 120, p_budget_tier: 'pro', p_max_open: 4 });
  for (let n = 0; n < 4; n += 1) assert.equal((await h.rpc('agni_reserve', args(n)))[0].allowed, true);
  const fifth = (await h.rpc('agni_reserve', args(4)))[0];
  assert.equal(fifth.allowed, false);
  assert.equal(fifth.reason, 'busy');
  await h.rpc('agni_settle', { p_subject: subject, p_request_id: 'r0', p_actual_usd: 0.002, p_success: true, p_outcome: 'ok' });
  assert.equal((await h.rpc('agni_reserve', args(5)))[0].allowed, true, 'one closes, one more may open');
});

// MARK: - Only the server may call the ledger

test('anon and authenticated cannot execute any billing function or read the usage view', { skip }, async () => {
  const exposed = await h.sql(`select coalesce(string_agg(p.proname || ':' || r, ','), '') from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace, unnest(array['anon', 'authenticated']) r
    where n.nspname = 'public' and p.proname in ('agni_reserve', 'agni_settle', 'agni_subscription_upsert',
      'agni_link_key', 'agni_caller', 'agni_allowance_status', 'agni_mark_device', 'agni__finish', 'agni__budget_day')
      and has_function_privilege(r, p.oid, 'execute')`);
  assert.equal(exposed, '');
  assert.equal(await h.sql(`select has_table_privilege('anon', 'agni_usage_daily', 'select')`), 'f');
  assert.equal(await h.sql(`select has_function_privilege('service_role', 'agni_reserve'::regproc, 'execute')`), 't');
});

test('research with retrieve:true draws on the WEB bucket and is Pro, not an ordinary search', { skip }, async () => {
  const free = await h.device();
  const refused = await h.attestedPost(researchHandler, free, '/api/research',
    { query: 'idli batter ' + Date.now(), retrieve: true, installId: free.installId, actionId: id('a'), requestId: id('r') });
  assert.equal(refused.statusCode, 402, 'Free has no web lookups');
  const dev = await h.device();
  const subject = await h.subscribe(dev, { purchase: h.daysFromNow(-1), expires: h.daysFromNow(29) });
  h.anthropic.next(h.okText('{"identity":{"kind":"dish","canonical_name":"Idli"},"recipe":{"serving_grams":100,"ingredients":[{"name":"rice","grams":60}]},"certainty":"high"}',
    { input_tokens: 9000, output_tokens: 400, server_tool_use: { web_search_requests: 2 } }));
  const res = await h.attestedPost(researchHandler, dev, '/api/research',
    { query: 'idli batter ' + Date.now(), retrieve: true, installId: dev.installId, actionId: id('a'), requestId: id('r') });
  assert.equal(res.statusCode, 200, res.body);
  const p = await period(subject);
  assert.equal(p.web_used, 1);
  assert.equal(p.search_used, 0);
});
