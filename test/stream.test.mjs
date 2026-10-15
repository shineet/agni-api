import test from 'node:test';
import assert from 'node:assert/strict';

/// THE STREAMED ESTIMATE, end to end against fakes.
///
/// What matters and is invisible from the app: the events reach the phone
/// unchanged, a credit is spent only for an answer that finished, and an old
/// build that does not ask for a stream gets the same JSON it always had.

process.env.APP_TOKEN = 'test-token';
process.env.LEGACY_TOKEN_ENABLED = 'true';
process.env.SUPABASE_URL = 'https://db.example';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_test';
process.env.ANTHROPIC_API_KEY = 'sk-test';

const { default: handler } = await import('../api/estimate.js');

const EVENTS = [
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1}}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"{\\"a\\":"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"1}"}}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n'
];

function fakeFetch({ events, cutAfter }) {
  const calls = [];
  const fn = async (url, options) => {
    calls.push({ url: String(url), body: options?.body });
    if (String(url).includes('/rpc/agni_check')) {
      return Response.json([{ used: 0, is_unlimited: false }]);
    }
    if (String(url).includes('/rpc/agni_consume')) return Response.json(1);
    if (String(url).includes('api.anthropic.com')) {
      const sent = JSON.parse(options.body);
      if (!sent.stream) {
        return Response.json({ content: [{ type: 'text', text: '{"a":1}' }], usage: {} });
      }
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          events.forEach((e, i) => {
            if (cutAfter !== undefined && i >= cutAfter) return;
            // Split mid-event, as a network does, to prove nothing relies on
            // an event arriving in one piece.
            const half = Math.floor(e.length / 2);
            controller.enqueue(encoder.encode(e.slice(0, half)));
            controller.enqueue(encoder.encode(e.slice(half)));
          });
          if (cutAfter !== undefined) controller.error(new Error('socket hang up'));
          else controller.close();
        }
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  fn.calls = calls;
  return fn;
}

function fakeReq(request, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify({ installId: 'install-1', request }));
  return {
    method: 'POST',
    headers: { authorization: 'Bearer test-token', 'content-length': String(body.length), ...extraHeaders },
    async *[Symbol.asyncIterator]() { yield body; }
  };
}

function fakeRes() {
  const res = {
    statusCode: 0, headers: {}, written: '', ended: false, writableEnded: false,
    listeners: {},
    on(event, fn) { (this.listeners[event] ||= []).push(fn); return this; },
    status(code) { this.statusCode = code; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    flushHeaders() {},
    write(chunk) { this.written += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'); return true; },
    send(text) { this.written += text; this.ended = true; return this; },
    end() { this.ended = true; this.writableEnded = true; return this; },
    json(obj) { return this.send(JSON.stringify(obj)); }
  };
  return res;
}

const request = (extra = {}) => ({
  model: 'claude-sonnet-5', max_tokens: 4096,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], ...extra
});

test('a stream reaches the app event for event, and a finished one costs a credit', async () => {
  globalThis.fetch = fakeFetch({ events: EVENTS });
  const res = fakeRes();
  await handler(fakeReq(request({ stream: true })), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'text/event-stream');
  assert.equal(res.written, EVENTS.join(''));
  assert.ok(res.ended);
  assert.equal(globalThis.fetch.calls.filter(c => c.url.includes('agni_consume')).length, 1);
});

test('a stream cut part way costs nothing and ends with an error event', async () => {
  globalThis.fetch = fakeFetch({ events: EVENTS, cutAfter: 2 });
  const res = fakeRes();
  await handler(fakeReq(request({ stream: true })), res);
  assert.match(res.written, /event: error\ndata: .*serviceUnavailable/);
  assert.ok(res.ended);
  assert.equal(globalThis.fetch.calls.filter(c => c.url.includes('agni_consume')).length, 0);
});

test('a build that does not ask for a stream gets plain JSON, as before', async () => {
  globalThis.fetch = fakeFetch({ events: EVENTS });
  const res = fakeRes();
  await handler(fakeReq(request()), res);
  assert.equal(res.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(res.written).content[0].text, '{"a":1}');
});

test('a stream may ask for up to 8192 tokens, a buffered call still only 4096', async () => {
  const { validateRequest } = await import('../api/_lib.js');
  assert.equal(validateRequest(request({ stream: true, max_tokens: 8000 })), null);
  assert.match(validateRequest(request({ stream: true, max_tokens: 9000 })), /8192/);
  assert.match(validateRequest(request({ max_tokens: 8000 })), /4096/);
  assert.equal(validateRequest(request({ max_tokens: 4096 })), null);
});

test('a big plate pays once: part 1 is charged, later parts are not', async () => {
  for (const [part, charged] of [['1', 1], ['2', 0], ['3', 0]]) {
    globalThis.fetch = fakeFetch({ events: EVENTS });
    const res = fakeRes();
    await handler(fakeReq(request({ stream: true }), { 'x-agni-part': part }), res);
    assert.equal(res.written, ': accepted\n\n' + EVENTS.join(''),
                 `part ${part} is accepted first, then streams in full`);
    assert.equal(globalThis.fetch.calls.filter(c => c.url.includes('agni_consume')).length, charged,
                 `part ${part}`);
  }
});

test('the app hanging up stops the upstream answer, and costs no credit', async () => {
  let upstreamSignal;
  const base = fakeFetch({ events: EVENTS });
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('api.anthropic.com')) {
      upstreamSignal = options.signal;
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(EVENTS[0]));
          options.signal.addEventListener('abort', () => controller.error(options.signal.reason));
        }
      });
      return new Response(stream, { status: 200 });
    }
    return base(url, options);
  };
  globalThis.fetch.calls = base.calls;
  const res = fakeRes();
  const done = handler(fakeReq(request({ stream: true })), res);
  await new Promise(r => setTimeout(r, 20));
  for (const fn of res.listeners.close || []) fn();
  await done;
  assert.ok(upstreamSignal.aborted, 'the upstream request was aborted');
  assert.equal(base.calls.filter(c => c.url.includes('agni_consume')).length, 0);
});

test('a part refused by the model ends as an error event, after the early 200', async () => {
  const base = fakeFetch({ events: EVENTS });
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('api.anthropic.com')) {
      return Response.json({ type: 'error', error: { type: 'overloaded_error' } }, { status: 529 });
    }
    return base(url, options);
  };
  const res = fakeRes();
  await handler(fakeReq(request({ stream: true }), { 'x-agni-part': '2' }), res);
  assert.equal(res.statusCode, 200);
  assert.match(res.written, /^: accepted\n\nevent: error\ndata: .*serviceUnavailable/);
  assert.ok(res.ended);
  assert.equal(base.calls.filter(c => c.url.includes('agni_consume')).length, 0);
});

test('the main call is not answered early: its refusals keep their status', async () => {
  const base = fakeFetch({ events: EVENTS });
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('api.anthropic.com')) {
      return Response.json({ type: 'error', error: { type: 'overloaded_error' } }, { status: 529 });
    }
    return base(url, options);
  };
  const res = fakeRes();
  await handler(fakeReq(request({ stream: true })), res);
  assert.equal(res.statusCode, 529);
});
