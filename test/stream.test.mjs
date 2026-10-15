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

function fakeReq(request) {
  const body = Buffer.from(JSON.stringify({ installId: 'install-1', request }));
  return {
    method: 'POST',
    headers: { authorization: 'Bearer test-token', 'content-length': String(body.length) },
    async *[Symbol.asyncIterator]() { yield body; }
  };
}

function fakeRes() {
  const res = {
    statusCode: 0, headers: {}, written: '', ended: false,
    status(code) { this.statusCode = code; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    flushHeaders() {},
    write(chunk) { this.written += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'); return true; },
    send(text) { this.written += text; this.ended = true; return this; },
    end() { this.ended = true; return this; },
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
