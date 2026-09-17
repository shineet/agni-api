import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalRequest, MeterClass, AuthPath } from '../api/_auth.js';

/// The canonical request string, which is what an assertion is bound to.
///
/// This matters more than it looks. It used to bind the BODY, which is worth
/// nothing on a GET: /api/dishes?q=pizza and ?q=beer have identical empty
/// bodies, so one captured assertion would have worked for every query anybody
/// ever made. These checks are the proof that no longer holds.

test('two different GET queries produce different bound strings', () => {
  const a = canonicalRequest('GET', '/api/dishes', { q: 'pizza' }, '');
  const b = canonicalRequest('GET', '/api/dishes', { q: 'beer' }, '');
  assert.notEqual(a, b);
});

test('the same query produces the same string, whatever the parameter order', () => {
  const a = canonicalRequest('GET', '/api/dishes', { q: 'pizza', install: 'x' }, '');
  const b = canonicalRequest('GET', '/api/dishes', { install: 'x', q: 'pizza' }, '');
  assert.equal(a, b);
});

test('method is bound, so a GET assertion cannot be replayed as a POST', () => {
  assert.notEqual(
    canonicalRequest('GET', '/api/dishes', { q: 'pizza' }, ''),
    canonicalRequest('POST', '/api/dishes', { q: 'pizza' }, '')
  );
});

test('path is bound, so an assertion cannot move between endpoints', () => {
  assert.notEqual(
    canonicalRequest('GET', '/api/dishes', { q: 'pizza' }, ''),
    canonicalRequest('GET', '/api/variants', { q: 'pizza' }, '')
  );
});

test('the body is still bound for a POST', () => {
  assert.notEqual(
    canonicalRequest('POST', '/api/misses', {}, '{"misses":[1]}'),
    canonicalRequest('POST', '/api/misses', {}, '{"misses":[2]}')
  );
});

test('an empty body hashes rather than being skipped', () => {
  const s = canonicalRequest('GET', '/api/quota', {}, '');
  assert.equal(s.split('\n').length, 4);
  // The SHA256 of the empty string, so the field is never absent.
  assert.match(s.split('\n')[3], /^e3b0c44298fc1c149afbf4c8996fb924/);
});

test('an array query value is flattened rather than stringified as an object', () => {
  const s = canonicalRequest('GET', '/api/dishes', { q: ['a', 'b'] }, '');
  assert.ok(s.includes('q=a,b'));
});

test('the three metering classes exist and are distinct', () => {
  const values = new Set([MeterClass.ai, MeterClass.read, MeterClass.research]);
  assert.equal(values.size, 3);
});

test('every auth path has a name, including refusal', () => {
  assert.equal(AuthPath.attested, 'attested');
  assert.equal(AuthPath.legacy, 'legacy');
  assert.equal(AuthPath.refused, 'refused');
  assert.equal(AuthPath.development, 'development');
});
