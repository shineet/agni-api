// The pure parts of billing: periods, cost, tier, the request allowlist.
//
//   node --test test/billing.test.mjs

import './helpers/no-network.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addMonths, periodFor, costFromUsage, reservationFor, reservationForServerCall, tierFor,
  validateModelRequest, inferFeature, allowances, allowanceRefusal, PRODUCTS, cleanId,
  DEFAULT_ALLOWANCES, imageDimensions, imageTokenBound, budgetTierFor
} from '../api/_billing.js';
import { readFileSync } from 'node:fs';

const iso = s => new Date(s).toISOString();

// MARK: - Months

test('addMonths clamps to the end of the month and never drifts', () => {
  const anchor = '2027-01-31T10:00:00Z';
  assert.equal(iso(addMonths(anchor, 1)), '2027-02-28T10:00:00.000Z');
  assert.equal(iso(addMonths(anchor, 2)), '2027-03-31T10:00:00.000Z', 'back to the 31st, not stuck on the 28th');
  assert.equal(iso(addMonths(anchor, 3)), '2027-04-30T10:00:00.000Z');
  assert.equal(iso(addMonths('2028-01-31T10:00:00Z', 1)), '2028-02-29T10:00:00.000Z', 'leap year');
  assert.equal(iso(addMonths('2027-11-15T00:00:00Z', 2)), '2028-01-15T00:00:00.000Z', 'year rollover');
  assert.equal(iso(addMonths('2027-08-31T23:59:59Z', 12)), '2028-08-31T23:59:59.000Z');
});

// MARK: - Periods

const annual = (purchase, expires) => ({
  product_id: PRODUCTS.annual, purchase_date: purchase, expires_date: expires, grace_expires_date: null
});
const monthly = (purchase, expires, grace = null) => ({
  product_id: PRODUCTS.monthly, purchase_date: purchase, expires_date: expires, grace_expires_date: grace
});

test('annual: monthly allowance periods anchored on the purchase date, month-ends clamped', () => {
  const sub = annual('2027-01-31T10:00:00Z', '2028-01-31T10:00:00Z');
  let p = periodFor('pro', sub, new Date('2027-02-10T00:00:00Z'));
  assert.equal(iso(p.start), '2027-01-31T10:00:00.000Z');
  assert.equal(iso(p.end), '2027-02-28T10:00:00.000Z');
  p = periodFor('pro', sub, new Date('2027-02-28T10:00:00Z'));
  assert.equal(iso(p.start), '2027-02-28T10:00:00.000Z', 'the boundary instant belongs to the new period');
  assert.equal(iso(p.end), '2027-03-31T10:00:00.000Z');
  p = periodFor('pro', sub, new Date('2027-12-31T12:00:00Z'));
  assert.equal(iso(p.start), '2027-12-31T10:00:00.000Z');
  assert.equal(iso(p.end), '2028-01-31T10:00:00.000Z', 'the last period ends at expiry');
});

test('annual: twelve distinct periods in a year, contiguous, no gaps', () => {
  const sub = annual('2027-03-31T08:00:00Z', '2028-03-31T08:00:00Z');
  const starts = new Set();
  let cursor = new Date('2027-03-31T08:00:00Z');
  let previousEnd = null;
  while (cursor < new Date('2028-03-31T08:00:00Z')) {
    const p = periodFor('pro', sub, cursor);
    if (previousEnd) assert.equal(iso(p.start), iso(previousEnd));
    starts.add(iso(p.start));
    previousEnd = p.end;
    cursor = new Date(p.end);
  }
  assert.equal(starts.size, 12);
});

test('monthly: the billing month is the period; a renewal starts a new one', () => {
  const first = periodFor('pro', monthly('2027-05-03T00:00:00Z', '2027-06-03T00:00:00Z'), new Date('2027-05-20T00:00:00Z'));
  const renewed = periodFor('pro', monthly('2027-06-03T00:00:00Z', '2027-07-03T00:00:00Z'), new Date('2027-06-04T00:00:00Z'));
  assert.notEqual(iso(first.start), iso(renewed.start));
  assert.equal(iso(renewed.end), '2027-07-03T00:00:00.000Z');
});

test('trial: the trial is one period; the first paid transaction starts the next', () => {
  const trial = periodFor('trial', monthly('2027-05-01T00:00:00Z', '2027-05-08T00:00:00Z'), new Date('2027-05-03T00:00:00Z'));
  assert.equal(iso(trial.end), '2027-05-08T00:00:00.000Z');
  const paid = periodFor('pro', monthly('2027-05-08T00:00:00Z', '2027-06-08T00:00:00Z'), new Date('2027-05-08T00:00:01Z'));
  assert.equal(iso(paid.start), iso(trial.end));
});

test('crossgrade monthly to annual takes effect at renewal: the annual term starts where the month ended', () => {
  // Both plans share one level, so Apple applies the switch at the next
  // renewal as a new transaction purchased at the old expiry.
  const month = periodFor('pro', monthly('2027-05-03T00:00:00Z', '2027-06-03T00:00:00Z'), new Date('2027-05-20T00:00:00Z'));
  const year = periodFor('pro', annual('2027-06-03T00:00:00Z', '2028-06-03T00:00:00Z'), new Date('2027-06-03T01:00:00Z'));
  assert.equal(iso(year.start), iso(month.end), 'contiguous: no overlap, no gap');
  assert.equal(iso(year.end), '2027-07-03T00:00:00.000Z', 'then monthly sub-periods');
});

test('crossgrade annual to monthly at renewal: the first month starts at the annual expiry', () => {
  const lastMonth = periodFor('pro', annual('2027-06-03T00:00:00Z', '2028-06-03T00:00:00Z'), new Date('2028-05-20T00:00:00Z'));
  const month = periodFor('pro', monthly('2028-06-03T00:00:00Z', '2028-07-03T00:00:00Z'), new Date('2028-06-04T00:00:00Z'));
  assert.equal(iso(lastMonth.end), '2028-06-03T00:00:00.000Z');
  assert.equal(iso(month.start), iso(lastMonth.end));
});

test('a renewal charged a day early does not move the period', () => {
  // Apple may charge up to 24 hours before expiry; the term is still the
  // month ending at the new expiry.
  const renewed = periodFor('pro', monthly('2027-06-02T03:00:00Z', '2027-07-03T00:00:00Z'), new Date('2027-06-03T05:00:00Z'));
  assert.equal(iso(renewed.start), '2027-06-03T00:00:00.000Z');
});

test('billing recovered inside grace keeps the original renewal date: the next month is not shortened', () => {
  const recovered = periodFor('pro', monthly('2027-06-07T00:00:00Z', '2027-07-03T00:00:00Z'), new Date('2027-06-08T00:00:00Z'));
  assert.equal(iso(recovered.start), '2027-06-07T00:00:00.000Z', 'starts at the recovery, ends on the usual date');
  assert.equal(iso(recovered.end), '2027-07-03T00:00:00.000Z');
});

test('Sandbox five-minute renewals each start at their purchase (SQL then carries usage forward)', () => {
  const p = periodFor('pro', monthly('2027-06-03T00:00:00Z', '2027-06-03T00:05:00Z'), new Date('2027-06-03T00:01:00Z'));
  assert.equal(iso(p.start), '2027-06-03T00:00:00.000Z');
  assert.equal(iso(p.end), '2027-06-03T00:05:00.000Z');
});

test('billing grace continues the current period to the end of grace', () => {
  const p = periodFor('pro', monthly('2027-05-03T00:00:00Z', '2027-06-03T00:00:00Z', '2027-06-19T00:00:00Z'),
                      new Date('2027-06-10T00:00:00Z'));
  assert.equal(iso(p.start), '2027-05-03T00:00:00.000Z');
  assert.equal(iso(p.end), '2027-06-19T00:00:00.000Z');
});

test('Free is one lifetime period that never resets', () => {
  const p = periodFor('free', null);
  assert.equal(new Date(p.start).getTime(), 0);
  assert.equal(p.end, 'infinity');
});

// MARK: - Tier

const active = { subscription_subject: 'sub:1', product_id: PRODUCTS.monthly, environment: 'Production',
                 expires_date: '2099-01-01T00:00:00Z', revocation_date: null, is_trial: false };

test('tier comes only from verified state', () => {
  assert.equal(tierFor(active, { enforced: true }), 'pro');
  assert.equal(tierFor({ ...active, is_trial: true }, { enforced: true }), 'trial');
  assert.equal(tierFor({ ...active, revocation_date: '2026-01-01T00:00:00Z' }, { enforced: true }), 'free', 'refund or revoke');
  assert.equal(tierFor({ ...active, expires_date: '2020-01-01T00:00:00Z' }, { enforced: true }), 'free', 'expired');
  assert.equal(tierFor({ ...active, expires_date: '2020-01-01T00:00:00Z', grace_expires_date: '2099-01-01T00:00:00Z' },
                       { enforced: true }), 'pro', 'billing grace');
  assert.equal(tierFor({ ...active, product_id: 'com.other.app.pro' }, { enforced: true }), 'free');
  assert.equal(tierFor({ ...active, environment: 'Sandbox' }, { enforced: true, allowSandbox: false }), 'free');
  assert.equal(tierFor({ ...active, environment: 'Sandbox' }, { enforced: true, allowSandbox: true }), 'pro');
  assert.equal(tierFor({ ...active, environment: 'Xcode' }, { enforced: true, allowSandbox: true }), 'free');
  assert.equal(tierFor({ device_subject: 'dev:x' }, { enforced: true }), 'free');
  assert.equal(tierFor(active, { enforced: false }), 'beta', 'before launch everyone is beta');
});

// MARK: - Cost

test('cost from usage: input, output (incl. thinking), cache reads and writes, web searches', () => {
  assert.equal(costFromUsage('claude-sonnet-5', { input_tokens: 1_000_000, output_tokens: 0 }), 2);
  assert.equal(costFromUsage('claude-sonnet-5', { input_tokens: 0, output_tokens: 1_000_000 }), 10);
  assert.equal(costFromUsage('claude-haiku-4-5-20251001', { input_tokens: 1_000_000, output_tokens: 1_000_000 }), 6);
  assert.ok(Math.abs(costFromUsage('claude-sonnet-5', { cache_read_input_tokens: 1_000_000 }) - 0.2) < 1e-9);
  assert.ok(Math.abs(costFromUsage('claude-sonnet-5', { cache_creation_input_tokens: 1_000_000 }) - 2.5) < 1e-9);
  assert.ok(Math.abs(costFromUsage('claude-sonnet-5', {
    cache_creation_input_tokens: 2_000_000,
    cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 1_000_000 }
  }) - (2.5 + 4)) < 1e-9, 'the split wins over the total');
  assert.equal(costFromUsage('claude-haiku-4-5', { server_tool_use: { web_search_requests: 3 } }), 0.03);
  assert.equal(costFromUsage('some-new-model', { input_tokens: 1_000_000 }), 2, 'unknown models at the dearest rate');
  assert.equal(costFromUsage('claude-sonnet-5', null), 0);
  assert.equal(costFromUsage('claude-sonnet-5', { input_tokens: -5, output_tokens: 'x' }), 0);
});

// THE WORST A PROVIDER CAN BILL for an allowlisted request: every UTF-8 byte
// a token (no token is shorter than a byte), the model's image ceiling unless
// the dimensions are known, every output token used, plus framing.
function worstCase(request) {
  const bytes = t => Buffer.byteLength(String(t ?? ''), 'utf8');
  let input = bytes(request.system) + bytes(JSON.stringify(request.output_config || '')) + 400;
  for (const block of request.messages[0].content) {
    if (block.type === 'text') input += bytes(block.text);
    if (block.type === 'image') input += imageTokenBound(request.model, block.source.data);
  }
  return costFromUsage(request.model, { input_tokens: input, output_tokens: request.max_tokens });
}

const hostileTexts = {
  ascii: n => 's'.repeat(n),
  punctuation: n => '}{]['.repeat(n / 4),
  cjk: n => '\u9f98'.repeat(n),              // 3 UTF-8 bytes each
  emoji: n => '\u{1F525}'.repeat(n / 2),      // 4 bytes, 2 UTF-16 units each
  mixed: n => Array.from({ length: n }, (_, i) => String.fromCodePoint(0x4e00 + ((i * 7919) % 20000))).join('')
};

test('a reservation is never beaten by the most a provider can bill, on hostile inputs', () => {
  for (const [name, make] of Object.entries(hostileTexts)) {
    for (const model of ['claude-sonnet-5', 'claude-haiku-4-5']) {
      const request = {
        model, max_tokens: 4096, system: make(32_000).slice(0, 32_000),
        output_config: { format: { type: 'json_schema', schema: { x: make(30_000).slice(0, 30_000) } } },
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'a'.repeat(1_000_000) } },
          { type: 'text', text: make(12_000).slice(0, 12_000) }] }]
      };
      assert.equal(validateModelRequest('photo', request) === null || model !== 'claude-sonnet-5', true);
      const reserve = reservationFor('photo', request);
      const worst = worstCase(request);
      assert.ok(reserve >= worst, `${name}/${model}: reserved ${reserve} >= worst ${worst}`);
    }
  }
});

test('THE OLD BOUND under-reserved: 2.5 characters a token is beaten by CJK text', () => {
  const text = hostileTexts.cjk(12_000);
  const request = { model: 'claude-sonnet-5', max_tokens: 1, system: hostileTexts.cjk(32_000),
    messages: [{ role: 'user', content: [{ type: 'text', text }] }] };
  const old = Math.ceil((32_000 + 12_000) / 2.5) * (2 / 1e6);
  assert.ok(worstCase(request) > old * 5, 'the old figure was beaten five times over');
  assert.ok(reservationFor('variant_search', request) >= worstCase(request));
});

test('the app\'s real photo reserves about ten cents, so a refusal comes at most that far before the ceiling', () => {
  // VisionPrompt-sized: ~17k system, ~1k text, ~5k schema, a 1568x1176 JPEG.
  const request = { model: 'claude-sonnet-5', max_tokens: 4096, system: 's'.repeat(17_000),
    output_config: { format: { type: 'json_schema', schema: { x: 'y'.repeat(5_000) } } },
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpegHeader(1568, 1176) } },
      { type: 'text', text: 't'.repeat(1_000) }] }] };
  const reserve = reservationFor('photo', request);
  assert.ok(reserve > 0.08 && reserve < 0.11, `photo reservation ${reserve}`);
});

test('web search reservations follow the tool loop, base re-read at every step', () => {
  const one = reservationForServerCall({ model: 'claude-haiku-4-5', system: 'x'.repeat(3000), user: 'idli', maxTokens: 2500, maxSearches: 1 });
  const three = reservationForServerCall({ model: 'claude-haiku-4-5', system: 'x'.repeat(3000), user: 'idli', maxTokens: 2500, maxSearches: 3 });
  // 3 searches: results 20k*(1+2+3) = 120k, base x4, three searches at a cent.
  assert.ok(three > one * 3, `${three} vs ${one}`);
  assert.ok(three >= 0.15, `three-search reservation ${three}`);
});

// MARK: - Images

function jpegHeader(width, height) {
  // SOI, an APP0 segment, then SOF0 with the given size.
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 3,
                           1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(64)]).toString('base64');
}
function pngHeader(width, height) {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(b);
  b.write('IHDR', 12, 'latin1'); b.writeUInt32BE(width, 16); b.writeUInt32BE(height, 20);
  return b.toString('base64');
}

test('image dimensions are read from JPEG and PNG headers, and a real iPhone JPEG', () => {
  assert.deepEqual(imageDimensions(jpegHeader(1568, 1176)), { width: 1568, height: 1176 });
  assert.deepEqual(imageDimensions(pngHeader(512, 384)), { width: 512, height: 384 });
  assert.equal(imageDimensions('not an image'), null);
  const real = process.env.AGNI_REAL_JPEG;
  if (real) {
    const size = imageDimensions(readFileSync(real).toString('base64'));
    assert.ok(size && size.width > 0 && size.height > 0, `real JPEG read as ${JSON.stringify(size)}`);
  }
});

test('an image larger than the app sends is refused; one whose size is unreadable is charged the ceiling', () => {
  const with_ = data => ({ model: 'claude-sonnet-5', max_tokens: 4096, system: 's',
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } },
                                         { type: 'text', text: 't' }] }] });
  assert.equal(validateModelRequest('photo', with_(jpegHeader(1568, 1176))), null);
  assert.match(validateModelRequest('photo', with_(jpegHeader(4032, 3024))), /larger than Agni sends/);
  const check = { ...with_(pngHeader(1568, 1568)), model: 'claude-haiku-4-5' };
  assert.match(validateModelRequest('drink_check', check), /larger than Agni sends/);
  assert.equal(imageTokenBound('claude-sonnet-5', jpegHeader(1568, 1176)), Math.ceil(1568 * 1176 / 750) + 85);
  assert.equal(imageTokenBound('claude-sonnet-5', 'garbage'), 4_784);
});

test('an old build\'s small-but-full-size Haiku image is an identification, not a refused routing check', () => {
  const request = { model: 'claude-haiku-4-5-20251001', max_tokens: 4096, system: 's',
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpegHeader(1568, 1176) } },
      { type: 'text', text: 't' }] }] };
  assert.equal(inferFeature(request), 'drink_id');
  assert.equal(validateModelRequest('drink_id', request), null);
});

// MARK: - Allowances

test('the provisional allowances are what was specified', () => {
  assert.deepEqual(
    { photo: DEFAULT_ALLOWANCES.free.photo, search: DEFAULT_ALLOWANCES.free.search },
    { photo: 3, search: 10 });
  assert.deepEqual(
    { photo: DEFAULT_ALLOWANCES.trial.photo, search: DEFAULT_ALLOWANCES.trial.search,
      web: DEFAULT_ALLOWANCES.trial.web, cost: DEFAULT_ALLOWANCES.trial.costCapUSD },
    { photo: 25, search: 25, web: 3, cost: 2.0 });
  assert.deepEqual(
    { photo: DEFAULT_ALLOWANCES.pro.photo, search: DEFAULT_ALLOWANCES.pro.search,
      web: DEFAULT_ALLOWANCES.pro.web, burst: DEFAULT_ALLOWANCES.pro.burst, cost: DEFAULT_ALLOWANCES.pro.costCapUSD },
    { photo: 100, search: 60, web: 5, burst: 25, cost: 6.5 });
  assert.equal(DEFAULT_ALLOWANCES.free.costCapUSD, 0.75);
});

test('ALLOWANCES_JSON overrides without a deploy, and bad JSON keeps the defaults', () => {
  process.env.ALLOWANCES_JSON = '{"pro":{"photo":120}}';
  assert.equal(allowances().pro.photo, 120);
  assert.equal(allowances().pro.search, 60);
  process.env.ALLOWANCES_JSON = '{not json';
  assert.equal(allowances().pro.photo, 100);
  delete process.env.ALLOWANCES_JSON;
});

test('refusals: exhaustion, outage and burst read differently and all name the fallback', () => {
  const exhausted = allowanceRefusal({ reason: 'allowance', used: 100, retry_after: 86400 }, { tier: 'pro', bucket: 'photo', limit: 100 });
  assert.equal(exhausted.status, 402);
  assert.equal(exhausted.type, 'allowanceExhausted');
  assert.ok(exhausted.resetsAt);
  const paused = allowanceRefusal({ reason: 'degraded', retry_after: 100 }, { tier: 'free', bucket: 'photo' });
  assert.equal(paused.status, 503);
  assert.equal(paused.type, 'aiPaused');
  const burst = allowanceRefusal({ reason: 'burst', retry_after: 100 }, { tier: 'pro', bucket: 'photo' });
  assert.equal(burst.type, 'usageLimitReached');
  for (const r of [exhausted, paused, burst]) assert.match(r.message, /still work/);
  const free = allowanceRefusal({ reason: 'allowance', retry_after: 0 }, { tier: 'free', bucket: 'photo', limit: 3 });
  assert.equal(free.resetsAt, null, 'the Free sample has no reset date');
});

// MARK: - Allowlist

test('inferFeature for builds that do not say', () => {
  const img = data => [{ type: 'image', source: { data } }, { type: 'text', text: 'x' }];
  assert.equal(inferFeature({ model: 'claude-sonnet-5', messages: [{ content: img('a'.repeat(300_000)) }] }), 'photo');
  assert.equal(inferFeature({ model: 'claude-haiku-4-5-20251001', messages: [{ content: img('a'.repeat(40_000)) }] }), 'drink_check');
  assert.equal(inferFeature({ model: 'claude-haiku-4-5-20251001', messages: [{ content: img('a'.repeat(300_000)) }] }), 'drink_id');
  assert.equal(inferFeature({ model: 'claude-sonnet-5', messages: [{ content: [{ type: 'text', text: 'x' }] }] }), 'breakdown');
  assert.equal(inferFeature({ model: 'claude-haiku-4-5-20251001', messages: [{ content: [{ type: 'text', text: 'x' }] }] }), 'variant_search');
});

test('the allowlist accepts the app shape and rejects a server-built feature through the proxy', () => {
  const ok = { model: 'claude-haiku-4-5-20251001', max_tokens: 4096, system: 'x',
               output_config: { format: { type: 'json_schema', schema: {} } },
               messages: [{ role: 'user', content: [{ type: 'text', text: 'idli' }] }] };
  assert.equal(validateModelRequest('variant_search', ok), null);
  assert.match(validateModelRequest('ingredient', ok), /not allowed/);
  assert.match(validateModelRequest('research', ok), /not allowed/);
  assert.match(validateModelRequest('variant_search', { ...ok, max_tokens: 4096.5 }), /whole number/);
  assert.match(validateModelRequest('variant_search', { ...ok, stream: true }), /stream is not allowed/);
  assert.match(validateModelRequest('variant_search', { ...ok, output_config: { format: { type: 'json_schema', schema: {} }, effort: 'max' } }), /only carry a format/);
  assert.match(validateModelRequest('variant_search', { ...ok, system: [{ type: 'text', text: 'x', cache_control: {} }] }), /system must be a string/);
  // The meal photo alone streams, at low effort, and may run to 8192 tokens.
  const photo = { model: 'claude-sonnet-5', max_tokens: 8000, system: 'x', stream: true,
                  output_config: { effort: 'low', format: { type: 'json_schema', schema: {} } },
                  messages: [{ role: 'user', content: [{ type: 'text', text: 'plate' }] }] };
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpegHeader(1568, 1176) } };
  const withImage = (r) => ({ ...r, messages: [{ role: 'user', content: [r.messages[0].content[0], image] }] });
  assert.equal(validateModelRequest('photo', withImage(photo)), null);
  assert.match(validateModelRequest('photo', withImage({ ...photo, stream: false })), /1 to 4096/);
  assert.match(validateModelRequest('photo', withImage({ ...photo, max_tokens: 8193 })), /1 to 8192/);
  assert.match(validateModelRequest('photo', withImage({ ...photo, stream: 'yes' })), /true or false/);
  assert.match(validateModelRequest('photo', withImage({ ...photo, output_config: { effort: 'max', format: photo.output_config.format } })), /effort is not allowed/);
});

test('ids from the client are used only when they look like ids', () => {
  assert.equal(cleanId('3F2A9C1E-1111-4444-8888-ABCDEFABCDEF'), '3F2A9C1E-1111-4444-8888-ABCDEFABCDEF');
  assert.equal(cleanId("x'; drop table agni_subjects; --"), null);
  assert.equal(cleanId('short'), null);
  assert.equal(cleanId('a'.repeat(200)), null);
  assert.equal(cleanId(undefined), null);
});
