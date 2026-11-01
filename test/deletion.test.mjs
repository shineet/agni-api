// Server-data deletion: who may delete what, what is kept, and that nothing
// the allowance, the Free sample or a purchase depends on is lost.
//
//   AGNI_TEST_PG=postgresql://postgres@127.0.0.1:55432/postgres node --test test/deletion.test.mjs

import './helpers/no-network.mjs';
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sign, X509Certificate, randomBytes } from 'node:crypto';
import path from 'node:path';
import * as h from './helpers/harness.mjs';
import { supportId, contributorId } from '../api/_lib.js';

const skip = !h.enabled && 'AGNI_TEST_PG not set';
let quotaHandler, estimateHandler;

// MARK: - Apple-signed transactions, from the test chain (see storekit.test.mjs)

const dir = path.join(import.meta.dirname, 'fixtures/storekit');
const read = name => readFileSync(path.join(dir, name), 'utf8');
const der = pem => new X509Certificate(pem).raw.toString('base64');
const chain = [der(read('leaf.pem')), der(read('intermediate.pem')), der(read('root.pem'))];
const b64url = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function jws(payload, { tamper = false } = {}) {
  const header = b64url(JSON.stringify({ alg: 'ES256', x5c: chain }));
  const body = b64url(JSON.stringify(payload));
  const signature = sign('sha256', Buffer.from(`${header}.${body}`), { key: read('leaf.key'), dsaEncoding: 'ieee-p1363' });
  return tamper ? `${header}.${b64url(JSON.stringify({ ...payload, originalTransactionId: 'X' }))}.${b64url(signature)}`
                : `${header}.${body}.${b64url(signature)}`;
}
function transaction(otid, over = {}) {
  const now = Date.now();
  return {
    transactionId: 'T' + otid, originalTransactionId: otid, bundleId: 'com.shinethankappan.agni',
    productId: 'com.shinethankappan.agni.pro.monthly', purchaseDate: now - 86400_000,
    originalPurchaseDate: now - 86400_000, expiresDate: now + 29 * 86400_000,
    type: 'Auto-Renewable Subscription', environment: 'Production', signedDate: now, price: 9990,
    inAppOwnershipType: 'PURCHASED', ...over
  };
}

// MARK: - Setup

before(async () => {
  if (skip) return;
  h.setTestEnv({ IP_HASH_SALT: 'test-salt-for-contributors' });
  h.freshDatabase('deletion');
  h.installFetch();
  quotaHandler = (await import('../api/quota.js')).default;
  estimateHandler = (await import('../api/estimate.js')).default;
});
after(() => { if (skip) return; h.restoreFetch(); h.dropDatabase(); });
beforeEach(() => { if (skip) return; h.anthropic.reset(); h.setTestEnv({ IP_HASH_SALT: 'test-salt-for-contributors' }); });

const q = s => `'${String(s).replace(/'/g, "''")}'`;

async function linked() {
  const dev = await h.device();
  const res = await h.attestedGet(quotaHandler, dev, '/api/quota', { installId: dev.installId });
  assert.equal(res.statusCode, 200, res.body);
  return dev;
}

function del(dev, body = {}) {
  return h.attestedPost(quotaHandler, dev, '/api/quota',
    { installId: dev.installId, scope: 'device', requestId: randomBytes(8).toString('hex'), ...body },
    { op: 'delete-data' });
}

async function photo(dev) {
  return h.estimate(estimateHandler, dev, {
    feature: 'photo', actionId: 'act-' + randomBytes(6).toString('hex'), requestId: 'req-' + randomBytes(6).toString('hex'),
    request: h.modelRequest({ image: h.PHOTO_B64 })
  });
}

async function usageRow(subject, device, { status = 'settled', days = 0, request = 'r-' + randomBytes(6).toString('hex') } = {}) {
  await h.sql(`insert into agni_usage_events (subject_id, request_id, feature, bucket, tier, auth_path, model,
                 period_start, day, reserved_usd, status, created_at, device_subject)
               values (${q(subject)}, ${q(request)}, 'photo', 'photo', 'pro', 'attest', 'm',
                 now() - interval '${days} days', (now() - interval '${days} days')::date, 0.01, ${q(status)},
                 now() - interval '${days} days', ${device === null ? 'NULL' : q(device)})`);
}

const count = async (where) => Number(await h.sql(`select count(*) from agni_usage_events where ${where}`));

// MARK: - Attribution

test('a Pro estimate records which device made it on the subscription usage row', { skip }, async () => {
  const dev = await linked();
  const subject = await h.subscribe(dev, { purchase: h.daysFromNow(-1), expires: h.daysFromNow(29) });
  const res = await photo(dev);
  assert.equal(res.statusCode, 200, res.body);
  const [row] = await h.sqlJSON(`select subject_id, device_subject from agni_usage_events where subject_id = ${q(subject)}`);
  assert.deepEqual(row, { subject_id: subject, device_subject: 'dev:' + dev.installId });
  const [action] = await h.sqlJSON(`select device_subject from agni_actions where subject_id = ${q(subject)}`);
  assert.equal(action.device_subject, 'dev:' + dev.installId);
});

// MARK: - Ownership

test('the shared token cannot delete anything', { skip }, async () => {
  const res = await h.call(quotaHandler, { method: 'POST', query: { op: 'delete-data' },
    headers: { authorization: 'Bearer legacy-token' }, body: JSON.stringify({ installId: 'INSTALL-xxxxxxxx', scope: 'device' }) });
  assert.equal(res.statusCode, 401);
});

test('a phone naming another phone\'s install id is refused, and nothing is deleted', { skip }, async () => {
  const a = await linked();
  const b = await linked();
  await usageRow('dev:' + a.installId, null);
  const res = await h.attestedPost(quotaHandler, b, '/api/quota',
    { installId: a.installId, scope: 'device', requestId: 'r1' }, { op: 'delete-data' });
  assert.equal(res.statusCode, 403, res.body);
  assert.match(res.json.message, /only delete its own/);
  assert.equal(await count(`subject_id = ${q('dev:' + a.installId)}`), 1);
});

test('a key never seen before (no link) is refused', { skip }, async () => {
  const fresh = await h.device();
  const res = await del(fresh);
  assert.equal(res.statusCode, 403, res.body);
});

test('a Support ID is never a target: sending another phone\'s Support ID deletes only the signer\'s own rows', { skip }, async () => {
  const a = await linked();
  const b = await linked();
  await usageRow('dev:' + a.installId, null);
  await usageRow('dev:' + b.installId, null);
  const res = await del(b, { supportId: supportId(a.installId), target: 'dev:' + a.installId });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json.deleted.usage_events, 1);
  assert.equal(await count(`subject_id = ${q('dev:' + a.installId)}`), 1, 'A untouched');
  assert.equal(await count(`subject_id = ${q('dev:' + b.installId)}`), 0);
});

// MARK: - Device scope on a shared subscription

test('two devices on one subscription: A\'s deletion leaves B\'s rows and every unattributed row', { skip }, async () => {
  const a = await linked();
  const b = await linked();
  const otid = 'OT' + randomBytes(5).toString('hex');
  const subject = await h.subscribe(a, { otid, purchase: h.daysFromNow(-40), expires: h.daysFromNow(20) });
  await h.subscribe(b, { otid, purchase: h.daysFromNow(-40), expires: h.daysFromNow(20) });
  const devA = 'dev:' + a.installId, devB = 'dev:' + b.installId;

  await usageRow(subject, devA, { days: 40 });
  await usageRow(subject, devA, { days: 2 });
  await usageRow(subject, devB, { days: 2 });
  await usageRow(subject, null, { days: 50 });           // before attribution existed
  await usageRow(devA, null, { days: 60 });              // A's Free-period history
  await h.sql(`insert into agni_allowance_periods (subject_id, period_start, period_end, tier, photo_used)
               values (${q(subject)}, now() - interval '10 days', now() + interval '20 days', 'pro', 7),
                      (${q(subject)}, now() - interval '40 days', now() - interval '10 days', 'pro', 30)`);
  await h.sql(`insert into agni_dish_submissions (key, name, install_id, unit, kcal)
               values ('kheer', 'Kheer', ${q(contributorId(a.installId))}, 'serving', 200),
                      ('kheer', 'Kheer', ${q(a.installId)}, 'serving', 200),
                      ('kheer', 'Kheer', ${q(contributorId(b.installId))}, 'serving', 210)`);

  const res = await del(a);
  assert.equal(res.statusCode, 200, res.body);
  const { deleted, kept, scope } = res.json;
  assert.equal(scope, 'device');
  assert.equal(deleted.subscription_usage_events_from_this_phone, 2);
  assert.equal(deleted.usage_events, 1);
  assert.equal(deleted.dish_contributions, 2, 'both the raw-id row and the hashed row of A');
  assert.equal(await count(`subject_id = ${q(subject)} and device_subject = ${q(devB)}`), 1, 'B untouched');
  assert.equal(await count(`subject_id = ${q(subject)} and device_subject is null`), 1, 'unattributed kept');
  assert.equal(await h.sql(`select count(*) from agni_dish_submissions where install_id = ${q(contributorId(b.installId))}`), '1');
  const keptBy = Object.fromEntries(kept.map(k => [k.category, k]));
  assert.equal(keptBy.subscription_history_unattributed.count, 1);
  assert.equal(keptBy.subscription_history_other_devices.count, 1);
  assert.ok(keptBy.current_allowance_counters.count >= 1);
  assert.ok(kept.every(k => typeof k.reason === 'string' && k.reason.length > 20), 'every kept category says why');
  assert.equal(await h.sql(`select photo_used from agni_allowance_periods where subject_id = ${q(subject)} and period_end > now()`), '7',
               'the current period counter is untouched (device scope never deletes subscription counters)');
  assert.equal(await h.sql(`select subscription_subject from agni_key_links where key_id = ${q(b.keyId)}`), subject);
  assert.equal(await h.sql(`select subscription_subject from agni_key_links where key_id = ${q(a.keyId)}`), subject,
               'A keeps Pro: its link is not removed');
});

test('the current allowance is not reset: the next status shows the same counts used', { skip }, async () => {
  const dev = await linked();
  await h.subscribe(dev, { purchase: h.daysFromNow(-1), expires: h.daysFromNow(29) });
  assert.equal((await photo(dev)).statusCode, 200);
  assert.equal((await photo(dev)).statusCode, 200);
  const before = (await h.attestedGet(quotaHandler, dev, '/api/quota', { installId: dev.installId })).json.allowance;
  const res = await del(dev);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json.deleted.subscription_usage_events_from_this_phone, 2);
  const afterStatus = (await h.attestedGet(quotaHandler, dev, '/api/quota', { installId: dev.installId })).json.allowance;
  assert.equal(afterStatus.buckets.photo.used, before.buckets.photo.used);
  assert.equal(afterStatus.buckets.photo.used, 2);
  assert.equal(afterStatus.photosToday, before.photosToday, 'the daily photo limit is not reset either');
  assert.equal(afterStatus.tier, 'pro');
});

test('the Free-sample markers survive, so a deletion cannot hand out another sample', { skip }, async () => {
  const dev = await linked();
  await h.sql(`update agni_subjects set free_photo_exhausted = true, free_search_exhausted = true
                where subject_id = ${q('dev:' + dev.installId)}`);
  const res = await del(dev);
  assert.equal(res.statusCode, 200, res.body);
  const [s] = await h.sqlJSON(`select free_photo_exhausted, free_search_exhausted from agni_subjects
                                where subject_id = ${q('dev:' + dev.installId)}`);
  assert.deepEqual(s, { free_photo_exhausted: true, free_search_exhausted: true });
  assert.equal(res.json.kept.find(k => k.category === 'free_sample_used_marker').count, 1);
  const status = (await h.attestedGet(quotaHandler, dev, '/api/quota', { installId: dev.installId })).json.allowance;
  assert.equal(status.tier, 'free');
  assert.equal(status.buckets.photo.remaining, 0, 'the sample stays closed');
});

test('an open reservation blocks the deletion with 409 and nothing is deleted', { skip }, async () => {
  const dev = await linked();
  const devSubject = 'dev:' + dev.installId;
  await usageRow(devSubject, null, { days: 3 });
  await usageRow(devSubject, devSubject, { status: 'reserved' });
  const res = await del(dev);
  assert.equal(res.statusCode, 409, res.body);
  assert.match(res.json.message, /still being processed/);
  assert.equal(await count(`subject_id = ${q(devSubject)}`), 2);
});

test('running it twice deletes nothing the second time, and the alert holds counts only', { skip }, async () => {
  const dev = await linked();
  await usageRow('dev:' + dev.installId, null, { days: 5 });
  const first = await del(dev);
  assert.equal(first.json.deleted.usage_events, 1);
  const second = await del(dev);
  assert.equal(second.statusCode, 200);
  assert.ok(Object.values(second.json.deleted).every(n => n === 0), JSON.stringify(second.json.deleted));
  const alerts = await h.sql(`select string_agg(detail::text, ' ') from agni_alerts where kind = 'deletion'`);
  assert.ok(!alerts.includes(dev.installId) && !alerts.includes(dev.keyId), 'no identifier in the deletion log');
});

test('three deletion requests a day per key, then 429', { skip }, async () => {
  const dev = await linked();
  for (let i = 0; i < 3; i++) assert.equal((await del(dev)).statusCode, 200);
  const res = await del(dev);
  assert.equal(res.statusCode, 429, res.body);
  assert.match(res.json.message, /limit/);
});

// MARK: - Subscription scope (purchaser only)

async function sharedSubscription() {
  const a = await linked();
  const b = await linked();
  const otid = String(2000000000000000 + Math.floor(Math.random() * 1e9));
  const subject = await h.subscribe(a, { otid, purchase: h.daysFromNow(-40), expires: h.daysFromNow(20) });
  await h.subscribe(b, { otid, purchase: h.daysFromNow(-40), expires: h.daysFromNow(20) });
  await usageRow(subject, 'dev:' + a.installId, { days: 2 });
  await usageRow(subject, 'dev:' + b.installId, { days: 2 });
  await usageRow(subject, null, { days: 50 });
  await h.sql(`insert into agni_allowance_periods (subject_id, period_start, period_end, tier, photo_used)
               values (${q(subject)}, now() - interval '10 days', now() + interval '20 days', 'pro', 4),
                      (${q(subject)}, now() - interval '40 days', now() - interval '10 days', 'pro', 30)`);
  await h.sql(`insert into agni_store_notifications (notification_uuid, notification_type, original_transaction_id)
               values (${q('n-' + otid)}, 'DID_RENEW', ${q(otid)})`);
  return { a, b, otid, subject };
}

test('the subscription scope needs a verified Apple transaction', { skip }, async () => {
  const { a, subject } = await sharedSubscription();
  for (const signedTransaction of [undefined, 'a.b.c', jws(transaction('2000000000000999'), { tamper: true })]) {
    const res = await del(a, { scope: 'subscription', signedTransaction });
    assert.equal(res.statusCode, 403, res.body);
  }
  assert.equal(await count(`subject_id = ${q(subject)}`), 3, 'nothing deleted');
});

test('a transaction for a different subscription is refused', { skip }, async () => {
  const { a, subject } = await sharedSubscription();
  const res = await del(a, { scope: 'subscription', signedTransaction: jws(transaction('2999999999999999')) });
  assert.equal(res.statusCode, 403, res.body);
  assert.match(res.json.message, /not the subscription this phone uses/);
  assert.equal(await count(`subject_id = ${q(subject)}`), 3);
});

test('a Family Sharing member cannot delete the purchaser\'s history (but can delete their own phone\'s)', { skip }, async () => {
  const { b, otid, subject } = await sharedSubscription();
  const res = await del(b, { scope: 'subscription',
    signedTransaction: jws(transaction(otid, { inAppOwnershipType: 'FAMILY_SHARED' })) });
  assert.equal(res.statusCode, 403, res.body);
  assert.match(res.json.message, /Only the person who bought/);
  assert.equal(await count(`subject_id = ${q(subject)}`), 3);
  const own = await del(b);
  assert.equal(own.statusCode, 200);
  assert.equal(own.json.deleted.subscription_usage_events_from_this_phone, 1);
});

test('the purchaser deletes every device\'s settled history, attributed or not; counters, links and the purchase stay', { skip }, async () => {
  const { a, b, otid, subject } = await sharedSubscription();
  const res = await del(a, { scope: 'subscription', signedTransaction: jws(transaction(otid)) });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json.scope, 'subscription');
  assert.equal(await count(`subject_id = ${q(subject)}`), 0, 'A, B and unattributed history all gone');
  assert.equal(res.json.deleted.subscription_past_allowance_periods, 1);
  assert.equal(await h.sql(`select photo_used from agni_allowance_periods where subject_id = ${q(subject)}`), '4',
               'only the current period remains, with its count');
  assert.equal(await h.sql(`select subscription_subject from agni_key_links where key_id = ${q(b.keyId)}`), subject,
               'the other device keeps Pro');
  assert.equal(await h.sql(`select count(*) from agni_subjects where subject_id = ${q(subject)}`), '1');
  assert.equal(await h.sql(`select count(*) from agni_store_notifications where original_transaction_id = ${q(otid)}`), '1');
  const keptBy = Object.fromEntries(res.json.kept.map(k => [k.category, k.count]));
  assert.equal(keptBy.other_devices_links, 1);
  assert.equal(keptBy.app_store_notices, 1);
  assert.equal(keptBy.subscription_purchase_record, 1);
});

test('restoring the purchase still works after the purchaser\'s deletion', { skip }, async () => {
  const { a, otid } = await sharedSubscription();
  assert.equal((await del(a, { scope: 'subscription', signedTransaction: jws(transaction(otid)) })).statusCode, 200);
  const restore = await h.attestedPost(quotaHandler, a, '/api/quota',
    { installId: a.installId, transactions: [jws(transaction(otid))] }, { op: 'sync' });
  assert.equal(restore.statusCode, 200, restore.body);
  assert.equal(restore.json.allowance.tier, 'pro');
});

test('the deletion functions are callable by the service role alone', { skip }, async () => {
  for (const sig of ['agni_delete_device_data(text, text[], text)', 'agni_delete_subscription_history(text, text, text[])']) {
    const exposed = await h.sql(`select has_function_privilege('anon', '${sig}', 'execute')
                                     or has_function_privilege('authenticated', '${sig}', 'execute')`);
    assert.equal(exposed, 'f', sig);
  }
});
