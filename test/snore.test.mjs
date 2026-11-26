import './helpers/no-network.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateSnore, SNORE_LIMITS } from '../api/_snore.js';

const began = '2026-11-26T05:54:44Z', ended = '2026-11-26T14:37:52Z';
const marks = { v: 1, base: 1795672484.62, b64: Buffer.from([1, 2, 3, 4, 5, 6]).toString('base64') };

test('snore: a night that is fine is taken', () => {
  assert.equal(validateSnore('put', { began, ended, marks }), null);
  assert.equal(validateSnore('get', { from: began, to: ended }), null);
  assert.equal(validateSnore('compared', { from: began, to: ended }), null);
  assert.equal(validateSnore('pair-join', { code: '012345' }), null);
  for (const a of ['clock', 'pair-start', 'status', 'unpair']) assert.equal(validateSnore(a, {}), null);
});

test('snore: 209 loudness every five minutes is taken, and bounded', () => {
  const levels = { v: 2, start: 1795672484.62, step: 0.75, b64: Buffer.alloc(4800, 7).toString('base64') };
  assert.equal(validateSnore('put', { began, ended, marks: levels }), null);
  assert.ok(validateSnore('put', { began, ended, marks: { ...levels, step: 1 } }));
  assert.ok(validateSnore('put', { began, ended, marks: { ...levels, start: 'soon' } }));
  assert.ok(validateSnore('put', { began, ended, marks: { ...levels, b64: 'A'.repeat(SNORE_LIMITS.levelsB64 + 4) } }));
  // a whole 16 hour night fits: 76,800 steps of a byte
  assert.equal(validateSnore('put', { began, ended, marks: { ...levels, b64: Buffer.alloc(76_800, 1).toString('base64') } }), null);
});

test('snore: what is not a night is refused', () => {
  assert.ok(validateSnore('put', { began: ended, ended: began, marks }));
  assert.ok(validateSnore('put', { began, ended: '2026-11-27T05:54:44Z', marks }), 'longer than 16 hours');
  assert.ok(validateSnore('put', { began, ended, marks: { ...marks, v: 3 } }));
  assert.ok(validateSnore('put', { began, ended, marks: { ...marks, b64: 'not base64!' } }));
  assert.ok(validateSnore('put', { began, ended, marks: { ...marks, b64: 'A'.repeat(SNORE_LIMITS.marksB64 + 4) } }));
  assert.ok(validateSnore('pair-join', { code: '12345' }));
  assert.ok(validateSnore('pair-join', { code: 'abcdef' }));
  assert.ok(validateSnore('get', { from: 'yesterday', to: ended }));
  assert.ok(validateSnore('drop-table', {}));
});

test('snore: /api/snore reaches quota with op=snore, signed as /api/snore', () => {
  const v = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url)));
  assert.ok(v.rewrites.some(r => r.source === '/api/snore' && r.destination === '/api/quota?op=snore'));
  const s = readFileSync(new URL('../api/_snore.js', import.meta.url), 'utf8');
  assert.match(s, /path: '\/api\/snore'/);
  assert.match(s, /allowLegacy: false/);
  assert.equal(Object.keys(v.functions).length <= 12, true, 'still within Hobby\'s twelve functions');
});

test('snore: every object is agni_ (covered by the lockdown) and nothing existing is altered', () => {
  const sql = readFileSync(new URL('../migrations/2026-11-26-snore-partners.sql', import.meta.url), 'utf8');
  const names = [...sql.matchAll(/create (?:or replace function|table if not exists|index if not exists) (\w+)/g)].map(m => m[1]);
  assert.ok(names.length >= 9);
  for (const n of names) assert.match(n, /^agni_snore_/);
  assert.doesNotMatch(sql, /\b(drop|alter function|truncate)\b/i);
  assert.match(sql, /enable row level security/);
  assert.match(sql, /interval '7 days'/);
});
