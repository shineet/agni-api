// Requests that arrive together. Every psql call in the harness is its own
// database connection, so these genuinely race inside Postgres.
//
//   AGNI_TEST_PG=postgresql://postgres@127.0.0.1:55432/postgres node --test test/billing-concurrency.test.mjs

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as h from './helpers/harness.mjs';

const skip = !h.enabled && 'AGNI_TEST_PG not set';
let estimateHandler;

before(async () => {
  if (skip) return;
  h.setTestEnv();
  h.freshDatabase('race');
  h.installFetch();
  estimateHandler = (await import('../api/estimate.js')).default;
});
after(() => { if (skip) return; h.restoreFetch(); h.dropDatabase(); });
beforeEach(() => { if (skip) return; h.anthropic.reset(); h.setTestEnv(); });

const photo = () => h.modelRequest({ image: h.PHOTO_B64 });
let n = 0;
const id = p => `${p}-${Date.now()}-${(n += 1)}`;

test('twelve photos at once against a three-photo sample: exactly three are analysed', { skip }, async () => {
  const dev = await h.device();
  // Provider answers slowly, so every request is in flight together.
  h.anthropic.fallback = { status: 200, delayMs: 300, usage: { input_tokens: 3000, output_tokens: 600 } };
  try {
    const results = await Promise.all(Array.from({ length: 12 }, () =>
      h.estimate(estimateHandler, dev, { feature: 'photo', actionId: id('a'), requestId: id('r'), request: photo() })));
    const ok = results.filter(r => r.statusCode === 200).length;
    const refused = results.filter(r => r.statusCode === 402).length;
    assert.equal(ok, 3, results.map(r => r.statusCode).join(','));
    assert.equal(refused, 9);
    assert.equal(h.anthropic.calls.length, 3, 'nine never reached the provider');
    const [p] = await h.sqlJSON(`select photo_used, open_reservations from agni_allowance_periods where subject_id = 'dev:${dev.installId}'`);
    assert.deepEqual(p, { photo_used: 3, open_reservations: 0 });
  } finally {
    h.anthropic.fallback = { status: 200, usage: { input_tokens: 3000, output_tokens: 600 } };
  }
});

test('the cost cap holds under a burst: committed cost never passes it', { skip }, async () => {
  const dev = await h.device();
  const subject = await h.subscribe(dev, { purchase: h.daysFromNow(-1), expires: h.daysFromNow(29) });
  // $0.30 of the $2.50 left: room for a handful of conservative reservations.
  await h.estimate(estimateHandler, dev, { feature: 'photo', actionId: id('a'), requestId: id('r'), request: photo() });
  await h.sql(`update agni_allowance_periods set cost_usd = 2.20 where subject_id = '${subject}'`);
  h.anthropic.fallback = { status: 200, delayMs: 300, usage: { input_tokens: 3000, output_tokens: 600 } };
  try {
    const results = await Promise.all(Array.from({ length: 15 }, () =>
      h.estimate(estimateHandler, dev, { feature: 'photo', actionId: id('a'), requestId: id('r'), request: photo() })));
    const ok = results.filter(r => r.statusCode === 200).length;
    assert.ok(ok >= 1 && ok < 15, `some allowed, the rest refused: ${ok}`);
    const peak = await h.sqlJSON(`select max(running)::float as peak from (
        select sum(reserved_usd) over (order by created_at) as running
          from agni_usage_events where subject_id = '${subject}' and created_at > now() - interval '1 minute') t`);
    assert.ok(2.20 + peak[0].peak - 0.0 <= 2.50 + 0.05 * 15, 'sanity');
    const [p] = await h.sqlJSON(`select cost_usd::float, open_reservations from agni_allowance_periods where subject_id = '${subject}'`);
    assert.ok(p.cost_usd <= 2.50, `committed ${p.cost_usd} stays within $2.50`);
    assert.equal(p.open_reservations, 0);
  } finally {
    h.anthropic.fallback = { status: 200, usage: { input_tokens: 3000, output_tokens: 600 } };
  }
});

test('the same request id sent five times at once is answered once', { skip }, async () => {
  const dev = await h.device();
  const requestId = id('same');
  h.anthropic.fallback = { status: 200, delayMs: 200, usage: { input_tokens: 3000, output_tokens: 600 } };
  try {
    const results = await Promise.all(Array.from({ length: 5 }, () =>
      h.estimate(estimateHandler, dev, { feature: 'photo', actionId: id('a'), requestId, request: photo() })));
    assert.equal(results.filter(r => r.statusCode === 200).length, 1);
    assert.equal(results.filter(r => r.statusCode === 409).length, 4);
    assert.equal(h.anthropic.calls.length, 1);
  } finally {
    h.anthropic.fallback = { status: 200, usage: { input_tokens: 3000, output_tokens: 600 } };
  }
});

test('one action retried in parallel is still one credit', { skip }, async () => {
  const dev = await h.device();
  const action = id('one-tap');
  h.anthropic.fallback = { status: 200, delayMs: 200, usage: { input_tokens: 3000, output_tokens: 600 } };
  try {
    await Promise.all(Array.from({ length: 3 }, () =>
      h.estimate(estimateHandler, dev, { feature: 'photo', actionId: action, requestId: id('r'), request: photo() })));
    const [p] = await h.sqlJSON(`select photo_used from agni_allowance_periods where subject_id = 'dev:${dev.installId}'`);
    assert.equal(p.photo_used, 1);
  } finally {
    h.anthropic.fallback = { status: 200, usage: { input_tokens: 3000, output_tokens: 600 } };
  }
});

test('when the credit-holding call fails and a sibling succeeds, the person is charged once', { skip }, async () => {
  const dev = await h.device();
  const action = id('sibling');
  h.anthropic.next({ status: 500, delayMs: 50, body: { type: 'error' } },
                   { status: 200, delayMs: 300, usage: { input_tokens: 3000, output_tokens: 600 } });
  await Promise.all([
    h.estimate(estimateHandler, dev, { feature: 'photo', actionId: action, requestId: id('r'), request: photo() }),
    h.estimate(estimateHandler, dev, { feature: 'photo', actionId: action, requestId: id('r'), request: photo() })
  ]);
  const [p] = await h.sqlJSON(`select photo_used from agni_allowance_periods where subject_id = 'dev:${dev.installId}'`);
  assert.equal(p.photo_used, 1, 'the surviving call inherited the credit');
});

test('many people at once do not deadlock on the shared budget row', { skip }, async () => {
  const devices = await Promise.all(Array.from({ length: 10 }, () => h.device()));
  h.anthropic.fallback = { status: 200, delayMs: 50, usage: { input_tokens: 3000, output_tokens: 600 } };
  try {
    const results = await Promise.all(devices.flatMap(dev => [0, 1].map(() =>
      h.estimate(estimateHandler, dev, { feature: 'photo', actionId: id('a'), requestId: id('r'), request: photo() }))));
    assert.equal(results.filter(r => r.statusCode === 200).length, 20);
    const today = await h.sql(`select (now() at time zone 'utc')::date`);
    const [b] = await h.sqlJSON(`select free_usd::float from agni_budget_days where day = '${today}'`);
    const [sum] = await h.sqlJSON(`select sum(actual_usd)::float as s from agni_usage_events where tier = 'free' and day = '${today}'`);
    assert.equal(Number(b.free_usd.toFixed(6)), Number(sum.s.toFixed(6)), 'the day total is the sum of the ledger');
  } finally {
    h.anthropic.fallback = { status: 200, usage: { input_tokens: 3000, output_tokens: 600 } };
  }
});
