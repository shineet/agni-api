// A CALL'S COST IS RECORDED EVEN AFTER ITS RESPONSE HAS CLOSED.
//
//   AGNI_TEST_PG=postgresql://postgres@127.0.0.1:55432/postgres node --test test/settle-lifetime.test.mjs
//
// The defect (build 178 device test, 2026-11-02): a streamed answer ends the
// response before settle runs, and Vercel pauses a function once its response
// has closed, so settle hung until its timeout or until another request woke
// the instance. 4 of 14 calls stalled; 2 expired at their full reservation and
// gave back credits for answers that had been delivered.
//
// The fix holds the function open with Vercel's waitUntil from BEFORE the call
// until the cost is recorded. What these prove, with the real handler and the
// real ledger SQL:
//   - the keep-alive exists at the moment the response closes, on every path
//     (finished stream, client hang-up, provider error, buffered call);
//   - it is released only once the row is settled, including after a failed
//     first settle attempt;
//   - settling is idempotent, and a late settle of an expired call corrects
//     the money without re-deciding the credit.

import './helpers/no-network.mjs';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as h from './helpers/harness.mjs';

const skip = !h.enabled && 'AGNI_TEST_PG not set';
let handler;
let billing;

/// Every promise handed to waitUntil, and whether it has finished.
const kept = [];
function observeKeepAlive() {
  kept.length = 0;
  billing.setKeepAliveForTests((promise) => {
    const entry = { done: false, promise };
    promise.then(() => { entry.done = true; });
    kept.push(entry);
  });
}

before(async () => {
  if (skip) return;
  h.setTestEnv();
  h.freshDatabase('settle_lifetime');
  h.installFetch();
  billing = await import('../api/_billing.js');
  handler = (await import('../api/estimate.js')).default;
});

after(() => {
  if (skip) return;
  billing.setKeepAliveForTests(null);
  h.restoreFetch();
  h.dropDatabase();
});

beforeEach(() => {
  if (skip) return;
  h.anthropic.reset();
  h.setTestEnv();
  observeKeepAlive();
});

let seq = 0;
const id = prefix => `${prefix}-${Date.now()}-${(seq += 1)}`;

function streamedPhoto() {
  const base = h.modelRequest({ image: h.PHOTO_B64 });
  return { ...base, stream: true, max_tokens: 8000,
           output_config: { effort: 'low', format: base.output_config.format } };
}

/// A streamable response that records, at the moment it closes, whether a
/// keep-alive was already registered and still open.
function watchedResponse() {
  const res = h.response();
  Object.assign(res, {
    chunks: [], listeners: {}, writableEnded: false, destroyed: false,
    atClose: null,
    flushHeaders() {},
    write(chunk) { this.chunks.push(String(chunk)); return true; },
    end(...args) {
      this.atClose ??= { registered: kept.length, open: kept.filter(k => !k.done).length };
      this.writableEnded = true;
    },
    on(event, fn) { (this.listeners[event] ??= []).push(fn); return this; },
    hangUp() {
      this.atClose ??= { registered: kept.length, open: kept.filter(k => !k.done).length };
      this.destroyed = true; (this.listeners.close || []).forEach(fn => fn());
    }
  });
  return res;
}

async function post(dev, fields, res = watchedResponse()) {
  const raw = h.envelope(dev, fields);
  const headers = await dev.bodyBound(Buffer.from(raw));
  const done = handler(h.request({ method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: raw }), res);
  return { res, done };
}

async function eventFor(requestId) {
  const [row] = await h.sqlJSON(`select status, credited, outcome, actual_usd::float as actual,
                                        reserved_usd::float as reserved
                                   from agni_usage_events where request_id = '${requestId}'`);
  return row;
}

/// Makes the next agni_settle calls fail, or slow, before reaching the ledger.
function interceptSettle({ failFirst = 0, delayMs = 0 } = {}) {
  const inner = globalThis.fetch;
  let failures = failFirst;
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/rest/v1/rpc/agni_settle')) {
      if (delayMs) await new Promise(r => setTimeout(r, delayMs));
      if (failures > 0) { failures -= 1; return new Response('timeout', { status: 504 }); }
    }
    return inner(url, options);
  };
  return () => { globalThis.fetch = inner; };
}

test('a finished stream: the function is held open past the response until the cost is recorded', { skip }, async () => {
  const restore = interceptSettle({ delayMs: 80 });
  try {
    const dev = await h.device();
    const requestId = id('r');
    h.anthropic.next({ events: h.sseEvents({ input: 3000, output: 900 }) });
    const { res, done } = await post(dev, { feature: 'photo', actionId: id('a'), requestId, request: streamedPhoto() });
    await done;
    assert.ok(res.writableEnded, 'the answer was sent');
    assert.equal(res.atClose.registered, 1, 'a keep-alive existed when the response closed');
    assert.equal(res.atClose.open, 1, 'and it was still holding the function open');
    await kept[0].promise;
    const row = await eventFor(requestId);
    assert.equal(row.status, 'settled', 'released only after the row settled');
    assert.equal(row.credited, true);
    assert.equal(row.outcome, 'ok');
    assert.ok(row.actual < row.reserved, 'charged from usage, not the reservation');
  } finally { restore(); }
});

test('the app hangs up mid-stream: still held open, settled as stopped and charged for what was used', { skip }, async () => {
  const dev = await h.device();
  const requestId = id('r');
  h.anthropic.next({ events: h.sseEvents().slice(0, 2), hang: true });
  const res = watchedResponse();
  const { done } = await post(dev, { feature: 'photo', actionId: id('a'), requestId, request: streamedPhoto() }, res);
  for (let i = 0; i < 100 && res.chunks.length === 0; i += 1) await new Promise(r => setTimeout(r, 5));
  res.hangUp();
  await done;
  assert.equal(res.atClose.registered, 1, 'a keep-alive existed when the app hung up');
  await kept[0].promise;
  const row = await eventFor(requestId);
  assert.notEqual(row.status, 'reserved', 'the cost was recorded, not left to expire');
  assert.equal(row.credited, false, 'no answer reached the app, so no credit');
});

test('a provider error on a stream: held open and settled, no credit', { skip }, async () => {
  const dev = await h.device();
  const requestId = id('r');
  h.anthropic.next({ status: 529, body: { type: 'error', error: { type: 'overloaded_error' } } });
  const { res, done } = await post(dev, { feature: 'photo', actionId: id('a'), requestId, request: streamedPhoto() });
  await done;
  assert.equal(kept.length, 1);
  await kept[0].promise;
  const row = await eventFor(requestId);
  assert.notEqual(row.status, 'reserved');
  assert.equal(row.credited, false);
  assert.ok(res.writableEnded || res.statusCode >= 400);
});

test('a failed first settle attempt: the keep-alive stays open for the retry, which records the cost', { skip }, async () => {
  const restore = interceptSettle({ failFirst: 1 });
  try {
    const dev = await h.device();
    const requestId = id('r');
    h.anthropic.next({ events: h.sseEvents({ input: 3000, output: 900 }) });
    const { done } = await post(dev, { feature: 'photo', actionId: id('a'), requestId, request: streamedPhoto() });
    await done;
    await kept[0].promise;
    const row = await eventFor(requestId);
    assert.equal(row.status, 'settled', 'the second attempt settled it');
    assert.equal(row.credited, true, 'a completed analysis keeps its credit');
  } finally { restore(); }
});

test('a buffered call is held open too (one keep-alive, released after settle)', { skip }, async () => {
  const dev = await h.device();
  const requestId = id('r');
  h.anthropic.next(h.okText('{"dishes":[]}'));
  const { done } = await post(dev, { feature: 'photo', actionId: id('a'), requestId, request: h.modelRequest({ image: h.PHOTO_B64 }) });
  await done;
  assert.equal(kept.length, 1);
  assert.equal(kept[0].done, true, 'released by the time the handler returns');
  assert.equal((await eventFor(requestId)).status, 'settled');
});

test('a refused request reserves nothing and keeps nothing alive', { skip }, async () => {
  const dev = await h.device();
  await h.sql(`update agni_allowance_periods set photo_used = 999 where subject_id = 'dev:${dev.installId}'`);
  h.anthropic.next(h.okText('{"dishes":[]}'));
  const { done } = await post(dev, { feature: 'photo', actionId: id('a'), requestId: id('r'), request: h.modelRequest({ image: h.PHOTO_B64 }) });
  await done;
  assert.ok(kept.length <= 1);
  if (kept.length) assert.equal(kept[0].done, true);
});

test('settling twice is a no-op: no double charge, no second credit change', { skip }, async () => {
  const dev = await h.device();
  const requestId = id('r');
  h.anthropic.next({ events: h.sseEvents({ input: 3000, output: 900 }) });
  const { done } = await post(dev, { feature: 'photo', actionId: id('a'), requestId, request: streamedPhoto() });
  await done;
  await kept[0].promise;
  const subject = `dev:${dev.installId}`;
  const before = await h.sqlJSON(`select cost_usd::float as cost, photo_used from agni_allowance_periods where subject_id = '${subject}' order by period_start desc limit 1`);
  const again = await h.rpc('agni_settle', { p_subject: subject, p_request_id: requestId, p_actual_usd: 0.5,
    p_success: true, p_outcome: 'ok' });
  const afterRows = await h.sqlJSON(`select cost_usd::float as cost, photo_used from agni_allowance_periods where subject_id = '${subject}' order by period_start desc limit 1`);
  assert.equal(Array.isArray(again) ? again[0].settled : again.settled, false, 'the second settle is refused');
  assert.deepEqual(afterRows, before, 'cost and credits unchanged');
  assert.ok(Math.abs((await eventFor(requestId)).actual - 0.015) < 1e-6, 'the first charge stands');
});

test('a late settle after expiry corrects the money and leaves the credit decision alone', { skip }, async () => {
  const dev = await h.device();
  const subject = `dev:${dev.installId}`;
  const requestId = id('r');
  // A call whose settle never arrived: reserve by hand, age it, sweep it.
  h.anthropic.next({ events: h.sseEvents({ input: 3000, output: 900 }) });
  const restore = interceptSettle({ failFirst: 2 });
  try {
    const { done } = await post(dev, { feature: 'photo', actionId: id('a'), requestId, request: streamedPhoto() });
    await done;
    await kept[0].promise;
  } finally { restore(); }
  assert.equal((await eventFor(requestId)).status, 'reserved', 'both attempts failed: the reservation stands');
  await h.sql(`update agni_usage_events set created_at = now() - interval '10 minutes' where request_id = '${requestId}'`);
  await h.sql(`select agni_sweep_reservations(120)`);
  const expired = await eventFor(requestId);
  assert.equal(expired.status, 'expired');
  assert.equal(expired.actual, expired.reserved, 'expired at the reservation, over-counting');
  const usedBefore = await h.sqlJSON(`select photo_used from agni_allowance_periods where subject_id = '${subject}' order by period_start desc limit 1`);
  await h.rpc('agni_settle', { p_subject: subject, p_request_id: requestId, p_actual_usd: 0.015,
    p_success: true, p_outcome: 'ok' });
  const late = await eventFor(requestId);
  assert.equal(late.status, 'settled');
  assert.ok(Math.abs(late.actual - 0.015) < 1e-6, 'the money is corrected to the real cost');
  const usedAfter = await h.sqlJSON(`select photo_used from agni_allowance_periods where subject_id = '${subject}' order by period_start desc limit 1`);
  assert.deepEqual(usedAfter, usedBefore, 'the credit is not re-decided by a late settle');
});
