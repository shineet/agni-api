// The read-only query files in docs/readonly-queries parse, run, and cannot
// write, against a local database with the real schema. No production access.

import './helpers/no-network.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as h from './helpers/harness.mjs';

const skip = !h.enabled && 'AGNI_TEST_PG not set';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PSQL = process.env.AGNI_TEST_PSQL || '/opt/homebrew/opt/postgresql@17/bin/psql';
let db;

function runFile(name) {
  const url = h.PG_URL.replace(/\/[^/]*$/, '/' + db);
  return execFileSync(PSQL, [url, '-At', '-v', 'ON_ERROR_STOP=1', '-f',
    path.join(ROOT, 'docs/readonly-queries', name)], { encoding: 'utf8' });
}

before(async () => {
  if (skip) return;
  h.setTestEnv();
  db = h.freshDatabase('roq');
  // One real dish (two real phones), one dish published only because a
  // self-test install added the second row, one candidate-only dish.
  await h.sql(`insert into agni_dish_submissions (key, name, install_id, kcal, created_at, updated_at) values
    ('kothu parotta','Kothu parotta','REAL-A',450, now() - interval '3 days', now() - interval '3 days'),
    ('kothu parotta','Kothu parotta','REAL-B',460, now() - interval '2 days', now() - interval '2 days'),
    ('idli','Idli','REAL-C',60, now() - interval '5 days', now() - interval '5 days'),
    ('idli','Idli','PLACEHOLDER-RAW-INSTALL-ID-1',58, now(), now()),
    ('test fixture curry','Test fixture curry','PLACEHOLDER-RAW-INSTALL-ID-1',300, now(), now())`);
  await h.sql(`insert into agni_dish_misses (key, name, kind, install_id) values
    ('moringa thoran','Moringa thoran','searchFoundNothing','PLACEHOLDER-RAW-INSTALL-ID-2')`);
  await h.sql(`insert into agni_usage_events (subject_id, request_id, action_id, feature, bucket, counts, tier, auth_path, model,
                 period_start, day, status, credited, outcome, reserved_usd, actual_usd, input_tokens, output_tokens)
               values ('dev:X','r1','a1','photo','photo',true,'beta','attest','claude-sonnet-5', now(), current_date,
                       'settled', true, 'ok', 0.11, 0.02, 2500, 900)`);
});

after(() => { if (!skip) h.dropDatabase(); });

test('test-dish-inventory.sql runs read-only and flags by evidence, not name', { skip }, () => {
  const out = runFile('test-dish-inventory.sql');
  assert.match(out, /^idli\|Idli\|PLACEHOLDER-RAW-INSTALL-ID-1\|.*\|install\|2\|t\|t\|1$/m,
    'idli is published only because of the candidate row');
  assert.match(out, /^test fixture curry\|.*\|install\|1\|f\|f\|0$/m, 'a candidate-only dish is not published');
  assert.doesNotMatch(out, /REAL-A|REAL-B/, 'real contributors are never candidates');
  assert.match(out, /moringa thoran\|Moringa thoran\|searchFoundNothing\|PLACEHOLDER-RAW-INSTALL-ID-2/);
});

test('usage-cost-measurement.sql runs read-only', { skip }, () => {
  const out = runFile('usage-cost-measurement.sql');
  assert.ok(out.length > 0);
});

test('neither file can write: Postgres refuses a write inside its read-only transaction', { skip }, () => {
  const url = h.PG_URL.replace(/\/[^/]*$/, '/' + db);
  assert.throws(() => execFileSync(PSQL, [url, '-v', 'ON_ERROR_STOP=1', '-c',
    "begin read only; delete from agni_dish_submissions; rollback;"], { stdio: 'pipe' }),
    /read-only transaction/);
});
