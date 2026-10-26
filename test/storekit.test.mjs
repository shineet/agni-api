// StoreKit 2 / App Store Server Notification verification.
//
// Verification is Apple's App Store Server Library (SignedDataVerifier).
// These tests sign with a stand-in chain shaped like Apple's
// (test/fixtures/storekit, regenerate with test/make-storekit-fixture.sh) and
// prove the checks around it: the chain, the marker extensions, the
// environment split, the app identity, and the notification bookkeeping.
//
//   node --test test/storekit.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sign, X509Certificate } from 'node:crypto';
import path from 'node:path';
import {
  verifyAppStoreJWS, transactionState, handleNotification, subjectFor, acceptedEnvironment
} from '../api/_storekit.js';
import { encodeOID } from '../api/_attest.js';

process.env.APP_APPLE_ID = '6700000000';
process.env.ALLOW_SANDBOX_TRANSACTIONS = 'true';

const dir = path.join(import.meta.dirname, 'fixtures/storekit');
const read = name => readFileSync(path.join(dir, name), 'utf8');
const der = pem => new X509Certificate(pem).raw.toString('base64');
const root = new X509Certificate(read('root.pem'));
const chain = [der(read('leaf.pem')), der(read('intermediate.pem')), der(read('root.pem'))];
const b64url = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function jws(payload, { x5c = chain, key = read('leaf.key'), alg = 'ES256', tamper = false } = {}) {
  const header = b64url(JSON.stringify({ alg, x5c }));
  const body = b64url(JSON.stringify(payload));
  const signature = sign('sha256', Buffer.from(`${header}.${body}`), { key, dsaEncoding: 'ieee-p1363' });
  const out = `${header}.${body}.${b64url(signature)}`;
  return tamper ? `${header}.${b64url(JSON.stringify({ ...payload, expiresDate: 4102444800000 }))}.${b64url(signature)}` : out;
}

const now = Date.now();
const transaction = (over = {}) => ({
  transactionId: '2000000000000001', originalTransactionId: '2000000000000000',
  bundleId: 'com.shinethankappan.agni', productId: 'com.shinethankappan.agni.pro.annual',
  purchaseDate: now - 86400_000, originalPurchaseDate: now - 86400_000, expiresDate: now + 364 * 86400_000,
  type: 'Auto-Renewable Subscription', environment: 'Production', signedDate: now, price: 59990, ...over
});
const notification = (over = {}, data = {}) => ({
  notificationType: 'DID_RENEW', notificationUUID: 'n-' + Math.random(), signedDate: now, version: '2.0',
  data: { bundleId: 'com.shinethankappan.agni', appAppleId: 6700000000, environment: 'Production', ...data },
  ...over
});

test('the production root is Apple Root CA - G3, pinned by fingerprint', () => {
  const shipped = new X509Certificate(readFileSync(path.join(import.meta.dirname, '../apple-root-ca-g3.pem'), 'utf8'));
  assert.equal(shipped.fingerprint256,
    '63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79');
  assert.match(shipped.subject, /Apple Root CA - G3/);
});

test('a correctly signed Production transaction verifies', async () => {
  const payload = await verifyAppStoreJWS(jws(transaction()), { root });
  assert.equal(payload.originalTransactionId, '2000000000000000');
});

test('a chain that does not lead to the trusted root is refused (the real Apple root here)', async () => {
  const apple = new X509Certificate(readFileSync(path.join(import.meta.dirname, '../apple-root-ca-g3.pem'), 'utf8'));
  await assert.rejects(verifyAppStoreJWS(jws(transaction()), { root: apple }), /verification failed/);
});

test('a tampered payload is refused', async () => {
  await assert.rejects(verifyAppStoreJWS(jws(transaction(), { tamper: true }), { root }), /verification failed/);
});

test('a leaf without the App Store marker extension is refused, even correctly chained', async () => {
  const x5c = [der(read('plainleaf.pem')), chain[1], chain[2]];
  await assert.rejects(verifyAppStoreJWS(jws(transaction(), { x5c, key: read('plainleaf.key') }), { root }),
    /verification failed/);
});

test('THE OLD HOLE: marker bytes planted inside another extension are refused', async () => {
  const planted = new X509Certificate(read('plantedleaf.pem'));
  // The verifier this replaced searched the raw certificate for these bytes,
  // and would have found them:
  assert.ok(planted.raw.includes(encodeOID('1.2.840.113635.100.6.11.1')), 'the bytes are there');
  // Apple's verifier reads the extensions themselves, and refuses it:
  const x5c = [der(read('plantedleaf.pem')), chain[1], chain[2]];
  await assert.rejects(verifyAppStoreJWS(jws(transaction(), { x5c, key: read('plantedleaf.key') }), { root }),
    /verification failed/);
});

test('a leaf signing for itself with the intermediate missing is refused', async () => {
  await assert.rejects(verifyAppStoreJWS(jws(transaction(), { x5c: [chain[0], chain[0], chain[2]] }), { root }));
});

test('alg none, a short chain or a non-JWS is refused', async () => {
  await assert.rejects(verifyAppStoreJWS(jws(transaction(), { alg: 'none' }), { root }));
  await assert.rejects(verifyAppStoreJWS(jws(transaction(), { x5c: chain.slice(0, 2) }), { root }), /verification failed/);
  await assert.rejects(verifyAppStoreJWS('a.b', { root }), /not a JWS/);
});

test('certificates outside their validity at the signing date are refused', async () => {
  await assert.rejects(verifyAppStoreJWS(jws(transaction({ signedDate: Date.parse('2099-01-01') })), { root }),
    /verification failed/);
});

// MARK: - Environments

test('Sandbox verifies against the Sandbox verifier; Xcode and local testing never verify', async () => {
  const sandbox = await verifyAppStoreJWS(jws(transaction({ environment: 'Sandbox' })), { root });
  assert.equal(sandbox.environment, 'Sandbox');
  await assert.rejects(verifyAppStoreJWS(jws(transaction({ environment: 'Xcode' })), { root }), /not accepted/);
  await assert.rejects(verifyAppStoreJWS(jws(transaction({ environment: 'LocalTesting' })), { root }), /not accepted/);
  assert.equal(acceptedEnvironment('Xcode'), false);
});

test('Sandbox can be switched off in an emergency; Production cannot be', async () => {
  process.env.ALLOW_SANDBOX_TRANSACTIONS = 'false';
  try {
    await assert.rejects(verifyAppStoreJWS(jws(transaction({ environment: 'Sandbox' })), { root }), /switched off/);
    assert.ok(await verifyAppStoreJWS(jws(transaction()), { root }));
  } finally {
    process.env.ALLOW_SANDBOX_TRANSACTIONS = 'true';
  }
});

test('Production data is refused outright when APP_APPLE_ID is not configured', async () => {
  delete process.env.APP_APPLE_ID;
  try {
    await assert.rejects(verifyAppStoreJWS(jws(transaction({ environment: 'Production', transactionId: 'x1' })),
      { root, bundleId: 'com.shinethankappan.agni' }), /APP_APPLE_ID/);
  } finally {
    process.env.APP_APPLE_ID = '6700000000';
  }
});

test('a transaction for another app is refused by the verifier itself', async () => {
  await assert.rejects(verifyAppStoreJWS(jws(transaction({ bundleId: 'com.evil.app' })), { root }), /verification failed/);
});

test('Production and Sandbox subjects never coincide', () => {
  assert.equal(subjectFor('Production', '42'), 'sub:42');
  assert.equal(subjectFor('Sandbox', '42'), 'sbx:42');
  assert.equal(transactionState(transaction({ environment: 'Sandbox' })).subject_id, 'sbx:2000000000000000');
  assert.equal(transactionState(transaction()).subject_id, 'sub:2000000000000000');
});

// MARK: - Transaction state

test('transaction state: trial, paid, refund, wrong app, unknown product, superseded', () => {
  const trial = transactionState(transaction({ offerType: 1, offerDiscountType: 'FREE_TRIAL', price: 0 }));
  assert.equal(trial.is_trial, true);
  assert.equal(transactionState(transaction({ offerType: 1, price: 0 })).is_trial, true, 'older payloads');
  assert.equal(transactionState(transaction({ offerType: 1, offerDiscountType: 'PAY_AS_YOU_GO', price: 1990 })).is_trial,
    false, 'a paid introductory price is not a free trial');
  assert.ok(transactionState(transaction({ revocationDate: now, revocationReason: 0 })).revocation_date);
  assert.equal(transactionState(transaction({ bundleId: 'com.evil.app' })).error, 'wrong_bundle');
  assert.equal(transactionState(transaction({ productId: 'com.shinethankappan.agni.tip' })).error, 'unknown_product');
  assert.equal(transactionState(transaction({ type: 'Consumable' })).error, 'not_a_subscription');
  assert.equal(transactionState(transaction({ isUpgraded: true })).error, 'upgraded');
  assert.equal(transactionState(transaction({ environment: 'Xcode' })).error, 'environment');
  const grace = transactionState(transaction(), { gracePeriodExpiresDate: now + 16 * 86400_000, autoRenewStatus: 1 });
  assert.ok(grace.grace_expires_date);
  assert.equal(grace.auto_renew, true);
});

// MARK: - Notifications

function fakeRPC({ failUpserts = 0 } = {}) {
  const seen = new Set();
  const writes = [];
  let failures = failUpserts;
  const rpc = async (fn, args) => {
    if (fn === 'agni_store_notification_known') return seen.has(args.p_uuid);
    if (fn === 'agni_store_notification_seen') { seen.add(args.p_uuid); return true; }
    if (fn === 'agni_subscription_upsert') {
      if (failures > 0) { failures -= 1; throw new Error('database blip'); }
      writes.push(args);
      return [{ applied: true }];
    }
    throw new Error(fn);
  };
  return { rpc, writes, seen };
}

test('notifications: verified, applied once, a redelivery ignored, a TEST ignored', async () => {
  const { rpc, writes } = fakeRPC();
  const signedTransactionInfo = jws(transaction({ revocationDate: now, revocationReason: 1 }));
  const refund = jws(notification({ notificationType: 'REFUND', notificationUUID: 'n-1' }, { signedTransactionInfo }));
  assert.equal((await handleNotification(rpc, refund, { root })).applied, true);
  assert.ok(writes[0].p_revocation_date, 'the refund is written');
  assert.equal((await handleNotification(rpc, refund, { root })).reason, 'redelivery');
  assert.equal(writes.length, 1);
  const testType = await handleNotification(rpc, jws(notification({ notificationType: 'TEST', notificationUUID: 't' })), { root });
  assert.equal(testType.reason, 'test');
});

test('a notification whose write failed is applied when Apple retries it', async () => {
  const { rpc, writes, seen } = fakeRPC({ failUpserts: 1 });
  const signed = jws(notification({ notificationUUID: 'n-retry' }, { signedTransactionInfo: jws(transaction()) }));
  await assert.rejects(handleNotification(rpc, signed, { root }), /blip/);
  assert.equal(seen.has('n-retry'), false, 'not recorded, so the retry is not ignored');
  assert.equal((await handleNotification(rpc, signed, { root })).applied, true);
  assert.equal(writes.length, 1);
});

test('a notification for another App Apple ID is refused', async () => {
  const signed = jws(notification({}, { appAppleId: 1111, signedTransactionInfo: jws(transaction()) }));
  await assert.rejects(handleNotification(fakeRPC().rpc, signed, { root }), /verification failed/);
});

test('a Production notification wrapping a Sandbox transaction is refused', async () => {
  const signed = jws(notification({}, { signedTransactionInfo: jws(transaction({ environment: 'Sandbox' })) }));
  await assert.rejects(handleNotification(fakeRPC().rpc, signed, { root }), /verification failed/);
});

test('a Sandbox notification lands on a Sandbox subject', async () => {
  const { rpc, writes } = fakeRPC();
  const signed = jws(notification({}, { environment: 'Sandbox', appAppleId: undefined,
    signedTransactionInfo: jws(transaction({ environment: 'Sandbox' })) }));
  const result = await handleNotification(rpc, signed, { root });
  assert.equal(result.environment, 'Sandbox');
  assert.equal(writes[0].p_environment, 'Sandbox');
});

test('a notification wrapping a transaction signed by someone else is refused', async () => {
  const forged = jws(transaction(), { x5c: [der(read('plainleaf.pem')), chain[1], chain[2]], key: read('plainleaf.key') });
  const signed = jws(notification({ notificationUUID: 'n-2' }, { signedTransactionInfo: forged }));
  await assert.rejects(handleNotification(fakeRPC().rpc, signed, { root }), /verification failed/);
});
