// THE STREAMED ESTIMATE, end to end: the real handler, the real ledger SQL, a
// scripted provider that streams.
//
//   AGNI_TEST_PG=postgresql://postgres@127.0.0.1:55432/postgres node --test test/stream.test.mjs
//
// What matters and is invisible from the app: the events reach the phone
// unchanged, a photo is credited once however many parallel parts it took,
// only a finished answer is credited, a stopped one is still charged for what
// it used, and an old build that does not ask for a stream gets the JSON it
// always had.

import './helpers/no-network.mjs';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as h from './helpers/harness.mjs';

const skip = !h.enabled && 'AGNI_TEST_PG not set';
let handler;

before(async () => {
  if (skip) return;
  h.setTestEnv();
  h.freshDatabase('stream');
  h.installFetch();
  handler = (await import('../api/estimate.js')).default;
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

/// The meal photo as current builds send it.
function streamedPhoto(extra = {}) {
  const base = h.modelRequest({ image: h.PHOTO_B64 });
  return {
    ...base, stream: true, max_tokens: 8000,
    output_config: { effort: 'low', format: base.output_config.format },
    ...extra
  };
}

/// A response that can be streamed into and hung up on, as Node's is.
function streamResponse() {
  const res = h.response();
  Object.assign(res, {
    chunks: [], listeners: {}, writableEnded: false, destroyed: false, flushed: false,
    flushHeaders() { this.flushed = true; },
    write(chunk) { this.chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()); return true; },
    end() { this.writableEnded = true; },
    on(event, fn) { (this.listeners[event] ??= []).push(fn); return this; },
    hangUp() { this.destroyed = true; (this.listeners.close || []).forEach(fn => fn()); }
  });
  Object.defineProperty(res, 'text', { get() { return this.chunks.join(''); } });
  return res;
}

async function post(dev, fields, { part = 0, res = streamResponse(), legacyShape = false } = {}) {
  const raw = legacyShape
    ? JSON.stringify({ installId: dev.installId, request: fields.request })
    : h.envelope(dev, fields);
  const headers = await dev.bodyBound(Buffer.from(raw));
  if (part) headers['x-agni-part'] = String(part);
  await handler(h.request({ method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: raw }), res);
  return res;
}

async function photosUsed(dev) {
  const rows = await h.sqlJSON(`select photo_used, open_reservations from agni_allowance_periods
                                 where subject_id = 'dev:${dev.installId}' order by period_start desc limit 1`);
  return rows[0] || { photo_used: 0, open_reservations: 0 };
}

async function usageEvents(dev) {
  return h.sqlJSON(`select status, credited, outcome, reserved_usd::float as reserved, actual_usd::float as actual
                      from agni_usage_events where subject_id = 'dev:${dev.installId}' order by created_at`);
}

const until = async (condition) => {
  for (let i = 0; i < 200 && !condition(); i += 1) await new Promise(r => setTimeout(r, 5));
};

test('a stream reaches the app event for event, and a finished one is one credit, settled from usage', { skip }, async () => {
  const dev = await h.device();
  const events = h.sseEvents({ input: 3000, output: 900 });
  h.anthropic.next({ events });
  const res = await post(dev, { feature: 'photo', actionId: id('a'), requestId: id('r'), request: streamedPhoto() });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'text/event-stream');
  assert.ok(res.headers['x-agni-allowance'], 'what is left goes out with the headers');
  assert.equal(res.text, events.join(''), 'the events arrive unchanged');
  assert.ok(res.writableEnded);
  assert.equal(h.anthropic.calls[0].stream, true);
  assert.equal(h.anthropic.calls[0].output_config.effort, 'low');
  assert.equal((await photosUsed(dev)).photo_used, 1);
  const [event] = await usageEvents(dev);
  assert.equal(event.credited, true);
  assert.equal(event.outcome, 'ok');
  // Sonnet: 3000 in at $2/M plus 900 out at $10/M.
  assert.ok(Math.abs(event.actual - 0.015) < 1e-6, `charged ${event.actual}`);
  assert.ok(event.actual < event.reserved);
});

test('a stream cut part way is no credit, ends with an error event, and is charged for what it used', { skip }, async () => {
  const dev = await h.device();
  h.anthropic.next({ events: h.sseEvents(), cutAfter: 2 });
  const res = await post(dev, { feature: 'photo', actionId: id('a'), requestId: id('r'), request: streamedPhoto() });
  assert.equal(res.statusCode, 200);
  assert.match(res.text, /event: error/);
  assert.match(res.text, /cut off/);
  assert.equal((await photosUsed(dev)).photo_used, 0);
  const [event] = await usageEvents(dev);
  assert.equal(event.credited, false);
  assert.equal(event.outcome, 'cut');
  assert.ok(event.actual > 0, 'the input was billed, so it is charged');
  assert.ok(event.actual < event.reserved, 'and from usage, not the worst case');
});

test('a build that does not ask for a stream gets plain JSON, as before', { skip }, async () => {
  const dev = await h.device();
  h.anthropic.next(h.okText('{"dishes":[]}'));
  const res = await post(dev, { feature: 'photo', actionId: id('a'), requestId: id('r'), request: h.modelRequest({ image: h.PHOTO_B64 }) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json.content[0].text, '{"dishes":[]}');
  assert.equal(res.chunks.length, 0, 'nothing was streamed');
});

test('a stream may ask for up to 8192 tokens, a buffered call still only 4096', { skip }, async () => {
  const dev = await h.device();
  const buffered = await post(dev, { feature: 'photo', actionId: id('a'), requestId: id('r'),
                                     request: { ...streamedPhoto(), stream: false } });
  assert.equal(buffered.statusCode, 400);
  const over = await post(dev, { feature: 'photo', actionId: id('a'), requestId: id('r'),
                                 request: streamedPhoto({ max_tokens: 8193 }) });
  assert.equal(over.statusCode, 400);
  assert.equal(h.anthropic.calls.length, 0);
});

test('a big plate is one credit: parts share the action, and the stopped main call gives its own back', { skip }, async () => {
  const dev = await h.device();
  const actionId = id('plate');
  // The main call lists the dishes and is stopped once the parts cover them.
  h.anthropic.next({ events: h.sseEvents().slice(0, 2), hang: true },
                   { events: h.sseEvents() }, { events: h.sseEvents() });
  const main = streamResponse();
  const mainDone = post(dev, { feature: 'photo', actionId, requestId: id('r'), request: streamedPhoto() }, { res: main });
  await until(() => main.chunks.length > 0);
  for (const part of [1, 2]) {
    const res = await post(dev, { feature: 'photo', actionId, requestId: id('r'), request: streamedPhoto() }, { part });
    assert.match(res.text, /^: accepted/, 'a part is accepted before the model answers');
    assert.match(res.text, /message_stop/);
  }
  main.hangUp();
  await mainDone;
  const used = await photosUsed(dev);
  assert.equal(used.photo_used, 1, 'one photo, one credit');
  assert.equal(used.open_reservations, 0);
  const events = await usageEvents(dev);
  assert.equal(events.length, 3);
  // The credit stays on the call that took it (the main one): the action
  // succeeded, so the stopped call keeps it rather than charging twice.
  assert.equal(events.filter(e => e.credited).length, 1);
  assert.ok(events.some(e => e.outcome === 'stopped'));
});

test('the app hanging up stops the upstream answer, costs no credit, and is charged for what it used', { skip }, async () => {
  const dev = await h.device();
  h.anthropic.next({ events: h.sseEvents().slice(0, 2), hang: true });
  const res = streamResponse();
  const done = post(dev, { feature: 'photo', actionId: id('a'), requestId: id('r'), request: streamedPhoto() }, { res });
  await until(() => res.chunks.length > 0);
  res.hangUp();
  await done;
  assert.equal((await photosUsed(dev)).photo_used, 0);
  const [event] = await usageEvents(dev);
  assert.equal(event.outcome, 'stopped');
  assert.equal(event.credited, false);
  assert.ok(event.actual > 0 && event.actual < event.reserved);
  assert.ok(!res.text.includes('event: error'), 'nothing is written to an app that has gone');
});

test('a part refused by the model ends as an error event, after the early 200', { skip }, async () => {
  const dev = await h.device();
  h.anthropic.next({ status: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } });
  const res = await post(dev, { feature: 'photo', actionId: id('a'), requestId: id('r'), request: streamedPhoto() }, { part: 2 });
  assert.equal(res.statusCode, 200);
  assert.match(res.text, /^: accepted/);
  assert.match(res.text, /event: error/);
  assert.match(res.text, /529/);
  assert.equal((await photosUsed(dev)).photo_used, 0);
});

test('the main call is not answered early: its refusals keep their status', { skip }, async () => {
  const dev = await h.device();
  h.anthropic.next({ status: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } });
  const res = await post(dev, { feature: 'photo', actionId: id('a'), requestId: id('r'), request: streamedPhoto() });
  assert.equal(res.statusCode, 529);
  assert.equal(res.json.error.type, 'overloaded_error');
  assert.equal(res.chunks.length, 0);
});

test('before launch, a build with no actionId spends one beta credit per photo, not one per part', { skip }, async () => {
  process.env.BILLING_ENFORCED = 'false';
  const dev = await h.device();
  h.anthropic.next({ events: h.sseEvents().slice(0, 2), hang: true },
                   { events: h.sseEvents() }, { events: h.sseEvents() });
  const main = streamResponse();
  const mainDone = post(dev, { request: streamedPhoto() }, { res: main, legacyShape: true });
  await until(() => main.chunks.length > 0);
  await post(dev, { request: streamedPhoto() }, { part: 1, legacyShape: true });
  await post(dev, { request: streamedPhoto() }, { part: 2, legacyShape: true });
  main.hangUp();
  await mainDone;
  const [row] = await h.sqlJSON(`select estimates_used from agni_installs where install_id = '${dev.keyId.replace(/'/g, "''")}'`);
  assert.equal(row?.estimates_used, 1);
});
