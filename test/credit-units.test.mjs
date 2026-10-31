// How many allowance units one thing a person does actually consumes.
// The real handlers and SQL, a scripted provider, no network.
//
//   AGNI_TEST_PG=postgresql://postgres@127.0.0.1:55432/postgres node --test test/credit-units.test.mjs
//
// Written for the drink-photo double credit (2026-10-31): the app identified a
// drink after a meal photo under a FRESH action id, so one photo cost two
// photo credits. The server already credits once per action; these tests pin
// what each user action costs so the app fix (same action id) can be judged
// against it.

import './helpers/no-network.mjs';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as h from './helpers/harness.mjs';

const skip = !h.enabled && 'AGNI_TEST_PG not set';
let estimateHandler, ingredientHandler;

before(async () => {
  if (skip) return;
  h.setTestEnv();
  h.freshDatabase('credits');
  h.installFetch();
  estimateHandler = (await import('../api/estimate.js')).default;
  ingredientHandler = (await import('../api/ingredient.js')).default;
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

let seq = 0;
const id = prefix => `${prefix}-${Date.now()}-${(seq += 1)}`;
const photo = () => h.modelRequest({ image: h.PHOTO_B64 });
const label = () => h.modelRequest({ image: h.PHOTO_B64, text: 'read this nutrition label' });
const drinkId = () => h.modelRequest({ model: 'claude-haiku-4-5-20251001', image: h.SMALL_B64, text: 'identify the drink' });

async function period(subject) {
  const rows = await h.sqlJSON(`select photo_used, search_used, web_used, cost_usd::float, open_reservations
                                  from agni_allowance_periods where subject_id = '${subject}'
                                 order by period_start desc limit 1`);
  return rows[0] ?? { photo_used: 0, search_used: 0, web_used: 0, cost_usd: 0, open_reservations: 0 };
}
async function events(subject) {
  return h.sqlJSON(`select feature, bucket, credited, outcome, actual_usd::float
                      from agni_usage_events where subject_id = '${subject}' order by created_at`);
}
const send = (dev, feature, actionId, request) =>
  h.estimate(estimateHandler, dev, { feature, actionId, requestId: id('r'), request });

// 1
test('meal photo then drink identification under the SAME action: one photo credit', { skip }, async () => {
  const dev = await h.device();
  const action = id('photo');
  assert.equal((await send(dev, 'photo', action, photo())).statusCode, 200);
  assert.equal((await send(dev, 'drink_id', action, drinkId())).statusCode, 200);
  const p = await period('dev:' + dev.installId);
  assert.equal(p.photo_used, 1, 'one user photo, one credit');
  assert.equal(h.anthropic.calls.length, 2, 'both calls reached the provider');
});

// 2
test('documents the bug: the same pair under DIFFERENT actions costs two credits', { skip }, async () => {
  const dev = await h.device();
  assert.equal((await send(dev, 'photo', id('photo'), photo())).statusCode, 200);
  assert.equal((await send(dev, 'drink_id', id('drink'), drinkId())).statusCode, 200);
  assert.equal((await period('dev:' + dev.installId)).photo_used, 2,
    'what builds up to 177 do: the app must send the photo action id with the drink call');
});

// 3
test('provider failure then a successful retry of the same action: one credit, the failure billed nothing', { skip }, async () => {
  const dev = await h.device();
  const action = id('retry');
  h.anthropic.next({ status: 529, body: { type: 'error', error: { type: 'overloaded_error' } } });
  assert.equal((await send(dev, 'photo', action, photo())).statusCode, 529);
  assert.equal((await send(dev, 'photo', action, photo())).statusCode, 200);
  const subject = 'dev:' + dev.installId;
  const p = await period(subject);
  assert.equal(p.photo_used, 1);
  const rows = await events(subject);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].outcome, 'provider_529');
  assert.equal(rows[0].actual_usd, 0, 'an error response is recorded at zero cost');
  assert.ok(rows[1].actual_usd > 0);
  assert.equal(Number(p.cost_usd.toFixed(6)), Number(rows[1].actual_usd.toFixed(6)), 'period cost is the success only');
});

// 4
test('a failure that is not retried: credit returned; an error costs 0, a timeout keeps its reservation', { skip }, async () => {
  const errored = await h.device();
  h.anthropic.next({ status: 529, body: { type: 'error', error: { type: 'overloaded_error' } } });
  await send(errored, 'photo', id('a'), photo());
  const pe = await period('dev:' + errored.installId);
  assert.equal(pe.photo_used, 0);
  assert.equal(pe.cost_usd, 0);

  const timedOut = await h.device();
  h.anthropic.next({ throw: 'TimeoutError' });
  await send(timedOut, 'photo', id('a'), photo());
  const pt = await period('dev:' + timedOut.installId);
  assert.equal(pt.photo_used, 0, 'no unit consumed');
  assert.ok(pt.cost_usd > 0, 'but the unknown spend counts toward the cost cap (as implemented)');
});

// 5
test('a split plate (main call plus three parts, one action) costs one credit', { skip }, async () => {
  const dev = await h.device();
  const action = id('split');
  for (let part = 0; part <= 3; part += 1) {
    const raw = h.envelope(dev, { feature: 'photo', actionId: action, requestId: id('r'), request: photo() });
    const headers = await dev.bodyBound(Buffer.from(raw));
    const res = await h.call(estimateHandler, { method: 'POST', body: raw,
      headers: { ...headers, 'content-type': 'application/json', 'x-agni-part': String(part) } });
    assert.equal(res.statusCode, 200, `part ${part}: ${res.body}`);
  }
  assert.equal((await period('dev:' + dev.installId)).photo_used, 1);
  assert.equal(h.anthropic.calls.length, 4);
});

// 6
test('a hinted retry is a new action and a second credit (intended)', { skip }, async () => {
  const dev = await h.device();
  await send(dev, 'photo', id('first'), photo());
  await send(dev, 'photo', id('hinted'), h.modelRequest({ image: h.PHOTO_B64, text: 'a plate. Hint: it is upma' }));
  assert.equal((await period('dev:' + dev.installId)).photo_used, 2);
});

// 7
test('a label and a meal photo in separate actions take two units from the one shared photo bucket', { skip }, async () => {
  const dev = await h.device();
  assert.equal((await send(dev, 'label', id('label'), label())).statusCode, 200);
  assert.equal((await send(dev, 'photo', id('photo'), photo())).statusCode, 200);
  const p = await period('dev:' + dev.installId);
  assert.equal(p.photo_used, 2);
  assert.equal(p.search_used, 0);
});

// 8
test('an ingredient lookup with three nested web searches: one web unit, no search unit', { skip }, async () => {
  const dev = await h.device();
  const subject = await h.subscribe(dev, { purchase: h.daysFromNow(-3), expires: h.daysFromNow(27) });
  h.anthropic.next(h.okText('{"identity":{"canonical_name":"moringa"},"results":[],"notes":"none"}',
    { input_tokens: 20000, output_tokens: 800, server_tool_use: { web_search_requests: 3 } }));
  const res = await h.attestedPost(ingredientHandler, dev, '/api/ingredient',
    { query: 'moringa ' + Date.now(), installId: dev.installId, actionId: id('a'), requestId: id('r') });
  assert.equal(res.statusCode, 200, res.body);
  const p = await period(subject);
  assert.equal(p.web_used, 1);
  assert.equal(p.search_used, 0);
  assert.equal(p.photo_used, 0);
  const [event] = await events(subject);
  assert.equal(event.bucket, 'web');
});
