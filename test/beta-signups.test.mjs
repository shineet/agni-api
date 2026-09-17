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
