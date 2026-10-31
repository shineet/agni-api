// Runs the real handlers against the real SQL.
//
// Supabase RPCs are executed against a local Postgres (AGNI_TEST_PG, e.g.
// postgresql://postgres@127.0.0.1:55432/postgres) with every schema file
// applied, so agni_reserve, agni_settle and the gates run exactly as they would
// in Supabase. Anthropic is a scripted stub. App Attest assertions are signed
// the way a device signs them, with a key registered in the test database.
//
// Each psql call is its own connection, so calls made with Promise.all really
// do race inside Postgres: the concurrency tests are not simulated.

import { noNetworkFetch } from './no-network.mjs';
import { execFile, execFileSync } from 'node:child_process';
import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import path from 'node:path';

const run = promisify(execFile);
const PSQL = process.env.AGNI_TEST_PSQL || '/opt/homebrew/opt/postgresql@17/bin/psql';
export const PG_URL = process.env.AGNI_TEST_PG || '';
export const enabled = !!PG_URL;
const ROOT = path.join(import.meta.dirname, '..', '..');

export const APP_ID = 'B2WG3MN7S3.com.shinethankappan.agni';

export function setTestEnv(extra = {}) {
  Object.assign(process.env, {
    SUPABASE_URL: 'http://supabase.test',
    SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_test',
    ANTHROPIC_API_KEY: 'test-key',
    APP_TOKEN: 'legacy-token',
    APP_ATTEST_APP_ID: APP_ID,
    LEGACY_TOKEN_ENABLED: 'true',
    BILLING_ENFORCED: 'true',
    AI_ENABLED: 'true',
    RESEARCH_ENABLED: 'true',
    AGNI_TEST_APPLE_ROOT: path.join(ROOT, 'test/fixtures/storekit/root.pem'),
    APP_APPLE_ID: '6700000000',
    ALLOW_SANDBOX_TRANSACTIONS: 'true',
    // The App Attest call windows (10 a minute) are real and tested in the
    // gate tests; here they would only stop the loops that test allowances.
    RATE_PER_MINUTE: '100000', RATE_PER_HOUR: '100000', RATE_PER_DAY: '100000',
    RESEARCH_PER_MINUTE: '100000', RESEARCH_PER_DAY: '100000',
    ...extra
  });
}

// MARK: - Database

function dbURL(name) {
  const url = new URL(PG_URL);
  url.pathname = '/' + name;
  return url.toString();
}

let database = null;

/// A fresh database with every schema applied, per test file.
export function freshDatabase(label) {
  database = `agni_test_${label}_${process.pid}`;
  execFileSync(PSQL, [PG_URL, '-q', '-c', `drop database if exists ${database}`]);
  execFileSync(PSQL, [PG_URL, '-q', '-c', `create database ${database}`]);
  // The roles Supabase has and a plain Postgres does not; the older schema
  // files grant and revoke against them.
  for (const role of ['anon', 'authenticated', 'service_role']) {
    execFileSync(PSQL, [PG_URL, '-q', '-c',
      `do $$ begin create role ${role}; exception when duplicate_object then null; end $$`]);
  }
  // SUPABASE'S DEFAULT GRANTS: every new table, view and function in public is
  // granted to anon and authenticated. Without these a test of what anon can
  // reach proves nothing.
  execFileSync(PSQL, [dbURL(database), '-q', '-c',
    `alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
     alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;`]);
  for (const file of ['schema.sql', 'schema-attest.sql', 'schema-limits.sql', 'schema-auth.sql',
                      'schema-variants.sql', 'schema-community.sql', 'schema-misses.sql',
                      'schema-ingredient-cache.sql', 'schema-beta.sql', 'schema-billing.sql', 'schema-retention.sql',
                      'schema-contributor-migration.sql',
                      'schema-lockdown.sql']) {
    execFileSync(PSQL, [dbURL(database), '-q', '-v', 'ON_ERROR_STOP=1', '-f', path.join(ROOT, file)],
                 { stdio: ['ignore', 'ignore', 'pipe'] });
  }
  return database;
}

export function dropDatabase() {
  if (database) execFileSync(PSQL, [PG_URL, '-q', '-c', `drop database if exists ${database} with (force)`]);
}

export async function sql(text) {
  const { stdout } = await run(PSQL, [dbURL(database), '-At', '-v', 'ON_ERROR_STOP=1', '-c', text]);
  return stdout.trim();
}

export async function sqlJSON(text) {
  const out = await sql(`select coalesce(json_agg(t), '[]'::json) from (${text}) t`);
  return JSON.parse(out);
}

function literal(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return `'${text.replace(/'/g, "''")}'`;
}

let setReturning = null;
async function returnsSet(fn) {
  if (!setReturning) {
    const rows = await sqlJSON(`select proname, proretset from pg_proc where proname like 'agni%'`);
    setReturning = new Map(rows.map(r => [r.proname, r.proretset]));
  }
  return setReturning.get(fn);
}

/// What PostgREST would answer for /rest/v1/rpc/<fn>.
export async function rpc(fn, args) {
  const call = `${fn}(${Object.entries(args || {}).map(([k, v]) => `${k} => ${literal(v)}`).join(', ')})`;
  if (await returnsSet(fn)) {
    return JSON.parse(await sql(`select coalesce(json_agg(t), '[]'::json) from ${call} t`));
  }
  return JSON.parse(await sql(`select to_json(${call})`));
}

// MARK: - Network stub

export const anthropic = {
  calls: [],
  queue: [],
  /// The next provider responses, in order. Anything not queued gets `fallback`.
  next(...responses) { this.queue.push(...responses); },
  fallback: { status: 200, usage: { input_tokens: 3000, output_tokens: 600 } },
  reset() { this.calls = []; this.queue = []; }
};

export function okText(text, usage = { input_tokens: 3000, output_tokens: 600 }, extra = {}) {
  return { status: 200, body: { content: [{ type: 'text', text }], usage, ...extra } };
}

// Restores the fail-closed guard, never the real fetch (see no-network.mjs).
const realFetch = noNetworkFetch;
export function installFetch() {
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.startsWith('http://supabase.test/rest/v1/rpc/')) {
      const fn = target.split('/').pop();
      const result = await rpc(fn, JSON.parse(options.body || '{}'));
      const text = result === null ? '' : JSON.stringify(result);
      return new Response(text, { status: text ? 200 : 204, headers: { 'content-type': 'application/json' } });
    }
    if (target === 'https://api.anthropic.com/v1/messages') {
      const body = JSON.parse(options.body);
      anthropic.calls.push(body);
      const response = anthropic.queue.length ? anthropic.queue.shift() : anthropic.fallback;
      if (response.delayMs) await new Promise(r => setTimeout(r, response.delayMs));
      if (response.throw) {
        const error = new Error(response.throw);
        error.name = response.throw;
        throw error;
      }
      if (response.events) return streamedResponse(response, options.signal);
      const payload = response.body ?? {
        content: [{ type: 'text', text: '{"ok":true}' }],
        usage: response.usage
      };
      return new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), {
        status: response.status ?? 200,
        headers: { 'content-type': 'application/json', 'request-id': 'req_test' }
      });
    }
    return realFetch(url, options);   // loopback passes, anything else throws
  };
}
export function restoreFetch() { globalThis.fetch = realFetch; }

/// A provider stream: each event split in two, as a network does, so nothing
/// may rely on an event arriving whole. `cutAfter` errors the stream after
/// that many events; `hang` holds it open until the caller aborts.
function streamedResponse({ events, cutAfter, hang, status = 200 }, signal) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      const abort = () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        try { controller.error(error); } catch {}
      };
      signal?.addEventListener('abort', abort);
      events.forEach((e, i) => {
        if (cutAfter !== undefined && i >= cutAfter) return;
        const half = Math.floor(e.length / 2);
        controller.enqueue(encoder.encode(e.slice(0, half)));
        controller.enqueue(encoder.encode(e.slice(half)));
      });
      // Later, so the events already sent are read first: error() discards
      // whatever is still queued, which is not what a dropped socket does.
      if (cutAfter !== undefined) setTimeout(() => controller.error(new Error('socket hang up')), 20);
      else if (!hang) controller.close();
    }
  });
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_stream' } });
}

/// Anthropic's events for one finished answer.
export function sseEvents({ input = 10, output = 5, text = '{"dishes":[]}' } = {}) {
  return [
    `event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":${input},"output_tokens":1}}}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n`,
    `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":${output}}}\n\n`,
    'event: message_stop\ndata: {"type":"message_stop"}\n\n'
  ];
}

// MARK: - Requests

/// A request object the handlers can read: headers, query, and a body stream.
export function request({ method = 'POST', headers = {}, query = {}, body = '' }) {
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return {
    method,
    query,
    headers: { 'x-forwarded-for': '203.0.113.7', ...Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) },
    socket: {},
    async *[Symbol.asyncIterator]() { if (raw.length) yield raw; }
  };
}

export function response() {
  const res = {
    statusCode: 200, headers: {}, body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    send(text) { this.body = text; return this; },
    get json() { try { return JSON.parse(this.body); } catch { return null; } }
  };
  return res;
}

export async function call(handler, options) {
  const res = response();
  await handler(request(options), res);
  return res;
}

// MARK: - App Attest, signed as a device signs

function authenticatorData(counter) {
  const rpIdHash = createHash('sha256').update(APP_ID).digest();
  const header = Buffer.alloc(5);
  header.writeUInt32BE(counter, 1);
  return Buffer.concat([rpIdHash, header]);
}

function cbor(signature, authData) {
  const bytes = b => b.length < 24 ? Buffer.concat([Buffer.from([0x40 + b.length]), b])
    : b.length < 256 ? Buffer.concat([Buffer.from([0x58, b.length]), b])
    : Buffer.concat([Buffer.from([0x59, b.length >> 8, b.length & 0xff]), b]);
  const text = s => Buffer.concat([Buffer.from([0x60 + s.length]), Buffer.from(s)]);
  return Buffer.concat([Buffer.from([0xa2]), text('signature'), bytes(signature),
                        text('authenticatorData'), bytes(authData)]);
}

/// One installed copy of Agni on one phone: an attested key and a Keychain id.
export async function device({ installId = 'INSTALL-' + randomBytes(6).toString('hex'), unlimited = false } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const keyId = randomBytes(32).toString('base64');
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  await sql(`insert into agni_attest_keys (key_id, public_key_pem, environment, unlimited)
             values (${literal(keyId)}, ${literal(pem)}, 'production', ${unlimited})`);
  let counter = 0;

  async function sign(binding, reuse = null) {
    const challenge = reuse || randomBytes(32).toString('base64');
    if (!reuse) await sql(`insert into agni_attest_challenges (nonce) values (${literal(challenge)})`);
    counter += 1;
    const clientData = Buffer.concat([Buffer.from(challenge, 'base64'),
                                      createHash('sha256').update(binding).digest()]);
    const authData = authenticatorData(counter);
    const clientDataHash = createHash('sha256').update(clientData).digest();
    const nonce = createHash('sha256').update(Buffer.concat([authData, clientDataHash])).digest();
    const signature = createSign('SHA256').update(nonce).sign(privateKey);
    return {
      'x-agni-key-id': keyId,
      'x-agni-assertion': cbor(signature, authData).toString('base64'),
      'x-agni-challenge': challenge
    };
  }

  return {
    keyId, installId,
    /// Headers for a request bound the way current builds bind: the canonical
    /// method, path, sorted query and body digest.
    async canonical(method, pathName, query, rawBody, { reuseChallenge = null } = {}) {
      const { canonicalRequest } = await import('../../api/_auth.js');
      return sign(canonicalRequest(method, pathName, query, rawBody), reuseChallenge);
    },
    /// Headers bound the way builds 174 and 175 bind /api/estimate: the body.
    async bodyBound(rawBody) { return sign(rawBody); }
  };
}

// MARK: - Bodies shaped like the app's

export const PHOTO_B64 = Buffer.alloc(200_000, 7).toString('base64');   // ~267k chars, like a 1568px JPEG
export const SMALL_B64 = Buffer.alloc(30_000, 7).toString('base64');    // like the 512px drink check

export function modelRequest({ model = 'claude-sonnet-5', image = null, text = 'a plate', system = 'You estimate food.' } = {}) {
  const content = [];
  if (image) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } });
  content.push({ type: 'text', text });
  return {
    model, max_tokens: 4096, system,
    output_config: { format: { type: 'json_schema', schema: { type: 'object', properties: { dishes: { type: 'array' } } } } },
    messages: [{ role: 'user', content }]
  };
}

export function envelope(dev, { feature, actionId, requestId, request }) {
  return JSON.stringify({ installId: dev.installId, feature, actionId, requestId, request });
}

/// An attested POST to /api/estimate the way a current build sends it.
export async function estimate(handler, dev, fields) {
  const raw = envelope(dev, fields);
  const headers = await dev.bodyBound(Buffer.from(raw));
  return call(handler, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: raw });
}

/// An attested POST to a canonical-bound route.
export async function attestedPost(handler, dev, pathName, body, query = {}) {
  const raw = JSON.stringify(body);
  const headers = await dev.canonical('POST', pathName, query, raw);
  return call(handler, { method: 'POST', query, headers, body: raw });
}

export async function attestedGet(handler, dev, pathName, query = {}, extra = {}) {
  const headers = await dev.canonical('GET', pathName, query, '');
  return call(handler, { method: 'GET', query, headers: { ...headers, ...extra } });
}

/// Writes a subscription as if a verified transaction had arrived, and links it.
export async function subscribe(dev, { otid = 'OT' + randomBytes(5).toString('hex'), product = 'com.shinethankappan.agni.pro.monthly',
                                       purchase, expires, trial = false, environment = 'Production',
                                       revoked = null } = {}) {
  await rpc('agni_subscription_upsert', {
    p_original_transaction_id: otid, p_transaction_id: 'T' + Date.now(), p_product_id: product,
    p_environment: environment, p_purchase_date: purchase, p_original_purchase_date: purchase,
    p_expires_date: expires, p_revocation_date: revoked, p_revocation_reason: null,
    p_offer_type: trial ? 1 : null, p_offer_discount_type: trial ? 'FREE_TRIAL' : null, p_is_trial: trial,
    p_grace_expires_date: null, p_auto_renew: true, p_signed_date: new Date().toISOString()
  });
  const subject = (environment === 'Production' ? 'sub:' : 'sbx:') + otid;
  await rpc('agni_link_key', {
    p_key_id: dev.keyId, p_device_subject: 'dev:' + dev.installId,
    p_subscription_subject: subject, p_max_keys: 10
  });
  return subject;
}

export function daysFromNow(days) {
  return new Date(Date.now() + days * 86400_000).toISOString();
}
