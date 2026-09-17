import test from 'node:test';
import assert from 'node:assert/strict';

import handler, { sameSecret, presentedToken } from '../api/beta-signups.js';

/// The only thing worth testing here is the door. The list behind it is a
/// select; the door is what stands between a URL and every tester's address.

function fakeRes() {
  const res = {
    statusCode: null, headers: {}, body: null,
    status(code) { res.statusCode = code; return res; },
    setHeader(k, v) { res.headers[k.toLowerCase()] = v; return res; },
    send(payload) { res.body = payload; return res; }
  };
  return res;
}

const req = (headers = {}, method = 'GET') => ({ method, headers });

test('sameSecret accepts only the exact value', () => {
  assert.equal(sameSecret('abc123', 'abc123'), true);
  assert.equal(sameSecret('abc124', 'abc123'), false);
  // The length guard exists because timingSafeEqual throws rather than
  // returning false. A prefix must be refused, not crash the function.
  assert.equal(sameSecret('abc', 'abc123'), false);
  assert.equal(sameSecret('abc1234', 'abc123'), false);
  assert.equal(sameSecret('', 'abc123'), false);
});

test('presentedToken reads the header and the Basic password', () => {
  assert.equal(presentedToken(req({ 'x-admin-token': 'tok' })), 'tok');

  const basic = 'Basic ' + Buffer.from('anyone:tok').toString('base64');
  assert.equal(presentedToken(req({ authorization: basic })), 'tok');

  // A password containing a colon must survive. Splitting on every colon
  // instead of the first would silently truncate a generated token.
  const colons = 'Basic ' + Buffer.from('x:a:b:c').toString('base64');
  assert.equal(presentedToken(req({ authorization: colons })), 'a:b:c');

  assert.equal(presentedToken(req({})), null);
  assert.equal(presentedToken(req({ authorization: 'Bearer tok' })), null);
});

test('no token set means the view is off, not open', async () => {
  delete process.env.BETA_ADMIN_TOKEN;
  const res = fakeRes();
  await handler(req({ 'x-admin-token': 'anything' }), res);
  assert.equal(res.statusCode, 503);
});

test('a wrong token is refused and the browser is challenged', async () => {
  process.env.BETA_ADMIN_TOKEN = 'correct-horse';
  const res = fakeRes();
  await handler(req({ 'x-admin-token': 'wrong-horse' }), res);
  assert.equal(res.statusCode, 401);
  assert.match(res.headers['www-authenticate'], /^Basic realm=/);
});

test('no credentials at all is challenged, never served', async () => {
  process.env.BETA_ADMIN_TOKEN = 'correct-horse';
  const res = fakeRes();
  await handler(req({}), res);
  assert.equal(res.statusCode, 401);
  assert.match(res.headers['www-authenticate'], /^Basic realm=/);
});

test('POST is refused before the token is even considered', async () => {
  process.env.BETA_ADMIN_TOKEN = 'correct-horse';
  const res = fakeRes();
  await handler(req({ 'x-admin-token': 'correct-horse' }, 'POST'), res);
  assert.equal(res.statusCode, 405);
});

test('a correct token with no database reachable fails closed, not open', async () => {
  process.env.BETA_ADMIN_TOKEN = 'correct-horse';
  delete process.env.SUPABASE_URL;
  const res = fakeRes();
  await handler(req({ 'x-admin-token': 'correct-horse' }), res);
  assert.equal(res.statusCode, 503);
  assert.doesNotMatch(String(res.body), /correct-horse/);
});

/// The join between the two systems. This is where a wrong answer would be
/// quiet rather than loud: a mismatched key does not throw, it just reports
/// everybody as "not a tester".

import { merge, buildNumber } from '../api/beta-signups.js';

const testers = (byEmail = {}, anonymous = []) =>
  ({ byEmail: new Map(Object.entries(byEmail)), anonymous });

test('buildNumber reads the build, not the marketing version', () => {
  assert.equal(buildNumber('1.0 (138)'), 138);
  assert.equal(buildNumber('2.3.1 (7)'), 7);
  assert.equal(buildNumber(null), null);
  assert.equal(buildNumber('1.0'), null);
});

test('a signup is matched to its tester regardless of case', () => {
  const { rows } = merge(
    [{ name: 'Indu B', email: 'indu@example.com', created_at: '2026-09-16T20:47:00Z', invited: true }],
    testers({ 'indu@example.com': { state: 'INSTALLED', build: '1.0 (138)' } })
  );
  assert.equal(rows[0].state, 'INSTALLED');

  // Apple does not promise to hand the address back lowercased, and Postgres
  // stores it lowered. Keying on the raw string would silently unmatch people.
  const mixed = merge(
    [{ name: 'Indu B', email: 'Indu@Example.com', created_at: '2026-09-16T20:47:00Z', invited: true }],
    testers({ 'indu@example.com': { state: 'INSTALLED', build: '1.0 (138)' } })
  );
  assert.equal(mixed.rows[0].state, 'INSTALLED');
});

test('a signup with no tester stays visible and says so', () => {
  const { rows } = merge(
    [{ name: 'Lost Person', email: 'lost@example.com', created_at: '2026-09-16T20:47:00Z', invited: false }],
    testers()
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, null);
  assert.equal(rows[0].invited, false);
});

test('testers who never used the form are listed separately, not dropped', () => {
  const { rows, others } = merge(
    [{ name: 'Indu B', email: 'indu@example.com', created_at: '2026-09-16T20:47:00Z', invited: true }],
    testers(
      { 'indu@example.com': { state: 'INSTALLED', build: '1.0 (138)' },
        'kavitha@example.com': { state: 'INSTALLED', build: '1.0 (138)', name: 'Kavitha Nair' } },
      [{ state: 'INSTALLED', build: '1.0 (101)', inviteType: 'PUBLIC_LINK', name: 'Anonymous' }]
    )
  );
  assert.equal(rows.length, 1);
  assert.equal(others.length, 2);
  // The anonymous one is the whole reason this section exists: they hold a
  // build and there is no way to reach them.
  const anon = others.find(o => o.email === null);
  assert.equal(anon.build, '1.0 (101)');
});

import { backoffFor } from '../api/beta-signups.js';

test('the backoff grows with attempts and is capped', () => {
  assert.equal(backoffFor(1), 250);
  assert.equal(backoffFor(4), 1000);
  // Capped, because an unbounded wait is a way to hold a function open and
  // bill for it, which is a worse problem than the one being solved.
  assert.equal(backoffFor(100), 4000);
});

test('a failed attempt is slowed, a good one is not', async () => {
  process.env.BETA_ADMIN_TOKEN = 'correct-horse';

  const started = Date.now();
  const res = fakeRes();
  await handler(req({ 'x-admin-token': 'nope', 'x-forwarded-for': '203.0.113.9' }), res);
  assert.equal(res.statusCode, 401);
  // The FIRST wrong guess already waits. Counting before the pause rather than
  // after is what makes that true.
  assert.ok(Date.now() - started >= 200, 'first failure was not slowed');
});
