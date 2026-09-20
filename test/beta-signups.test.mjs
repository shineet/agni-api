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

import { deviceName } from '../api/_asc.js';

test('a model identifier becomes a phone, and an unknown one stays readable', () => {
  assert.equal(deviceName('iPhone17,2'), 'iPhone 16 Pro Max');
  // Apple returns the comma form; the table is keyed on underscores. Both in.
  assert.equal(deviceName('iPhone18_2'), 'iPhone 17 Pro Max');
  assert.equal(deviceName('iPhone18,1'), 'iPhone 17 Pro');
  // The point of the fallback: an identifier nobody has mapped yet is shown as
  // itself, so it can be looked up. Guessing "iPhone" would send somebody to
  // reproduce a bug on the wrong hardware.
  assert.equal(deviceName('iPhone19,1'), 'iPhone19,1');
  assert.equal(deviceName(null), null);
});

test('sessions and devices survive the join, and absent is not zero', () => {
  const { rows } = merge(
    [{ name: 'Indu B', email: 'indu@example.com', created_at: '2026-09-16T20:47:00Z', invited: true },
     { name: 'Not yet', email: 'waiting@example.com', created_at: '2026-09-16T20:47:00Z', invited: true }],
    testers({ 'indu@example.com': {
      state: 'INSTALLED', build: '1.0 (140)', sessions: 10, crashes: 0,
      devices: [{ model: 'iPhone 17 Pro', os: '26.6' }] } })
  );
  assert.equal(rows[0].sessions, 10);
  assert.equal(rows[0].devices[0].model, 'iPhone 17 Pro');
  // Somebody Apple has never reported on has null, NOT 0. A zero would read as
  // "installed it and never opened it", which is the one case worth chasing.
  assert.equal(rows[1].sessions, null);
  assert.deepEqual(rows[1].devices, []);
});

import crypto from 'node:crypto';
import { listTesters } from '../api/_asc.js';

/// The bug this guards: a try/catch around the usage call caught an ERROR and
/// not SLOWNESS, so a slow App Store Connect hung the whole function past its
/// ceiling and the page 504'd holding a tester list it had already fetched.
// A throwaway P-256 key so token() can sign. Nothing here talks to Apple.
function fakeAscEnv() {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  process.env.ASC_KEY_ID = 'TESTKEY123';
  process.env.ASC_ISSUER_ID = '00000000-0000-0000-0000-000000000000';
  process.env.ASC_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' });
  process.env.ASC_BETA_GROUP_ID = 'g1';
}

function stubAsc({ metrics }) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), signal: init.signal });
    const u = String(url);
    if (u.includes('/app')) return json({ data: { id: '123' } });
    if (u.includes('betaTesters?filter')) return json({ data: [{
      id: 't1', attributes: { email: 'a@example.com', state: 'INSTALLED', firstName: 'A', lastName: 'B',
      appDevices: [{ model: 'iPhone17,2', osVersion: '26.6', appBuildVersion: '140' }] } }] });
    if (u.includes('betaTesterUsages')) return metrics();
    throw new Error('unexpected ' + u);
  };
  return calls;
}
const json = (body) => ({ ok: true, status: 200, json: async () => body });

test('a usage call that dies leaves the page standing, with blank counts', async () => {
  const realFetch = globalThis.fetch;
  fakeAscEnv();
  try {
    stubAsc({ metrics: () => { const e = new Error('The operation was aborted');
                               e.name = 'TimeoutError'; throw e; } });
    const { byEmail } = await listTesters();
    const t = byEmail.get('a@example.com');
    // The tester list survived, which is the whole point.
    assert.equal(t.state, 'INSTALLED');
    assert.equal(t.devices[0].model, 'iPhone 16 Pro Max');
    // And absent counts stay absent rather than becoming zero.
    assert.equal(t.sessions, null);
  } finally { globalThis.fetch = realFetch; }
});

test('every App Store Connect call carries a deadline', async () => {
  const realFetch = globalThis.fetch;
  fakeAscEnv();
  try {
    const calls = stubAsc({ metrics: () => json({ data: [] }) });
    await listTesters();
    assert.ok(calls.length >= 3, `expected 3 calls, saw ${calls.length}`);
    for (const c of calls) {
      // Without this a slow upstream is indistinguishable from a hung one, and
      // the function is killed rather than degrading.
      assert.ok(c.signal, `no timeout on ${c.url}`);
    }
  } finally { globalThis.fetch = realFetch; }
});

test('a lost write does not turn a real invitation red', () => {
  const { rows } = merge(
    [{ name: 'Renjith Nair', email: 'r@example.com', created_at: '2026-09-18T15:20:00Z',
       invited: false },
     { name: 'Nobody Home', email: 'n@example.com', created_at: '2026-09-18T15:20:00Z',
       invited: false }],
    testers({ 'r@example.com': { state: 'INVITED', build: null } })
  );
  // Apple has him as a tester, so he was invited, whatever the row remembers.
  // This is the 18 Sept case: the invite landed and the write recording it was
  // killed with the function.
  assert.equal(rows[0].invited, true);
  // Somebody Apple has never heard of is still a genuine failure.
  assert.equal(rows[1].invited, false);
});

/// A public-link tester has no name and no email. When Shine knows who one is,
/// the page says so -- and says that it is saying so by hand.
test('a hand-written name labels an anonymous tester without claiming Apple knows it', () => {
  const testers = {
    byEmail: new Map(),
    anonymous: [
      { id: 'feaf9e11-a37b-4b2a-adab-a69ea00a6c7d', state: 'INSTALLED',
        build: '1.0 (151)', inviteType: 'PUBLIC_LINK', name: '', devices: [] },
      { id: 'c3b3cbd1-5b6f-492f-bff1-273c626eb718', state: 'INSTALLED',
        build: '1.0 (101)', inviteType: 'PUBLIC_LINK', name: '', devices: [] }
    ]
  };
  const { others } = merge([], testers);
  const named = others.find(t => t.id === 'feaf9e11-a37b-4b2a-adab-a69ea00a6c7d');
  const unnamed = others.find(t => t.id === 'c3b3cbd1-5b6f-492f-bff1-273c626eb718');

  assert.equal(named.knownAs, 'Suresh Bhaskar');
  // The other public-link tester must NOT inherit a label.
  assert.equal(unnamed.knownAs, null);
  // And neither gains an address, because neither has one.
  assert.equal(named.email, null);
});

/// The knowledge is keyed on Apple's tester id, which is the only stable handle
/// a person with no name and no address has. A label keyed on anything else --
/// a build, a device, a position in the list -- would move to somebody else the
/// first time any of those changed.
test('an unknown anonymous tester is left anonymous', () => {
  const { others } = merge([], {
    byEmail: new Map(),
    anonymous: [{ id: 'nobody-knows-this-one', state: 'INSTALLED',
                  build: '1.0 (151)', inviteType: 'PUBLIC_LINK', name: '', devices: [] }]
  });
  assert.equal(others[0].knownAs, null);
});
