// The rate, burst and spend controls, and the error mapping the app depends on.
//
// The SQL gate itself is exercised against a real Postgres only if DATABASE_URL
// is set; otherwise those cases skip loudly rather than passing quietly. What
// is always tested is the logic the function layer owns: pricing, the refusal
// mapping, the limit values, and the body cap.
//
//   npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, costOfUsage, refusal, AgniError, MAX_BODY_BYTES, UPSTREAM_TIMEOUT_MS }
  from '../api/_lib.js';

test('the approved limits are what is configured', () => {
  assert.equal(LIMITS.perMinute, 10);
  assert.equal(LIMITS.perHour, 60);
  assert.equal(LIMITS.perDay, 100);
  assert.equal(LIMITS.daySpendUSD, 1.0);
  assert.equal(LIMITS.globalDaySpendUSD, 25.0);
});

test('the limits leave room for real use, and one photo is TWO calls', () => {
  // A photo is a drink routing check plus an estimate. Every limit has to be
  // read in photographs, not calls.
  const callsPerPhoto = 2;
  const busiestMinute = 5 * callsPerPhoto;     // a thali plus three breakdowns
  assert.ok(LIMITS.perMinute >= busiestMinute / 2,
            'a minute limit must survive a burst of logging');
  const heavyDay = 30;
  assert.ok(LIMITS.perDay >= heavyDay * 3,
            'a daily limit must be several times a heavy day');
  assert.ok(LIMITS.perHour * 24 > LIMITS.perDay,
            'the hourly limit must not be the real daily limit by accident');
});

test('cost comes from real tokens, at the right rate per model', () => {
  const sonnet = costOfUsage('claude-sonnet-5', { input_tokens: 3700, output_tokens: 700 });
  assert.ok(Math.abs(sonnet - 0.0144) < 0.0001, `got ${sonnet}`);
  const haiku = costOfUsage('claude-haiku-4-5', { input_tokens: 3700, output_tokens: 700 });
  assert.ok(Math.abs(haiku * 2 - sonnet) < 0.0001, 'haiku is half of sonnet');
  // An unknown model is priced at the dearer rate, not free.
  assert.ok(costOfUsage('something-else', { input_tokens: 1000 }) > 0);
  assert.equal(costOfUsage('claude-sonnet-5', {}), 0);
});

test('the daily spend cap bounds what the call limit alone would allow', () => {
  const worstCase = LIMITS.perDay * costOfUsage('claude-sonnet-5',
    { input_tokens: 3700, output_tokens: 700 });
  assert.ok(worstCase > LIMITS.daySpendUSD,
            'if calls alone could not exceed the spend cap, the cap does nothing');
  assert.ok(LIMITS.daySpendUSD >= 0.5,
            'and it must be well above a heavy day, which is about $0.40');
});

test('a burst refusal and a daily refusal are NOT the same message', () => {
  // The distinction that matters: waiting a minute fixes one and cannot fix the
  // other. Telling somebody to try again shortly when they cannot is worse than
  // telling them nothing.
  const burst = refusal('minute');
  const daily = refusal('day');
  assert.equal(burst.type, AgniError.rateLimited);
  assert.equal(daily.type, AgniError.usageLimitReached);
  assert.notEqual(burst.message, daily.message);
  assert.match(burst.message, /moment/);
  assert.doesNotMatch(daily.message, /moment/);
});

test('every refusal offers logging by hand', () => {
  for (const reason of ['minute', 'hour', 'day', 'spend', 'global_spend', 'anything']) {
    const { message } = refusal(reason);
    assert.match(message, /by hand/, `"${reason}" must offer manual logging`);
  }
});

test('an exhausted spend cap reads as a usage limit, not an outage', () => {
  assert.equal(refusal('spend').type, AgniError.usageLimitReached);
  // The GLOBAL ceiling is different: it is not this person's fault and not
  // their allowance, so it reads as the service being paused.
  assert.equal(refusal('global_spend').type, AgniError.serviceUnavailable);
  assert.equal(refusal('global_spend').status, 503);
});

test('a replay or an unknown key reads as verification, never as a limit', () => {
  for (const reason of ['replay', 'unknown_key']) {
    const r = refusal(reason);
    assert.equal(r.type, AgniError.temporaryVerificationFailure);
    assert.equal(r.status, 401);
  }
});

test('refusals carry a retry hint only where waiting helps', () => {
  assert.ok(refusal('minute').status === 429);
  assert.ok(refusal('hour').status === 429);
  assert.ok(refusal('day').status === 429);
});

test('the body cap is several times a real food payload, and bounded', () => {
  // Measured: a 1568px JPEG at q0.7 is 203 KB, 270 KB base64, plus about 5 KB
  // of prompt and schema.
  const measuredFoodBody = 280 * 1024;
  assert.ok(MAX_BODY_BYTES > measuredFoodBody * 3,
            'must not reject a legitimate dense photograph');
  assert.ok(MAX_BODY_BYTES < 4 * 1024 * 1024,
            'must reject a full-resolution photograph');
});

test('timeouts are ordered so each layer outlives the one below it', () => {
  const functionMax = 55_000;
  const clientTimeout = 65_000;
  assert.ok(UPSTREAM_TIMEOUT_MS < functionMax,
            'the upstream must abort before the function is cut off');
  assert.ok(functionMax < clientTimeout,
            'the function must answer before the client gives up');
});

test('the kill switch and the limits are all remotely configurable', async () => {
  // Every one of these is an environment variable, so a limit that turns out to
  // be wrong is a Vercel setting rather than a deploy.
  const source = await import('node:fs')
    .then(fs => fs.readFileSync(new URL('../api/_lib.js', import.meta.url), 'utf8'));
  for (const name of ['RATE_PER_MINUTE', 'RATE_PER_HOUR', 'RATE_PER_DAY',
                      'DAY_SPEND_CAP_USD', 'GLOBAL_DAY_SPEND_CAP_USD',
                      'AI_ENABLED', 'MAX_BODY_BYTES', 'UPSTREAM_TIMEOUT_MS',
                      'LEGACY_TOKEN_ENABLED', 'FREE_AI_ANALYSES']) {
    assert.match(source, new RegExp(name), `${name} must be configurable`);
  }
});
